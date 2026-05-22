// JVM controller — spawns real Paper/Vanilla Minecraft servers as child processes.
// Runs INSIDE this Node container (no Docker needed). Each server gets a working dir
// under DATA_DIR/<id>/ and a `java -jar server.jar nogui` process.
//
// Constraints:
//   - Railway service exposes ONE public TCP port (MC_PORT, default 25565).
//     So at most ONE server can be publicly reachable at a time.
//     The "active" server gets MC_PORT; others run on internal ports for testing.
//   - Free Railway tier has limited RAM. We cap heap aggressively.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
const PUBLIC_PORT = parseInt(process.env.MC_PORT || '25565', 10);
// Cap heap to stay under Railway's container memory. Paper 1.21+ needs ~500MB
// during DataFixers static init or it throws OutOfMemoryError. 480 is the
// sweet spot for free tier (leaves ~64MB for the Node parent + JVM overhead).
// Heap cap per server. Was 2456 (2.4GB heap from a 3GB plan) but combined
// with Aikar's +AlwaysPreTouch that forced 2.4GB to be allocated upfront on
// every server boot — so 2 servers = 5GB, more than the Railway container's
// memory limit, and the new JVM got OOM-killed silently (no logs survive).
// Drop to 1024 MB heap so 3-4 small servers can coexist on the same container.
// Override via MAX_HEAP_MB env per-deploy if heavier mod-packs need it.
const MAX_HEAP_MB = parseInt(process.env.MAX_HEAP_MB || '1024', 10);
const INTERNAL_PORT_BASE = 26000;
const LOG_RING_SIZE = 1000;

const PAPER_API = process.env.PAPER_API || 'https://api.papermc.io/v2';
const MOJANG_MANIFEST = process.env.MOJANG_MANIFEST || 'https://launchermeta.mojang.com/mc/game/version_manifest.json';

fs.mkdirSync(DATA_DIR, { recursive: true });

// id → { proc, logs: ring buffer, ready, listeners: Set<fn>, exitCode, lastCpu, slp: {data, ts}, intentional }
// Tracks unexpected (non-intentional, non-OOM) crashes so the auto-restart loop
// in server.js can revive servers that died unexpectedly.
const crashes = new Map(); // id → { when, code, signal }
// Long-lived log listener sets keyed by server id. Survives state replacement
// (stop/start cycles) so WebSocket subscribers don't lose their stream when the
// JVM restarts. Each set holds (line:string)=>void callbacks.
const persistentListeners = new Map(); // id → Set<fn>
const running = new Map();
const SLP_CACHE_TTL = 5_000;

function isAvailable() {
  if (process.env.DISABLE_JVM === '1') return false;
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

function makeRconPassword() {
  return crypto.randomBytes(16).toString('hex');
}

function serverDir(id) {
  const d = path.join(DATA_DIR, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Decide host port for this server.
//   - If server.is_public is set, bind to MC_PORT (the Railway-exposed public port).
//   - Otherwise use an internal port derived from the DB-assigned `server.port`.
//   - If somebody else already holds MC_PORT, fall back to internal.
function pickHostPort(server) {
  const offset = Math.max(0, parseInt(server.port, 10) - 25565);
  const internal = INTERNAL_PORT_BASE + (offset % 1000);
  if (!server.is_public) return internal;
  for (const [, state] of running) {
    if (state.hostPort === PUBLIC_PORT) return internal;
  }
  return PUBLIC_PORT;
}

async function downloadFile(url, dest, label) {
  const res = await fetch(url, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  if (!res.ok) throw new Error(`${label} download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return buf.length;
}

// Resolve the URL to a Paper server JAR for a given MC version.
async function paperJarUrl(version) {
  const v = version && version !== 'LATEST' ? version : null;
  let mcVersion = v;
  if (!mcVersion) {
    const r = await fetch(`${PAPER_API}/projects/paper`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
    const data = await r.json();
    mcVersion = data.versions[data.versions.length - 1];
  }
  const buildsR = await fetch(`${PAPER_API}/projects/paper/versions/${mcVersion}`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  if (!buildsR.ok) throw new Error(`Paper version ${mcVersion} not found`);
  const buildsData = await buildsR.json();
  const build = buildsData.builds[buildsData.builds.length - 1];
  const detailR = await fetch(`${PAPER_API}/projects/paper/versions/${mcVersion}/builds/${build}`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  const detail = await detailR.json();
  const fileName = detail.downloads.application.name;
  return {
    url: `${PAPER_API}/projects/paper/versions/${mcVersion}/builds/${build}/downloads/${fileName}`,
    version: mcVersion,
    build,
  };
}

// Purpur server JAR via api.purpurmc.org. Endpoint pattern:
//   /v2/purpur                              → { versions: [...] }
//   /v2/purpur/<mcversion>                  → { builds: { all, latest } }
//   /v2/purpur/<mcversion>/<build>/download → JAR
async function purpurJarUrl(version) {
  const PURPUR_API = process.env.PURPUR_API || 'https://api.purpurmc.org/v2';
  let mcVersion = version && version !== 'LATEST' ? version : null;
  if (!mcVersion) {
    const r = await fetch(`${PURPUR_API}/purpur`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
    const m = await r.json();
    mcVersion = m.versions[m.versions.length - 1];
  }
  const r = await fetch(`${PURPUR_API}/purpur/${mcVersion}`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  if (!r.ok) throw new Error(`Purpur version ${mcVersion} not found`);
  const m = await r.json();
  const build = m.builds?.latest;
  if (!build) throw new Error(`No Purpur build for ${mcVersion}`);
  return { url: `${PURPUR_API}/purpur/${mcVersion}/${build}/download`, version: mcVersion, build };
}

// Fabric server JAR. Fabric uses a "fabric server launcher" JAR that takes the
// game version, loader version, and installer version. We pick the latest stable
// of loader+installer for the requested game version.
async function fabricJarUrl(version) {
  const FABRIC_META = process.env.FABRIC_META || 'https://meta.fabricmc.net/v2';
  let mcVersion = version && version !== 'LATEST' ? version : null;
  if (!mcVersion) {
    const r = await fetch(`${FABRIC_META}/versions/game`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
    const list = await r.json();
    mcVersion = (list.find(v => v.stable) || list[0]).version;
  }
  // Loader: latest stable
  const lr = await fetch(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  if (!lr.ok) throw new Error(`Fabric loaders for ${mcVersion} not found`);
  const loaders = await lr.json();
  const loaderVer = (loaders.find(l => l.loader?.stable) || loaders[0])?.loader?.version;
  if (!loaderVer) throw new Error(`No Fabric loader for ${mcVersion}`);
  // Installer: latest stable
  const ir = await fetch(`${FABRIC_META}/versions/installer`, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  const installers = await ir.json();
  const installerVer = (installers.find(i => i.stable) || installers[0]).version;
  return {
    url: `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVer)}/${encodeURIComponent(installerVer)}/server/jar`,
    version: mcVersion,
    loader: loaderVer,
    installer: installerVer,
  };
}

// NeoForge "installer" JAR. NeoForge ships an installer that must run once to
// extract the actual server launcher. We download the installer and let the
// init step run it (see ensureJar).
async function neoforgeJarUrl(version) {
  const MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
  // NeoForge versions look like "21.1.181" (matches MC 1.21.1). The user picks
  // a neoforge version directly from the versions endpoint.
  if (!version || version === 'LATEST') {
    const r = await fetch('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', { headers: { 'User-Agent': 'CraftHost/1.0' } });
    const m = await r.json();
    version = (m.versions || []).slice(-1)[0];
    if (!version) throw new Error('No NeoForge versions found');
  }
  return {
    url: `${MAVEN}/${version}/neoforge-${version}-installer.jar`,
    version,
    installer: true,
  };
}

// Vanilla server JAR via Mojang manifest
async function vanillaJarUrl(version) {
  const manifestR = await fetch(MOJANG_MANIFEST, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  const manifest = await manifestR.json();
  const target = version && version !== 'LATEST'
    ? manifest.versions.find(v => v.id === version)
    : manifest.versions.find(v => v.id === manifest.latest.release);
  if (!target) throw new Error(`Vanilla version ${version} not found`);
  const versionR = await fetch(target.url, { headers: { 'User-Agent': 'CraftHost/1.0' } });
  const v = await versionR.json();
  if (!v.downloads?.server?.url) throw new Error('No server download for this version');
  return { url: v.downloads.server.url, version: target.id };
}

// Global JAR cache. Instead of downloading server.jar fresh into every
// server's dir (~50 MB × N servers), download it ONCE per type+version into
// /data/.jar-cache/, then hardlink into each server's directory. Same on-disk
// blob shared across all servers running that type+version — saves bandwidth
// (no re-download), boot time (no wait), and disk (1 inode reuse, not N copies).
const JAR_CACHE_DIR = path.join(DATA_DIR, '..', '.jar-cache');

function cachedJarPath(type, version, info) {
  const safeType = String(type || 'paper').replace(/[^a-z0-9]/gi, '');
  const safeVer  = String(version || info.version || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '');
  return path.join(JAR_CACHE_DIR, `${safeType}-${safeVer}.jar`);
}

async function ensureJar(server) {
  const dir = serverDir(server.id);
  const jarPath = path.join(dir, 'server.jar');
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 100000) return jarPath;

  const t = (server.type || '').toLowerCase();
  let info;
  if (t === 'vanilla')        info = await vanillaJarUrl(server.version);
  else if (t === 'purpur')    info = await purpurJarUrl(server.version);
  else if (t === 'fabric')    info = await fabricJarUrl(server.version);
  else if (t === 'neoforge')  info = await neoforgeJarUrl(server.version);
  // paper/spigot fall back to Paper (Spigot needs BuildTools — Paper is a drop-in)
  else                        info = await paperJarUrl(server.version);

  // NeoForge is a per-server installer that mutates the directory — skip cache
  // for it. All other engines are a single self-contained launcher JAR that
  // can be safely hardlinked across servers.
  const cacheable = t !== 'neoforge';
  const cachePath = cachedJarPath(t || 'paper', server.version, info);
  if (cacheable) {
    try { fs.mkdirSync(JAR_CACHE_DIR, { recursive: true }); } catch {}
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100000) {
      // ── CACHE HIT — hardlink from the shared cache into this server's dir.
      // Hardlink keeps a single on-disk blob; deleting either path doesn't
      // affect the other. Falls back to a regular copy if hardlink fails
      // (different filesystem / EXDEV).
      try { fs.linkSync(cachePath, jarPath); }
      catch (err) {
        if (err.code === 'EXDEV' || err.code === 'EPERM') {
          fs.copyFileSync(cachePath, jarPath);
        } else { throw err; }
      }
      console.log(`[jar-cache] HIT  ${t}-${server.version}  (no download)`);
      return jarPath;
    }
    // ── CACHE MISS — download to cache first, then hardlink to server dir.
    console.log(`[jar-cache] MISS ${t}-${server.version}  → downloading once`);
    await downloadFile(info.url, cachePath, `${t || 'paper'} ${info.version} (cache)`);
    try { fs.linkSync(cachePath, jarPath); }
    catch (err) {
      if (err.code === 'EXDEV' || err.code === 'EPERM') {
        fs.copyFileSync(cachePath, jarPath);
      } else { throw err; }
    }
    return jarPath;
  }

  // NeoForge — download directly into the server dir (installer runs in-place).
  await downloadFile(info.url, jarPath, `${t || 'paper'} ${info.version}`);

  // NeoForge ships an installer JAR — running it generates the actual server
  // launcher. After install, swap server.jar to point at the launcher.
  if (info.installer && t === 'neoforge') {
    const { execFileSync } = require('child_process');
    try {
      execFileSync('java', ['-jar', jarPath, '--installServer'], { cwd: dir, stdio: 'inherit', timeout: 180_000 });
      // NeoForge generates run.sh + a jar in libraries/. Use the @user_jvm_args.txt + @libraries
      // path approach by replacing server.jar with a small wrapper script's main jar.
      // Simpler: run from the generated `run.sh` script — but we use server.jar throughout,
      // so symlink the resulting forge jar.
      const fsList = fs.readdirSync(dir);
      const forgeJar = fsList.find(f => /^neoforge-.*\.jar$/.test(f) && !f.includes('installer'));
      if (forgeJar) {
        fs.unlinkSync(jarPath);
        fs.symlinkSync(path.join(dir, forgeJar), jarPath);
      }
    } catch (err) {
      throw new Error(`NeoForge installer failed: ${err.message}`);
    }
  }

  return jarPath;
}

function writeServerConfig(server, dir, hostPort) {
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');

  // Read existing props so user-edited values (pvp, view-distance, etc) survive restarts.
  const propPath = path.join(dir, 'server.properties');
  const existing = {};
  if (fs.existsSync(propPath)) {
    try {
      fs.readFileSync(propPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) existing[m[1].trim()] = m[2];
      });
    } catch {}
  }

  // Authoritative values from the DB / controller (overwrite existing on every start)
  const authoritative = {
    'server-port': String(hostPort),
    'online-mode': 'false', // cracked
    'enable-rcon': 'true',
    'rcon.port': String(hostPort + 10),
    'rcon.password': server.rcon_password,
    'level-name': 'world',
    // MOTD supports & color codes (more typeable than §). Convert & → § on the way
    // out so MC renders them as colors. Strip newlines.
    'motd': (server.motd || 'A CraftHost server').replace(/[\n\r]/g, ' ').replace(/&([0-9a-fk-or])/gi, '§$1'),
    'max-players': String(server.max_players || 10),
    'difficulty': server.difficulty || 'normal',
    'gamemode': server.gamemode || 'survival',
    'white-list': server.whitelist ? 'true' : 'false',
  };
  if (server.whitelist) authoritative['enforce-whitelist'] = 'true';

  // Defaults applied only if not already present.
  // Conservative for free tier — small view distance saves ~150 MB.
  const defaults = {
    'enable-command-block': 'false',
    'spawn-protection': '0',
    'view-distance': '6',
    'simulation-distance': '4',
    'entity-broadcast-range-percentage': '80',
    'network-compression-threshold': '256',
    'pvp': 'true',
    'hardcore': 'false',
    'sync-chunk-writes': 'false',
  };

  const merged = { ...defaults, ...existing, ...authoritative };
  const out = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(propPath, out);
}

async function createServer(server) {
  // Just pre-create the directory; JAR download deferred until first start.
  serverDir(server.id);
  return { containerId: `jvm-${server.id}`, status: 'created' };
}

async function startServer(containerId, server) {
  const id = String(containerId || '').replace(/^jvm-/, '') || server?.id;
  if (running.has(id) && running.get(id).proc && !running.get(id).proc.killed) {
    return { status: 'running' };
  }

  const dir = serverDir(id);
  const jarPath = await ensureJar(server);
  const hostPort = pickHostPort(server);
  writeServerConfig(server, dir, hostPort);

  // Heap: respect plan but cap to fit Railway free tier
  const planRam = parseInt(server.ram_mb || 512, 10);
  const heap = Math.max(256, Math.min(planRam, MAX_HEAP_MB));

  // Aikar's Flags — industry-standard JVM tuning for Paper/Spigot
  // https://docs.papermc.io/paper/aikars-flags  (params for < 12 GB heaps)
  // Result: smoother TPS, lower GC pause spikes, fewer stalls under load.
  // -XX:+UnlockExperimentalVMOptions MUST precede any experimental flag.
  const args = [
    // Start small, grow to max — opposite of vanilla Aikar's which pretouches
    // the whole heap on boot. Pretouching is great for dedicated single-tenant
    // boxes, terrible for multi-tenant where it OOM-kills the container.
    `-Xms${Math.min(256, heap)}M`,
    `-Xmx${heap}M`,
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+DisableExplicitGC',
    // AlwaysPreTouch intentionally REMOVED — see comment above.
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
    '-XX:MetaspaceSize=64M',
    '-XX:MaxMetaspaceSize=192M',
    '-XX:ReservedCodeCacheSize=64M',
    '-Dlog4j2.formatMsgNoLookups=true',
    '-jar', jarPath,
    'nogui',
  ];

  const proc = spawn('java', args, {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JAVA_TOOL_OPTIONS: '' },
  });

  // Persistent log listeners across restarts — WebSocket clients attached to
  // the previous state (which we just deleted via stop/restart) get carried over
  // so their stream continues uninterrupted into the new process's output.
  const carryListeners = (persistentListeners.get(id) || new Set());
  // Carry over the last 200 lines from the previous run so users (and the
  // smoke test) can still see "java.lang.OutOfMemoryError…" or stack traces
  // that the now-dead process emitted before the restart loop wiped them.
  const prev = running.get(id);
  const carryLogs = prev?.logs?.slice(-200) || [];
  if (carryLogs.length) carryLogs.push('────── previous run ended; restart attempt ──────');
  const state = {
    proc,
    pid: proc.pid,
    hostPort,
    logs: carryLogs,
    listeners: carryListeners,
    ready: false,
    startedAt: Date.now(),
    exitCode: null,
    lastCpu: null,
    intentional: false,
    server,
  };
  running.set(id, state);
  persistentListeners.set(id, carryListeners);
  // Tell connected clients there's a new process so they can render a separator
  for (const fn of carryListeners) {
    try { fn(`[jvm] new process spawned (pid=${proc.pid})`); } catch {}
  }
  // Also push to the persistent ring so /api/logs sees it even with no live WS clients.
  state.logs.push(`[jvm] spawned pid=${proc.pid} heap=${heap}MB jar=${path.basename(jarPath)}`);
  // Mirror to Railway logs too — invaluable when the JVM dies before writing anything.
  console.log(`[jvm/${id}] spawn pid=${proc.pid} heap=${heap}MB type=${(server.type||'paper')} ver=${server.version}`);
  // Clear any prior crash record — a successful restart resets the trigger.
  crashes.delete(id);

  const onLine = (line) => {
    const stamped = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    if (!stamped) return;
    state.logs.push(stamped);
    if (state.logs.length > LOG_RING_SIZE) state.logs.shift();
    if (!state.ready && /Done \([\d.]+s\)!/i.test(stamped)) {
      state.ready = true;
      // CRITICAL: flip DB status starting → online so the dashboard, smoke
      // tests, and tight-poll mechanisms see the server as ready. Without
      // this the row stayed at 'starting' forever even though the JVM was
      // accepting connections.
      try {
        const db = require('../db');
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('online', id);
      } catch (err) {
        console.warn(`[jvm/${id}] status→online DB update failed: ${err.message}`);
      }
      console.log(`[jvm/${id}] ✓ READY — Done marker detected, status → online`);
    }
    // Detect Java heap OOM during boot. Multiple message formats are possible:
    //   • "java.lang.OutOfMemoryError: Java heap space"
    //   • "Exception: java.lang.OutOfMemoryError thrown from the UncaughtExceptionHandler in thread …"
    //   • "java.lang.OutOfMemoryError: GC overhead limit exceeded"
    //   • "java.lang.OutOfMemoryError: Metaspace"
    // The JVM may NOT exit on these — it just keeps throwing — so we must also
    // mark the DB status as 'crashed' so the auto-heal loop can swap to the safe
    // combo. (Without this, the server appears to hang forever.)
    if (/OutOfMemoryError/i.test(stamped)) {
      state.oom = true;
      // Only flip status once per state — repeated OOM lines shouldn't spam UPDATEs.
      if (!state._oomFlipped) {
        state._oomFlipped = true;
        try {
          const db = require('../db');
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('crashed', id);
        } catch {}
        // Kill the hung JVM so the auto-heal loop's startServer() can spawn a
        // fresh process. Without this, the OOM'd JVM hangs holding the port
        // and the heal-restart sees "still running, skip".
        setTimeout(() => {
          try { if (state.proc && !state.proc.killed) state.proc.kill('SIGKILL'); } catch {}
        }, 1500);
      }
    }
    for (const fn of state.listeners) {
      try { fn(stamped); } catch {}
    }
  };

  let stdoutBuf = '', stderrBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    lines.forEach(onLine);
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach(onLine);
  });
  proc.on('exit', (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
    // Mirror to Railway logs so post-mortem diagnosis works even when the
    // per-server log ring gets reset on the next restart attempt.
    console.log(`[jvm/${id}] exit code=${code} signal=${signal || 'none'} after ${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`);
    let msg = `[jvm] process exited (code=${code}, signal=${signal || 'none'})`;
    const isOom = signal === 'SIGKILL' || code === 137;
    if (isOom) {
      msg += ' — likely OOM-killed. Try a smaller world or upgrade plan.';
      state.oom = true;
    } else if (code !== 0 && code !== null) {
      msg += ' — crash. Check console logs above for stack trace.';
    }
    // CRITICAL: update the DB status so the auto-heal / auto-fix loops can find
    // this server. Without this, status stays at 'starting' forever and the
    // query `WHERE status IN ('offline','crashed','error')` never matches.
    // Intentional stops set the status themselves (in stopServer / idle-stop).
    if (!state.intentional) {
      try {
        const db = require('../db');
        const newStatus = isOom ? 'crashed' : (code !== 0 || signal) ? 'crashed' : 'offline';
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(newStatus, id);
      } catch (err) {
        // Don't crash the controller if the DB write fails — auto-heal will
        // catch it on its next probe via getStats().
        console.warn(`[jvm-exit] DB status update failed for ${id}: ${err.message}`);
      }
    }
    // Record unexpected (non-intentional, non-OOM) crashes so the auto-restart
    // loop in server.js can revive the server. Don't record graceful stops or
    // OOMs (the latter is handled by auto-heal).
    if (!state.intentional && !isOom && (code !== 0 || signal)) {
      crashes.set(id, { when: Date.now(), code, signal });
    }
    onLine(msg);

    // Immediate Paperclip-libs fix — Paperclip exits cleanly (code 0) when any
    // extracted library has a hash mismatch. Without this, recovery waits up to
    // 20s for the auto-heal loop. Here we detect it on exit, wipe libraries/ +
    // versions/ RIGHT AWAY, emit a visible console line, and restart in ~2s.
    // We also stamp last_auto_fix_* so the 20s loop doesn't double-trigger.
    if (!state.intentional && !isOom && code === 0 &&
        state.logs.some(l => /Hash check failed for extract|paperclip\.Paperclip\.extractEntries|FileEntry\.extractFile/i.test(l))) {
      (async () => {
        try {
          for (const sub of ['libraries', 'versions']) {
            await fsp.rm(path.join(dir, sub), { recursive: true, force: true });
          }
          onLine('[jvm] ✓ Auto-fix: corrupt Paperclip libs wiped — re-extracting on restart…');
          try {
            const db = require('../db');
            const now = Date.now();
            db.prepare('UPDATE servers SET last_auto_fix_kind = ?, last_auto_fix_at = ? WHERE id = ?')
              .run('libs', now, id);
          } catch {}
          await new Promise(r => setTimeout(r, 2000));
          const fresh = state.server;
          await startServer(containerId, fresh);
          try {
            const db = require('../db');
            db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', id);
          } catch {}
        } catch (err) {
          onLine(`[jvm] libs auto-fix failed: ${err.message}`);
        }
      })();
    }
  });
  proc.on('error', (err) => {
    onLine(`[jvm] spawn error: ${err.message}`);
  });

  return { status: 'starting', pid: proc.pid, hostPort };
}

async function stopServer(containerId, server) {
  const id = String(containerId || '').replace(/^jvm-/, '') || server?.id;
  const state = running.get(id);
  if (!state || !state.proc || state.proc.killed) return { status: 'offline' };
  // Mark this as an intentional shutdown — the exit handler uses this to skip
  // the auto-restart trigger.
  state.intentional = true;
  crashes.delete(id);
  try {
    // graceful: send "stop" via stdin first
    state.proc.stdin.write('stop\n');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { state.proc.kill('SIGTERM'); } catch {}
        resolve();
      }, 20000);
      state.proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  } catch {}
  running.delete(id);
  return { status: 'offline' };
}

async function restartServer(containerId, server) {
  await stopServer(containerId, server);
  return startServer(containerId, server);
}

async function removeServer(containerId, server) {
  await stopServer(containerId, server);
  const id = String(containerId || '').replace(/^jvm-/, '') || server?.id;
  const dir = path.join(DATA_DIR, id);
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
  return { status: 'removed' };
}

function readProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 14 (utime) + 15 (stime) — but command field can contain spaces, so split on ')'
    const idx = stat.lastIndexOf(')');
    const fields = stat.slice(idx + 2).split(' ');
    // After removing "pid (comm) ", fields[11]=utime, fields[12]=stime
    const utime = parseInt(fields[11], 10) || 0;
    const stime = parseInt(fields[12], 10) || 0;
    return utime + stime;
  } catch { return null; }
}

function readProcRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

function totalSystemMemKb() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

// Minecraft Server List Ping. Connects to the JVM's host port locally, sends a
// 1.7+ handshake + status request, parses the JSON response, returns key fields.
// Cached per-server for SLP_CACHE_TTL.
function vi(n) {
  const a = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; a.push(b); } while (n);
  return Buffer.from(a);
}
function readVarInt(buf, offset) {
  let result = 0, pos = 0, byte;
  for (;;) {
    if (offset >= buf.length) return null;
    byte = buf[offset++];
    result |= (byte & 0x7f) << pos;
    if ((byte & 0x80) === 0) break;
    pos += 7;
    if (pos > 35) return null;
  }
  return { value: result, next: offset };
}
async function slpProbe(hostPort, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(v); };
    const sock = net.connect(hostPort, '127.0.0.1', () => {
      const host = '127.0.0.1';
      const handshake = Buffer.concat([
        Buffer.from([0x00]), vi(770),
        vi(host.length), Buffer.from(host),
        Buffer.from([(hostPort >> 8) & 0xff, hostPort & 0xff]),
        Buffer.from([0x01]),
      ]);
      sock.write(Buffer.concat([vi(handshake.length), handshake]));
      sock.write(Buffer.concat([vi(1), Buffer.from([0x00])]));
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // Try to parse: packetLen | packetId(0) | strLen | json
      const lenRead = readVarInt(buf, 0);
      if (!lenRead) return;
      const remaining = buf.length - lenRead.next;
      if (remaining < lenRead.value) return; // need more bytes
      let off = lenRead.next;
      const idRead = readVarInt(buf, off);
      if (!idRead) return;
      off = idRead.next;
      const strLen = readVarInt(buf, off);
      if (!strLen) return;
      off = strLen.next;
      if (buf.length < off + strLen.value) return;
      const json = buf.slice(off, off + strLen.value).toString('utf8');
      try { finish(JSON.parse(json)); } catch { finish(null); }
    });
    sock.on('error', () => finish(null));
    sock.setTimeout(timeoutMs, () => finish(null));
  });
}

async function getCachedSlp(state, hostPort) {
  if (state.slp && Date.now() - state.slp.ts < SLP_CACHE_TTL) return state.slp.data;
  const data = await slpProbe(hostPort).catch(() => null);
  state.slp = { data, ts: Date.now() };
  return data;
}

async function getStats(containerId, server) {
  const id = String(containerId || '').replace(/^jvm-/, '') || server?.id;
  const state = running.get(id);
  if (!state || !state.proc || state.proc.killed || state.exitCode !== null) {
    const offlinePlanRam = parseInt(server?.ram_mb || MAX_HEAP_MB, 10);
    const offlineHeap = Math.max(256, Math.min(offlinePlanRam, MAX_HEAP_MB));
    return {
      cpu: 0, ram_used: 0,
      ram_max: Math.max(offlinePlanRam, offlineHeap * 2),
      heap_max_mb: offlineHeap,
      tps: 0, uptime: 0, players: 0, online: false,
      exit_code: state?.exitCode ?? null,
      exit_signal: state?.exitSignal ?? null,
      oom: !!state?.oom,
      last_log: (state?.logs || []).slice(-5),
    };
  }
  const pid = state.pid;

  // CPU: sample twice over 200ms
  const t1 = readProcStat(pid);
  const wall1 = Date.now();
  await new Promise(r => setTimeout(r, 200));
  const t2 = readProcStat(pid);
  const wall2 = Date.now();
  const clockTick = 100; // jiffies per second (Alpine default)
  const ncpu = require('os').cpus().length;
  let cpu = 0;
  if (t1 != null && t2 != null) {
    const deltaTicks = t2 - t1;
    const deltaMs = wall2 - wall1;
    cpu = Math.min(100, Math.round((deltaTicks / clockTick) * 1000 / deltaMs * 100 / ncpu));
  }

  const rssKb = readProcRssKb(pid) || 0;
  const ramUsed = Math.round(rssKb / 1024);
  // Process RSS = heap + JVM overhead (metaspace, off-heap, native libs, GC
  // metadata) — typically heap × ~1.5–2. The plan's ram_mb represents the heap
  // cap, not the RSS cap, so reporting `ram_max = ram_mb` makes the bar overflow
  // every time. Use heap × 2 (or planRam, whichever is larger) as the realistic
  // process budget so the displayed bar matches what users actually see.
  const planRam = parseInt(server?.ram_mb || MAX_HEAP_MB, 10);
  const heapMb = Math.max(256, Math.min(planRam, MAX_HEAP_MB));
  const ramMax = Math.max(planRam, Math.round(heapMb * 2));

  // Live player count + MOTD via SLP (only when server is ready)
  let slp = null;
  if (state.ready) slp = await getCachedSlp(state, state.hostPort);

  // Roll a tiny TPS history (last 30 samples ≈ last 60s at our 2s probe cadence
  // in /api/servers polling). Used by the dashboard sparkline to show recent
  // server health at a glance.
  const tpsNow = state.ready ? 20.0 : 0;
  if (!state.tpsHistory) state.tpsHistory = [];
  state.tpsHistory.push(tpsNow);
  if (state.tpsHistory.length > 30) state.tpsHistory.shift();

  return {
    cpu,
    ram_used: ramUsed,
    ram_max: ramMax,
    heap_max_mb: heapMb,
    tps: tpsNow, // approximate; real TPS would need RCON `/tps`
    tps_history: state.tpsHistory.slice(), // copy so the caller can't mutate
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    players: slp?.players?.online ?? 0,
    players_max: slp?.players?.max ?? (server?.max_players || 0),
    player_sample: (slp?.players?.sample || []).map(p => p.name).slice(0, 12),
    motd: typeof slp?.description === 'string' ? slp.description
          : (slp?.description?.text || slp?.description?.translate || null),
    mc_version: slp?.version?.name || null,
    online: state.ready,
    ready: state.ready,
    host_port: state.hostPort,
  };
}

async function attachLogStream(containerId, onLine) {
  const id = String(containerId || '').replace(/^jvm-/, '');
  // Register the listener in the persistent set so it survives stop/start
  // cycles (the new state inherits this set in startServer).
  let set = persistentListeners.get(id);
  if (!set) { set = new Set(); persistentListeners.set(id, set); }
  set.add(onLine);

  const state = running.get(id);
  if (!state) {
    onLine('[jvm] server is not running (logs will start streaming once it boots)');
  } else {
    // Replay buffered logs from the current process
    for (const l of state.logs) {
      try { onLine(l); } catch {}
    }
    // Ensure the state's listener Set is the persistent one
    if (state.listeners !== set) {
      for (const fn of state.listeners) set.add(fn);
      state.listeners = set;
    }
  }
  return { stop: () => {
    set.delete(onLine);
    const cur = running.get(id);
    if (cur?.listeners) cur.listeners.delete(onLine);
  }};
}

async function sendRcon(server, command) {
  const id = server.id;
  const state = running.get(id);
  if (!state || !state.proc || state.proc.killed) {
    return '[jvm] server is not running';
  }
  // Cheapest reliable path: write to stdin. The Paper console accepts commands without leading slash.
  const cmd = command.startsWith('/') ? command.slice(1) : command;
  try {
    state.proc.stdin.write(cmd + '\n');
    // Capture lines emitted in the next 600ms as the "response"
    const captured = [];
    const cap = (line) => captured.push(line);
    state.listeners.add(cap);
    await new Promise(r => setTimeout(r, 600));
    state.listeners.delete(cap);
    return captured.length ? captured.join('\n') : `(no immediate output for: ${command})`;
  } catch (err) {
    return `JVM RCON error: ${err.message}`;
  }
}

function listRunning() {
  return Array.from(running.entries()).map(([id, s]) => ({
    id, pid: s.pid, ready: s.ready, hostPort: s.hostPort, startedAt: s.startedAt,
  }));
}

function __getState(id) { return running.get(id) || null; }

// Crash event API consumed by the auto-restart loop in server.js.
// getCrashes() returns [[id, {when, code, signal}], ...] for servers that
// exited unexpectedly. clearCrash(id) removes the record once handled.
function getCrashes() { return Array.from(crashes.entries()); }
function clearCrash(id) { crashes.delete(id); }

// Pre-warm the JAR cache with popular versions so the FIRST user to deploy
// any of these gets a cache HIT (instant boot) instead of a 30-90s download.
// Runs in background — never blocks startup. Skips anything already cached.
// Errors are non-fatal: if a download fails, log it and move on.
async function prewarmJarCache() {
  const STABLE = '1.20.1';
  const targets = [
    { type: 'paper',   version: STABLE,  resolve: paperJarUrl   },
    { type: 'paper',   version: 'LATEST', resolve: paperJarUrl   },
    { type: 'vanilla', version: STABLE,  resolve: vanillaJarUrl },
    { type: 'vanilla', version: 'LATEST', resolve: vanillaJarUrl },
    { type: 'purpur',  version: STABLE,  resolve: purpurJarUrl  },
    { type: 'purpur',  version: 'LATEST', resolve: purpurJarUrl  },
    { type: 'fabric',  version: STABLE,  resolve: fabricJarUrl  },
    { type: 'fabric',  version: 'LATEST', resolve: fabricJarUrl  },
  ];
  try { fs.mkdirSync(JAR_CACHE_DIR, { recursive: true }); } catch {}

  let hits = 0, misses = 0, errors = 0, mb = 0;
  for (const t of targets) {
    try {
      const info = await t.resolve(t.version);
      const cachePath = cachedJarPath(t.type, info.version, info);
      if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100000) {
        hits++;
        continue;
      }
      console.log(`[jar-cache/prewarm] ${t.type}-${info.version} → downloading`);
      const size = await downloadFile(info.url, cachePath, `${t.type} ${info.version} prewarm`);
      misses++;
      mb += size / 1024 / 1024;
    } catch (err) {
      errors++;
      console.warn(`[jar-cache/prewarm] ${t.type}-${t.version} failed: ${err.message.slice(0, 100)}`);
    }
  }
  console.log(`📦 JAR cache prewarmed: ${hits} hit · ${misses} downloaded (${mb.toFixed(0)}MB) · ${errors} errors`);
}

module.exports = {
  isAvailable,
  makeRconPassword,
  createServer,
  startServer,
  stopServer,
  restartServer,
  removeServer,
  prewarmJarCache,
  getStats,
  attachLogStream,
  sendRcon,
  listRunning,
  __getState,
  getCrashes,
  clearCrash,
};
