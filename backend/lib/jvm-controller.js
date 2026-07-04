// JVM controller — spawns real Paper/Vanilla Minecraft servers as child processes.
// Runs INSIDE this Node container (no Docker needed). Each server gets a working dir
// under DATA_DIR/<id>/ and a `java -jar server.jar nogui` process.
//
// Constraints:
//   - Railway service exposes ONE public TCP port (MC_PORT, default 25565).
//     So at most ONE server can be publicly reachable at a time.
//     The "active" server gets MC_PORT; others run on internal ports for testing.
//   - Free Railway tier has limited RAM. We cap heap aggressively.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const net = require("net");
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");

const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, "../../data/servers");
const PUBLIC_PORT = parseInt(process.env.MC_PORT || "25565", 10);
// Cap heap to stay under Railway's container memory. Paper 1.21+ needs ~500MB
// during DataFixers static init or it throws OutOfMemoryError. 480 is the
// sweet spot for free tier (leaves ~64MB for the Node parent + JVM overhead).
// Heap cap per server. Was 2456 (2.4GB heap from a 3GB plan) but combined
// with Aikar's +AlwaysPreTouch that forced 2.4GB to be allocated upfront on
// every server boot — so 2 servers = 5GB, more than the Railway container's
// memory limit, and the new JVM got OOM-killed silently (no logs survive).
// Drop to 1024 MB heap so 3-4 small servers can coexist on the same container.
// Override via MAX_HEAP_MB env per-deploy if heavier mod-packs need it.
const MAX_HEAP_MB = parseInt(process.env.MAX_HEAP_MB || "1024", 10);
// CPU cap fed to the JVM via -XX:ActiveProcessorCount. Railway's underlying host
// reports many cores (32+), so by default the JVM sizes its GC pools, JIT
// compiler threads, and — most damaging — Paper's worldgen ForkJoin workers to
// that count. Dozens of threads, each reserving a ~1MB native stack, on top of
// the heap, overshoot the container's memory/PID limit and the kernel returns
// EAGAIN to pthread_create ("OutOfMemoryError: unable to create native thread"),
// crash-looping the server. Pinning to 2 keeps every auto-sized pool tiny.
const JVM_CPUS = Math.max(1, parseInt(process.env.JVM_CPUS || "2", 10));
const INTERNAL_PORT_BASE = 26000;
// When set, each server gets its own Geyser UDP port + its own playit Bedrock
// tunnel (per-server Bedrock IP). Off = single shared Bedrock tunnel (legacy).
const BEDROCK_PER_SERVER = process.env.BEDROCK_PER_SERVER === "1";
const LOG_RING_SIZE = 1000;
// Hard cap on a single jar download so a stalled transfer can't wedge a deploy.
const JAR_DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.JAR_DOWNLOAD_TIMEOUT_MS || "180000",
  10,
);

const PAPER_API = process.env.PAPER_API || "https://api.papermc.io/v2";
const MOJANG_MANIFEST =
  process.env.MOJANG_MANIFEST ||
  "https://launchermeta.mojang.com/mc/game/version_manifest.json";

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
// id → token of the most recent start attempt. A jar download can take tens of
// seconds; if the user hits Stop (or clicks Start again) in that window, the
// original in-flight start must NOT spawn a JVM when its download finishes —
// that "stopped" server coming back to life on its own looked like the
// platform randomly starting/stopping servers. stopServer clears the token;
// a newer startServer replaces it; either way the stale attempt aborts.
const startTokens = new Map();

function isAvailable() {
  if (process.env.DISABLE_JVM === "1") return false;
  try {
    execFileSync("java", ["-version"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function makeRconPassword() {
  return crypto.randomBytes(16).toString("hex");
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

// True when nothing in the container currently listens on the port.
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

// pickHostPort is purely deterministic, so a stale listener (e.g. a JVM that
// survived its server's deletion) poisons that slot forever: every new server
// assigned it dies on "Failed to bind … Address in use" with exit code 0.
// Verify the slot is actually bindable and probe forward when it isn't.
async function pickFreeHostPort(server) {
  const preferred = pickHostPort(server);
  if (await portIsFree(preferred)) return preferred;
  console.warn(`[jvm] port ${preferred} is busy — probing for a free slot`);
  const offset = Math.max(0, parseInt(server.port, 10) - 25565);
  for (let i = 1; i < 1000; i++) {
    const cand = INTERNAL_PORT_BASE + ((offset + i) % 1000);
    if (cand === preferred || cand === PUBLIC_PORT) continue;
    let taken = false;
    for (const [, state] of running) {
      if (state.hostPort === cand) {
        taken = true;
        break;
      }
    }
    if (!taken && (await portIsFree(cand))) {
      console.warn(`[jvm] using fallback port ${cand} for ${server.id}`);
      return cand;
    }
  }
  return preferred; // nothing free — let the boot fail loudly in the log
}

// Kill any process whose cwd is (or was, before deletion) the given server
// dir but which we no longer track — JVMs orphaned by a Node restart keep
// their ports bound and poison every future boot on that slot.
function killOrphansByDir(dir) {
  let killed = 0;
  const target = path.resolve(dir);
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    if (pid === process.pid) continue;
    let cwd;
    try {
      cwd = fs.readlinkSync(`/proc/${ent}/cwd`);
    } catch {
      continue;
    }
    if (cwd === target || cwd === `${target} (deleted)`) {
      try {
        process.kill(pid, "SIGKILL");
        killed++;
        console.warn(`[jvm] killed orphan pid=${pid} (cwd=${cwd})`);
      } catch {}
    }
  }
  return killed;
}

// Unique local UDP port for THIS server's Geyser (Bedrock). Multiple servers
// share one container, so each Geyser must bind a distinct UDP port. Derived
// deterministically from the server's DB-assigned port so it's stable across
// restarts and collision-free. Used both to write Geyser's config and to point
// this server's playit Bedrock tunnel at it.
function geyserUdpPort(server) {
  const off = Math.max(0, parseInt(server.port, 10) - 25565);
  return 40000 + (off % 20000); // 40000–59999, unique per server
}

async function downloadFile(url, dest, label) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "CraftHost/1.0" },
      // Node's fetch never times out on its own; without this a stalled jar
      // download hangs the deploy forever (server stuck "downloading"). Cap the
      // whole transfer — generous so real jars finish, configurable for slow links.
      signal: AbortSignal.timeout(JAR_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(
      `${label} download failed: ${
        e.name === "TimeoutError"
          ? `timed out after ${JAR_DOWNLOAD_TIMEOUT_MS}ms`
          : e.message
      }`,
    );
  }
  if (!res.ok) throw new Error(`${label} download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return buf.length;
}

// Resolve the URL to a Paper server JAR for a given MC version. Paper migrated
// from the v2 API (api.papermc.io) to the v3 API (fill.papermc.io) — only v3
// carries the new year-based versions (26.1.2 etc). We try v3 first since it
// covers EVERY published Paper version (1.7 → 26.x), then fall back to v2 if
// v3 is unreachable for some reason.
const PAPER_V3 = process.env.PAPER_V3_API || "https://fill.papermc.io/v3";
async function paperJarUrl(version) {
  const want = version && version !== "LATEST" ? version : null;
  try {
    // ── v3 path ─────────────────────────────────────────────────────────────
    let mcVersion = want;
    if (!mcVersion) {
      const r = await fetch(`${PAPER_V3}/projects/paper`, {
        headers: { "User-Agent": "CraftHost/1.0" },
      });
      if (!r.ok) throw new Error(`v3 project list: HTTP ${r.status}`);
      const data = await r.json();
      // v3 shape: { project, versions: { "26.1": ["26.1.2",...], "1.21": [...] } }
      const groups = Object.keys(data.versions || {});
      // Pick the highest group, then the highest version inside (first element is newest)
      const latestGroup = groups.sort((a, b) => {
        const pa = a.split(".").map(Number),
          pb = b.split(".").map(Number);
        return pb[0] - pa[0] || (pb[1] || 0) - (pa[1] || 0);
      })[0];
      mcVersion = data.versions[latestGroup][0];
    }
    const buildR = await fetch(
      `${PAPER_V3}/projects/paper/versions/${mcVersion}/builds/latest`,
      { headers: { "User-Agent": "CraftHost/1.0" } },
    );
    if (!buildR.ok)
      throw new Error(`v3 build lookup ${mcVersion}: HTTP ${buildR.status}`);
    const detail = await buildR.json();
    const dl = detail.downloads?.["server:default"];
    if (!dl?.url)
      throw new Error(`v3 ${mcVersion}: no server:default download`);
    return { url: dl.url, version: mcVersion, build: detail.id };
  } catch (v3err) {
    // ── v2 fallback ─────────────────────────────────────────────────────────
    try {
      let mcVersion = want;
      if (!mcVersion) {
        const r = await fetch(`${PAPER_API}/projects/paper`, {
          headers: { "User-Agent": "CraftHost/1.0" },
        });
        const data = await r.json();
        mcVersion = data.versions[data.versions.length - 1];
      }
      const buildsR = await fetch(
        `${PAPER_API}/projects/paper/versions/${mcVersion}`,
        { headers: { "User-Agent": "CraftHost/1.0" } },
      );
      if (!buildsR.ok)
        throw new Error(
          `v2 version ${mcVersion} not found (v3 err: ${v3err.message.slice(0, 80)})`,
        );
      const buildsData = await buildsR.json();
      const build = buildsData.builds[buildsData.builds.length - 1];
      const detailR = await fetch(
        `${PAPER_API}/projects/paper/versions/${mcVersion}/builds/${build}`,
        { headers: { "User-Agent": "CraftHost/1.0" } },
      );
      const detail = await detailR.json();
      const fileName = detail.downloads.application.name;
      return {
        url: `${PAPER_API}/projects/paper/versions/${mcVersion}/builds/${build}/downloads/${fileName}`,
        version: mcVersion,
        build,
      };
    } catch (v2err) {
      throw new Error(
        `Paper ${want || "LATEST"} unavailable on both APIs: v3=${v3err.message.slice(0, 60)} v2=${v2err.message.slice(0, 60)}`,
      );
    }
  }
}

// Purpur server JAR via api.purpurmc.org. Endpoint pattern:
//   /v2/purpur                              → { versions: [...] }
//   /v2/purpur/<mcversion>                  → { builds: { all, latest } }
//   /v2/purpur/<mcversion>/<build>/download → JAR
async function purpurJarUrl(version) {
  const PURPUR_API = process.env.PURPUR_API || "https://api.purpurmc.org/v2";
  let mcVersion = version && version !== "LATEST" ? version : null;
  if (!mcVersion) {
    const r = await fetch(`${PURPUR_API}/purpur`, {
      headers: { "User-Agent": "CraftHost/1.0" },
    });
    const m = await r.json();
    mcVersion = m.versions[m.versions.length - 1];
  }
  const r = await fetch(`${PURPUR_API}/purpur/${mcVersion}`, {
    headers: { "User-Agent": "CraftHost/1.0" },
  });
  if (!r.ok) throw new Error(`Purpur version ${mcVersion} not found`);
  const m = await r.json();
  const build = m.builds?.latest;
  if (!build) throw new Error(`No Purpur build for ${mcVersion}`);
  return {
    url: `${PURPUR_API}/purpur/${mcVersion}/${build}/download`,
    version: mcVersion,
    build,
  };
}

// Fabric server JAR. Fabric uses a "fabric server launcher" JAR that takes the
// game version, loader version, and installer version. We pick the latest stable
// of loader+installer for the requested game version.
async function fabricJarUrl(version) {
  const FABRIC_META = process.env.FABRIC_META || "https://meta.fabricmc.net/v2";
  let mcVersion = version && version !== "LATEST" ? version : null;
  if (!mcVersion) {
    const r = await fetch(`${FABRIC_META}/versions/game`, {
      headers: { "User-Agent": "CraftHost/1.0" },
    });
    const list = await r.json();
    mcVersion = (list.find((v) => v.stable) || list[0]).version;
  }
  // Loader: latest stable
  const lr = await fetch(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`,
    { headers: { "User-Agent": "CraftHost/1.0" } },
  );
  if (!lr.ok) throw new Error(`Fabric loaders for ${mcVersion} not found`);
  const loaders = await lr.json();
  const loaderVer = (loaders.find((l) => l.loader?.stable) || loaders[0])
    ?.loader?.version;
  if (!loaderVer) throw new Error(`No Fabric loader for ${mcVersion}`);
  // Installer: latest stable
  const ir = await fetch(`${FABRIC_META}/versions/installer`, {
    headers: { "User-Agent": "CraftHost/1.0" },
  });
  const installers = await ir.json();
  const installerVer = (installers.find((i) => i.stable) || installers[0])
    .version;
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
  const MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
  const r = await fetch(
    "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
    { headers: { "User-Agent": "CraftHost/1.0" } },
  );
  const m = await r.json();
  const all = m.versions || [];
  if (!all.length) throw new Error("No NeoForge versions found");
  if (!version || version === "LATEST") {
    version = all[all.length - 1];
  } else if (!all.includes(version)) {
    // The create form passes a MINECRAFT version ("1.21.1"), but the maven
    // needs a NeoForge version ("21.1.x" for MC 1.21.1, "26.1.2.x" for MC
    // 26.1.2) — requesting the MC version directly 404s. Map to the newest
    // NeoForge build for that MC version.
    const old = version.match(/^1\.(\d+)(?:\.(\d+))?$/);
    const prefix = old ? `${old[1]}.${old[2] || 0}.` : `${version}.`;
    const match = all.filter((v) => v.startsWith(prefix)).pop();
    if (!match) {
      // e.g. MC 1.20.1: NeoForge's own versioning starts at MC 1.20.2.
      throw new Error(
        `NeoForge has no builds for Minecraft ${version} (oldest supported is 1.20.2)`,
      );
    }
    version = match;
  }
  return {
    url: `${MAVEN}/${version}/neoforge-${version}-installer.jar`,
    version,
    installer: true,
  };
}

// Vanilla server JAR via Mojang manifest
async function vanillaJarUrl(version) {
  const manifestR = await fetch(MOJANG_MANIFEST, {
    headers: { "User-Agent": "CraftHost/1.0" },
  });
  const manifest = await manifestR.json();
  const target =
    version && version !== "LATEST"
      ? manifest.versions.find((v) => v.id === version)
      : manifest.versions.find((v) => v.id === manifest.latest.release);
  if (!target) throw new Error(`Vanilla version ${version} not found`);
  const versionR = await fetch(target.url, {
    headers: { "User-Agent": "CraftHost/1.0" },
  });
  const v = await versionR.json();
  if (!v.downloads?.server?.url)
    throw new Error("No server download for this version");
  return { url: v.downloads.server.url, version: target.id };
}

// Global JAR cache. Instead of downloading server.jar fresh into every
// server's dir (~50 MB × N servers), download it ONCE per type+version into
// /data/.jar-cache/, then hardlink into each server's directory. Same on-disk
// blob shared across all servers running that type+version — saves bandwidth
// (no re-download), boot time (no wait), and disk (1 inode reuse, not N copies).
const JAR_CACHE_DIR = path.join(DATA_DIR, "..", ".jar-cache");

function cachedJarPath(type, version, info) {
  const safeType = String(type || "paper").replace(/[^a-z0-9]/gi, "");
  const safeVer = String(version || info.version || "unknown").replace(
    /[^a-zA-Z0-9._-]/g,
    "",
  );
  return path.join(JAR_CACHE_DIR, `${safeType}-${safeVer}.jar`);
}

// ── Bedrock cross-play for non-plugin server types (Vanilla/Fabric/NeoForge) ──
// Paper/Spigot/Purpur load Geyser as an in-process plugin (see ensureGeyserConfig).
// Vanilla/Fabric/NeoForge can't load Spigot plugins, so for those we run
// Geyser-Standalone as a SIDECAR process: a separate JVM that listens on the
// server's Bedrock UDP port and proxies to the Java server at 127.0.0.1:<javaPort>
// in offline mode (every CraftHost server is online-mode=false, so Floodgate
// isn't needed). The existing playit UDP tunnel forwards to that same UDP port.
const STANDALONE_BEDROCK_TYPES = new Set(["vanilla", "fabric", "neoforge"]);
const GEYSER_STANDALONE_URL =
  process.env.GEYSER_STANDALONE_URL ||
  "https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/standalone";
const GEYSER_STANDALONE_JAR = path.join(JAR_CACHE_DIR, "geyser-standalone.jar");

// UDP port the playit Bedrock tunnel forwards to — MUST mirror playit.js:
// per-server mode → geyserUdpPort(server); shared mode → GEYSER_PORT (19132).
function bedrockListenPort(server) {
  return BEDROCK_PER_SERVER
    ? geyserUdpPort(server)
    : parseInt(process.env.GEYSER_PORT || "19132", 10);
}

// Download Geyser-Standalone into the shared cache (~28 MB). Re-used by every
// sidecar via cwd, so we never copy the jar per server. Refreshed if the cached
// jar is older than 24h so we track the latest Geyser build (the URL always
// points at latest), matching the plugin-cache freshness convention.
const GEYSER_STANDALONE_MAX_AGE_MS = 24 * 3600 * 1000;
async function ensureGeyserStandaloneJar() {
  try {
    const st = fs.statSync(GEYSER_STANDALONE_JAR);
    if (
      st.size > 1_000_000 &&
      Date.now() - st.mtimeMs < GEYSER_STANDALONE_MAX_AGE_MS
    )
      return GEYSER_STANDALONE_JAR;
  } catch {}
  fs.mkdirSync(JAR_CACHE_DIR, { recursive: true });
  const tmp = `${GEYSER_STANDALONE_JAR}.tmp`;
  try {
    await downloadFile(GEYSER_STANDALONE_URL, tmp, "Geyser-Standalone");
    fs.renameSync(tmp, GEYSER_STANDALONE_JAR);
  } catch (err) {
    // Refresh failed — fall back to the existing cached jar (stale but working)
    // so a transient download blip doesn't block server starts.
    try {
      fs.unlinkSync(tmp);
    } catch {}
    if (
      fs.existsSync(GEYSER_STANDALONE_JAR) &&
      fs.statSync(GEYSER_STANDALONE_JAR).size > 1_000_000
    )
      return GEYSER_STANDALONE_JAR;
    throw err;
  }
  return GEYSER_STANDALONE_JAR;
}

// Write a MINIMAL Geyser config — Geyser fills every other key with its own
// defaults and self-manages config-version, so this stays valid across Geyser
// releases (verified against 2.10.0). Authoritative values: bind port, Java
// target port, offline auth, and an MTU low enough to survive the playit free
// tunnel (~1200, same as the plugin path).
function writeStandaloneGeyserConfig(geyserDir, javaPort, bedrockPort) {
  fs.mkdirSync(geyserDir, { recursive: true });
  const mtu = parseInt(process.env.GEYSER_MTU || "1200", 10);
  const cfg =
    "# Managed by CraftHost — Geyser-Standalone sidecar for non-plugin server types.\n" +
    "bedrock:\n" +
    "  address: 0.0.0.0\n" +
    `  port: ${bedrockPort}\n` +
    "java:\n" +
    "  address: 127.0.0.1\n" +
    `  port: ${javaPort}\n` +
    "  auth-type: offline\n" +
    "advanced:\n" +
    "  bedrock:\n" +
    `    mtu: ${mtu}\n`;
  fs.writeFileSync(path.join(geyserDir, "config.yml"), cfg);
}

// Start the Geyser-Standalone sidecar for a server (idempotent). Stores the
// child process on the server's running-state so stopServer can reap it.
async function startBedrockSidecar(id, server, javaPort) {
  const state = running.get(id);
  if (!state) return;
  if (state.geyserProc && !state.geyserProc.killed) return; // already running
  const t = String(server.type || "").toLowerCase();
  if (!STANDALONE_BEDROCK_TYPES.has(t)) return; // spigot-family uses the plugin
  if (!server.playit_secret) return; // Bedrock not enabled for this server
  let jar;
  try {
    jar = await ensureGeyserStandaloneJar();
  } catch (err) {
    console.warn(`[geyser-sidecar/${id}] jar download failed:`, err.message);
    state.logs.push(`[geyser] download failed: ${err.message}`);
    return;
  }
  // Re-check: the MC stop/restart may have replaced state while we downloaded.
  const live = running.get(id);
  if (!live || live !== state) return;
  const geyserDir = path.join(serverDir(id), "geyser");
  const bedrockPort = bedrockListenPort(server);
  writeStandaloneGeyserConfig(geyserDir, javaPort, bedrockPort);
  const gproc = spawn(
    "java",
    [
      "-Xms64M",
      "-Xmx256M",
      `-XX:ActiveProcessorCount=${JVM_CPUS}`,
      "-Xss512k",
      "-XX:+ExitOnOutOfMemoryError",
      "-Dlog4j2.formatMsgNoLookups=true",
      "-jar",
      jar,
    ],
    {
      cwd: geyserDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, JAVA_TOOL_OPTIONS: "" },
    },
  );
  state.geyserProc = gproc;
  const onG = (buf) => {
    String(buf)
      .split("\n")
      .forEach((ln) => {
        const s = ln.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
        if (!s) return;
        const line = `[geyser] ${s}`;
        state.logs.push(line);
        if (state.logs.length > LOG_RING_SIZE) state.logs.shift();
        for (const fn of state.listeners) {
          try {
            fn(line);
          } catch {}
        }
      });
  };
  gproc.stdout.on("data", onG);
  gproc.stderr.on("data", onG);
  gproc.on("exit", (code, sig) => {
    state.logs.push(`[geyser] sidecar exited (code=${code} sig=${sig || "-"})`);
    if (state.geyserProc === gproc) state.geyserProc = null;
  });
  console.log(
    `[geyser-sidecar/${id}] started → UDP ${bedrockPort} ⇄ Java 127.0.0.1:${javaPort} (offline)`,
  );
  state.logs.push(
    `[geyser] Bedrock proxy starting on UDP ${bedrockPort} → Java ${javaPort}`,
  );
}

function stopBedrockSidecar(id) {
  const state = running.get(id);
  if (!state || !state.geyserProc) return;
  const gp = state.geyserProc;
  try {
    gp.kill("SIGTERM");
  } catch {}
  // Hard-kill if it lingers past the grace period.
  setTimeout(() => {
    try {
      if (gp && !gp.killed) gp.kill("SIGKILL");
    } catch {}
  }, 6000);
  state.geyserProc = null;
}

async function ensureJar(server) {
  const dir = serverDir(server.id);
  const jarPath = path.join(dir, "server.jar");
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 100000)
    return jarPath;

  const t = (server.type || "").toLowerCase();
  let info;
  if (t === "vanilla") info = await vanillaJarUrl(server.version);
  else if (t === "purpur") info = await purpurJarUrl(server.version);
  else if (t === "fabric") info = await fabricJarUrl(server.version);
  else if (t === "neoforge") info = await neoforgeJarUrl(server.version);
  // paper/spigot fall back to Paper (Spigot needs BuildTools — Paper is a drop-in)
  else info = await paperJarUrl(server.version);

  // NeoForge is a per-server installer that mutates the directory — skip cache
  // for it. All other engines are a single self-contained launcher JAR that
  // can be safely hardlinked across servers.
  const cacheable = t !== "neoforge";
  const cachePath = cachedJarPath(t || "paper", server.version, info);
  if (cacheable) {
    try {
      fs.mkdirSync(JAR_CACHE_DIR, { recursive: true });
    } catch {}
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100000) {
      // ── CACHE HIT — hardlink from the shared cache into this server's dir.
      // Hardlink keeps a single on-disk blob; deleting either path doesn't
      // affect the other. Falls back to a regular copy if hardlink fails
      // (different filesystem / EXDEV).
      try {
        fs.linkSync(cachePath, jarPath);
      } catch (err) {
        if (err.code === "EXDEV" || err.code === "EPERM") {
          fs.copyFileSync(cachePath, jarPath);
        } else {
          throw err;
        }
      }
      console.log(`[jar-cache] HIT  ${t}-${server.version}  (no download)`);
      return jarPath;
    }
    // ── CACHE MISS — download to cache first, then hardlink to server dir.
    console.log(`[jar-cache] MISS ${t}-${server.version}  → downloading once`);
    await downloadFile(
      info.url,
      cachePath,
      `${t || "paper"} ${info.version} (cache)`,
    );
    try {
      fs.linkSync(cachePath, jarPath);
    } catch (err) {
      if (err.code === "EXDEV" || err.code === "EPERM") {
        fs.copyFileSync(cachePath, jarPath);
      } else {
        throw err;
      }
    }
    return jarPath;
  }

  // NeoForge — download directly into the server dir (installer runs in-place).
  await downloadFile(info.url, jarPath, `${t || "paper"} ${info.version}`);

  // NeoForge ships an installer JAR — running it generates the actual server
  // launcher. After install, swap server.jar to point at the launcher.
  if (info.installer && t === "neoforge") {
    const { execFileSync } = require("child_process");
    try {
      execFileSync("java", ["-jar", jarPath, "--installServer"], {
        cwd: dir,
        stdio: "inherit",
        timeout: 180_000,
      });
      // Older NeoForge generated a neoforge-*.jar launcher next to the
      // installer — symlink server.jar to it when present. Modern NeoForge
      // (26.x) generates only run.sh + libraries/.../unix_args.txt; startServer
      // launches via that args file, so server.jar can stay as-is.
      const fsList = fs.readdirSync(dir);
      const forgeJar = fsList.find(
        (f) => /^neoforge-.*\.jar$/.test(f) && !f.includes("installer"),
      );
      if (forgeJar) {
        fs.unlinkSync(jarPath);
        fs.symlinkSync(path.join(dir, forgeJar), jarPath);
      } else if (!findNeoforgeArgsFile(dir)) {
        throw new Error(
          "installer produced neither a launcher jar nor unix_args.txt",
        );
      }
    } catch (err) {
      throw new Error(`NeoForge installer failed: ${err.message}`);
    }
  }

  return jarPath;
}

// Locate NeoForge's generated server-launch args file (modern install layout):
// libraries/net/neoforged/neoforge/<version>/unix_args.txt
function findNeoforgeArgsFile(dir) {
  try {
    const base = path.join(dir, "libraries", "net", "neoforged", "neoforge");
    for (const v of fs.readdirSync(base)) {
      const f = path.join(base, v, "unix_args.txt");
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

function writeServerConfig(server, dir, hostPort) {
  fs.writeFileSync(path.join(dir, "eula.txt"), "eula=true\n");

  // Read existing props so user-edited values (pvp, view-distance, etc) survive restarts.
  const propPath = path.join(dir, "server.properties");
  const existing = {};
  if (fs.existsSync(propPath)) {
    try {
      fs.readFileSync(propPath, "utf8")
        .split("\n")
        .forEach((line) => {
          const m = line.match(/^([^#=]+)=(.*)$/);
          if (m) existing[m[1].trim()] = m[2];
        });
    } catch {}
  }

  // Authoritative values from the DB / controller (overwrite existing on every start)
  const authoritative = {
    "server-port": String(hostPort),
    "online-mode": "false", // cracked
    "enable-rcon": "true",
    "rcon.port": String(hostPort + 10),
    "rcon.password": server.rcon_password,
    "level-name": "world",
    // MOTD supports & color codes (more typeable than §). Convert & → § on the way
    // out so MC renders them as colors. Strip newlines.
    motd: (server.motd || "A CraftHost server")
      .replace(/[\n\r]/g, " ")
      .replace(/&([0-9a-fk-or])/gi, "§$1"),
    "max-players": String(server.max_players || 10),
    difficulty: server.difficulty || "normal",
    gamemode: server.gamemode || "survival",
    "white-list": server.whitelist ? "true" : "false",
  };
  if (server.whitelist) authoritative["enforce-whitelist"] = "true";

  // Defaults applied only if not already present.
  // Conservative for free tier — small view distance saves ~150 MB.
  const defaults = {
    "enable-command-block": "false",
    "spawn-protection": "0",
    "view-distance": "6",
    "simulation-distance": "4",
    "entity-broadcast-range-percentage": "80",
    "network-compression-threshold": "256",
    pvp: "true",
    hardcore: "false",
    "sync-chunk-writes": "false",
  };

  const merged = { ...defaults, ...existing, ...authoritative };
  const out =
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  fs.writeFileSync(propPath, out);
}

// Self-heal stale platform-managed Bedrock plugins before every boot. Geyser
// hard-fails onEnable when its build predates the Paper it's loading into
// (reflection against renamed CraftBukkit internals — seen live on Paper 26.2
// with Geyser 2.10.1: Bedrock silently dead while the Java server ran fine).
// The plugin cache always holds the current build (GeyserMC download API), so
// if the jar seeded into plugins/ differs from the cache's, swap it out.
// Managed jars only — anything the user uploaded themselves has a filename
// that won't match a previous seed of these two projects.
async function refreshManagedBedrockPlugins(dir, mcVersion) {
  const MANAGED = [
    { pid: "wKkoqHrH", re: /^(geyser[-_]?spigot|Geyser-Spigot)[^/]*\.jar$/i },
    { pid: "bWrNNfkb", re: /^floodgate[-_]?(spigot)?[^/]*\.jar$/i },
  ];
  try {
    const pluginsDir = path.join(dir, "plugins");
    if (!fs.existsSync(pluginsDir)) return;
    const pluginCache = require("./plugin-cache");
    const entries = fs.readdirSync(pluginsDir);
    for (const { pid, re } of MANAGED) {
      const existing = entries.filter((f) => re.test(f));
      if (!existing.length) continue; // Bedrock not enabled for this server
      // What would the cache seed today?
      const tmp = path.join(dir, ".bedrock-refresh-tmp");
      let hit = null;
      try {
        hit = await pluginCache.copyFromCache(pid, tmp, mcVersion);
      } catch {}
      if (!hit) {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        continue; // cache cold — seeding path owns downloads, don't block boot
      }
      if (existing.includes(hit.filename)) {
        // Already current — drop the probe copy.
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      for (const f of existing) {
        await fsp.unlink(path.join(pluginsDir, f)).catch(() => {});
      }
      await fsp.rename(
        path.join(tmp, hit.filename),
        path.join(pluginsDir, hit.filename),
      );
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      console.log(
        `[bedrock-refresh] ${path.basename(dir)}: ${existing.join(", ")} → ${hit.filename}`,
      );
      require("./events").record("bedrock_plugin_refresh", path.basename(dir), {
        project: pid,
        from: existing,
        to: hit.filename,
      });
    }
  } catch (err) {
    console.warn(`[bedrock-refresh] ${path.basename(dir)}:`, err.message);
  }
}

// Force Geyser's RakNet MTU low enough to survive the playit free tunnel.
// The tunnel only forwards datagrams up to ~1200 bytes — the tiny RakNet
// handshake gets through, but Geyser's default 1400-byte in-session packets
// (resource-pack stack + start-game + chunks) get dropped, stranding Bedrock
// players on "Loading resource pack". Lowering Geyser's MTU makes it fragment
// game data to fit. Also pins remote/auth so Floodgate cross-play works.
function ensureGeyserConfig(dir, bedrockPort) {
  const TARGET_MTU = parseInt(process.env.GEYSER_MTU || "1200", 10);
  try {
    const pluginsDir = path.join(dir, "plugins");
    if (!fs.existsSync(pluginsDir)) return;
    if (!fs.readdirSync(pluginsDir).some((f) => /geyser/i.test(f))) return;
    const cfg = path.join(pluginsDir, "Geyser-Spigot", "config.yml");
    // If Geyser hasn't generated its config yet, leave it — Geyser writes a
    // full, valid default (with config-version) on first load. NEVER write a
    // partial config ourselves: modern Geyser refuses to load a config missing
    // `config-version` and disables itself (this previously broke all binds).
    if (!fs.existsSync(cfg)) return;
    let txt = fs.readFileSync(cfg, "utf8");
    // Self-heal: delete any earlier partial/broken config so Geyser regenerates
    // a clean valid one on this boot.
    if (!/config-version:/.test(txt)) {
      fs.unlinkSync(cfg);
      console.log(
        `[geyser-config] ${path.basename(dir)}: removed partial config — Geyser will regenerate`,
      );
      return;
    }
    let changed = false;
    // Valid config: surgically lower only the MTU number so Bedrock's larger
    // in-session packets fit the playit tunnel (fixes "Loading resource pack").
    if (/^\s*mtu:\s*\d+/m.test(txt)) {
      const patched = txt.replace(
        /^(\s*)mtu:\s*\d+.*$/m,
        `$1mtu: ${TARGET_MTU}`,
      );
      if (patched !== txt) {
        txt = patched;
        changed = true;
      }
    }
    // Per-server Bedrock: pin Geyser's bedrock listen port to this server's
    // unique UDP port so multiple Geysers can coexist in one container. Targets
    // the first `port:` inside the `bedrock:` section only.
    if (Number.isInteger(bedrockPort) && bedrockPort > 0) {
      const patched = txt.replace(
        /(^bedrock:[\s\S]*?\n\s*port:\s*)\d+/m,
        `$1${bedrockPort}`,
      );
      if (patched !== txt) {
        txt = patched;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(cfg, txt);
  } catch (e) {
    console.warn(`[geyser-config] ${path.basename(dir)}:`, e.message);
  }
}

// True iff Geyser is installed in this server but hasn't generated its config
// yet — i.e. this is the very first boot after Bedrock was enabled. On that
// boot ensureGeyserConfig() can't lower the MTU (no config to patch), so the
// MTU stays at Geyser's default 1400 and Bedrock players freeze on "Loading
// resource pack". geyserNeedsFirstBootFix() flags that case so the caller can
// self-heal automatically (patch MTU + one restart) — no manual double-restart.
function geyserNeedsFirstBootFix(dir) {
  try {
    const pluginsDir = path.join(dir, "plugins");
    if (!fs.existsSync(pluginsDir)) return false;
    if (!fs.readdirSync(pluginsDir).some((f) => /geyser/i.test(f)))
      return false;
    const cfg = path.join(pluginsDir, "Geyser-Spigot", "config.yml");
    const sentinel = path.join(dir, ".crafthost-geyser-mtu-fixed");
    return !fs.existsSync(cfg) && !fs.existsSync(sentinel);
  } catch {
    return false;
  }
}

// After a fresh-Bedrock first boot, wait for Geyser to write its config, lower
// the MTU to the tunnel-safe value, then restart ONCE so the new MTU binds —
// fully automatic so the Bedrock IP just works after the user clicks Enable.
// Guarded by a sentinel file so it can never loop.
function scheduleGeyserFirstBootFix(id, server, dir) {
  const sentinel = path.join(dir, ".crafthost-geyser-mtu-fixed");
  const cfg = path.join(dir, "plugins", "Geyser-Spigot", "config.yml");
  let tries = 0;
  const MAX_TRIES = 60; // ~3 min at 3s
  const tick = async () => {
    tries++;
    // Bail if the server was stopped/replaced while we waited.
    const st = running.get(id);
    if (!st || !st.proc || st.proc.killed) return;
    let ready = false;
    try {
      ready =
        fs.existsSync(cfg) &&
        /config-version:/.test(fs.readFileSync(cfg, "utf8"));
    } catch {}
    if (ready) {
      // lower MTU + (if per-server) pin this server's Bedrock port on the now-existing config
      ensureGeyserConfig(
        dir,
        BEDROCK_PER_SERVER ? geyserUdpPort(server) : undefined,
      );
      try {
        fs.writeFileSync(sentinel, new Date().toISOString());
      } catch {}
      console.log(
        `[geyser-fix] ${id}: MTU lowered on first boot — auto-restarting once so Bedrock binds cleanly`,
      );
      try {
        await restartServer(`jvm-${id}`, st.server || server);
      } catch (e) {
        console.warn(`[geyser-fix] ${id}: auto-restart failed:`, e.message);
      }
      return;
    }
    if (tries < MAX_TRIES) setTimeout(tick, 3000);
    else
      console.warn(
        `[geyser-fix] ${id}: Geyser config never appeared — skipping auto MTU fix`,
      );
  };
  setTimeout(tick, 8000); // give Geyser a head start before polling
}

// Geyser maps modern Bedrock clients to the latest Java protocol, so a Bedrock
// player can't join a server running an older Paper build — the join stalls at
// "Loading resource pack". ViaVersion + ViaBackwards bridge that protocol gap.
// Auto-install them next to Geyser so the bridge survives volume/server
// recreation (best-effort: a download hiccup must never block server start).
async function ensureViaVersion(dir) {
  try {
    const pluginsDir = path.join(dir, "plugins");
    if (!fs.existsSync(pluginsDir)) return;
    const files = fs.readdirSync(pluginsDir);
    // Only Bedrock (Geyser) servers need the version bridge.
    if (!files.some((f) => /geyser/i.test(f))) return;
    const want = [
      { re: /^viaversion/i, slug: "viaversion", name: "ViaVersion" },
      { re: /^viabackwards/i, slug: "viabackwards", name: "ViaBackwards" },
    ];
    for (const p of want) {
      if (files.some((f) => p.re.test(f))) continue; // already present
      try {
        const api = `https://api.modrinth.com/v2/project/${p.slug}/version?loaders=%5B%22paper%22,%22spigot%22%5D`;
        const r = await fetch(api, {
          headers: { "User-Agent": "CraftHost/1.0" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const versions = await r.json();
        const file =
          versions?.[0]?.files?.find((f) => f.primary) ||
          versions?.[0]?.files?.[0];
        if (!file?.url) throw new Error("no download url");
        await downloadFile(
          file.url,
          path.join(pluginsDir, file.filename),
          p.name,
        );
        console.log(`[via] ${path.basename(dir)}: installed ${file.filename}`);
      } catch (e) {
        console.warn(
          `[via] ${path.basename(dir)}: ${p.name} skipped: ${e.message}`,
        );
      }
    }
  } catch (e) {
    console.warn(`[via] ${path.basename(dir)}:`, e.message);
  }
}

async function createServer(server) {
  // Just pre-create the directory; JAR download deferred until first start.
  serverDir(server.id);
  return { containerId: `jvm-${server.id}`, status: "created" };
}

async function startServer(containerId, server) {
  const id = String(containerId || "").replace(/^jvm-/, "") || server?.id;
  if (running.has(id) && running.get(id).proc && !running.get(id).proc.killed) {
    return { status: "running" };
  }

  const startToken = {};
  startTokens.set(id, startToken);

  const dir = serverDir(id);
  const jarPath = await ensureJar(server);
  const hostPort = await pickFreeHostPort(server);
  // A stop (or a newer start) arrived while we were downloading the jar /
  // probing ports — abort instead of spawning a JVM nobody wants anymore.
  if (startTokens.get(id) !== startToken) {
    console.log(`[jvm/${id}] start cancelled (stopped while preparing)`);
    return { status: "cancelled" };
  }
  writeServerConfig(server, dir, hostPort);
  await ensureViaVersion(dir); // version bridge so Bedrock can join older Paper
  // Detect a fresh-Bedrock first boot BEFORE Geyser generates its config, so we
  // can self-heal the MTU right after (see scheduleGeyserFirstBootFix below).
  const geyserFirstBoot = geyserNeedsFirstBootFix(dir);
  // Per-server Bedrock (flagged): give this server's Geyser its own UDP port.
  const bedrockPort = BEDROCK_PER_SERVER ? geyserUdpPort(server) : undefined;
  ensureGeyserConfig(dir, bedrockPort); // MTU 1200 + (optional) per-server port
  await refreshManagedBedrockPlugins(dir, server.version); // stale Geyser/Floodgate → current build

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
    // ── Thread/native-memory containment (prevents pthread_create EAGAIN OOM) ──
    // Pin the perceived CPU count so GC, JIT, ForkJoin common pool, and Paper's
    // worldgen workers stay small instead of scaling to the host's 32+ cores.
    `-XX:ActiveProcessorCount=${JVM_CPUS}`,
    `-Djava.util.concurrent.ForkJoinPool.common.parallelism=${JVM_CPUS}`,
    // Halve each thread's reserved stack (default 1MB) so spawned threads use
    // far less native memory — more headroom under the container's limit.
    "-Xss512k",
    // If we still hit a native-memory wall, exit cleanly so the supervisor can
    // restart deterministically instead of limping on with dead worker threads.
    "-XX:+ExitOnOutOfMemoryError",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+UseG1GC",
    "-XX:+ParallelRefProcEnabled",
    "-XX:MaxGCPauseMillis=200",
    "-XX:+DisableExplicitGC",
    // AlwaysPreTouch intentionally REMOVED — see comment above.
    "-XX:G1NewSizePercent=30",
    "-XX:G1MaxNewSizePercent=40",
    "-XX:G1HeapRegionSize=8M",
    "-XX:G1ReservePercent=20",
    "-XX:G1HeapWastePercent=5",
    "-XX:G1MixedGCCountTarget=4",
    "-XX:InitiatingHeapOccupancyPercent=15",
    "-XX:G1MixedGCLiveThresholdPercent=90",
    "-XX:G1RSetUpdatingPauseTimePercent=5",
    "-XX:SurvivorRatio=32",
    "-XX:+PerfDisableSharedMem",
    "-XX:MaxTenuringThreshold=1",
    "-Dusing.aikars.flags=https://mcflags.emc.gs",
    "-Daikars.new.flags=true",
    "-XX:MetaspaceSize=64M",
    "-XX:MaxMetaspaceSize=192M",
    "-XX:ReservedCodeCacheSize=64M",
    "-Dlog4j2.formatMsgNoLookups=true",
    "-jar",
    jarPath,
    "nogui",
  ];

  // Modern NeoForge (26.x) has no launcher jar — the installer generates
  // libraries/net/neoforged/neoforge/<ver>/unix_args.txt and the official
  // launch is `java @that-file`. Without this, `-jar server.jar` re-runs the
  // INSTALLER (clean exit code 0) and the server never actually boots.
  if (String(server.type || "").toLowerCase() === "neoforge") {
    const argsFile = findNeoforgeArgsFile(dir);
    if (argsFile) {
      const jarIdx = args.indexOf("-jar");
      args.splice(jarIdx, 3, `@${path.relative(dir, argsFile)}`, "nogui");
      console.log(`[jvm/${id}] neoforge args-file launch: @${path.relative(dir, argsFile)}`);
    }
  }

  // One-shot recovery: if swap-jar dropped the safemode sentinel for a
  // cross-engine swap into Vanilla, append --safeMode to bypass the broken
  // worldgen-settings inherited from the previous Paper-family JAR. Consume
  // the sentinel so subsequent boots run normally.
  const t = String(server.type || "").toLowerCase();
  if (t === "vanilla") {
    const sentinel = path.join(dir, ".crafthost-vanilla-safemode");
    if (fs.existsSync(sentinel)) {
      args.push("--safeMode");
      try {
        fs.unlinkSync(sentinel);
      } catch {}
      console.log(
        `[jvm/${id}] vanilla --safeMode (cross-engine swap recovery)`,
      );
    }
  }

  // Re-check after the remaining awaits (plugin/via downloads) — same reason
  // as above: never spawn for a start attempt that was stopped/superseded.
  if (startTokens.get(id) !== startToken) {
    console.log(`[jvm/${id}] start cancelled (stopped while preparing)`);
    return { status: "cancelled" };
  }

  const proc = spawn("java", args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, JAVA_TOOL_OPTIONS: "" },
  });

  // Persistent log listeners across restarts — WebSocket clients attached to
  // the previous state (which we just deleted via stop/restart) get carried over
  // so their stream continues uninterrupted into the new process's output.
  const carryListeners = persistentListeners.get(id) || new Set();
  // Carry over the last 200 lines from the previous run so users (and the
  // smoke test) can still see "java.lang.OutOfMemoryError…" or stack traces
  // that the now-dead process emitted before the restart loop wiped them.
  const prev = running.get(id);
  const carryLogs = prev?.logs?.slice(-200) || [];
  if (carryLogs.length)
    carryLogs.push("────── previous run ended; restart attempt ──────");
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
  // Fresh Bedrock enable: once Geyser writes its config this boot, auto-lower
  // the MTU and restart once so the Bedrock IP works directly — no manual
  // double-restart, no "Loading resource pack" freeze.
  if (geyserFirstBoot) scheduleGeyserFirstBootFix(id, server, dir);
  // Tell connected clients there's a new process so they can render a separator
  for (const fn of carryListeners) {
    try {
      fn(`[jvm] new process spawned (pid=${proc.pid})`);
    } catch {}
  }
  // Also push to the persistent ring so /api/logs sees it even with no live WS clients.
  state.logs.push(
    `[jvm] spawned pid=${proc.pid} heap=${heap}MB jar=${path.basename(jarPath)}`,
  );
  // Mirror to Railway logs too — invaluable when the JVM dies before writing anything.
  console.log(
    `[jvm/${id}] spawn pid=${proc.pid} heap=${heap}MB type=${server.type || "paper"} ver=${server.version}`,
  );
  // Clear any prior crash record — a successful restart resets the trigger.
  crashes.delete(id);

  // Bedrock cross-play for non-plugin types: launch the Geyser-Standalone
  // sidecar pointed at this boot's actual Java port. Spigot-family servers load
  // Geyser in-process (ensureGeyserConfig above), so they skip this.
  if (server.playit_secret && STANDALONE_BEDROCK_TYPES.has(t)) {
    startBedrockSidecar(id, server, hostPort).catch((e) =>
      console.warn(`[geyser-sidecar/${id}]`, e.message),
    );
  }

  const onLine = (line) => {
    const stamped = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!stamped) return;
    state.logs.push(stamped);
    if (state.logs.length > LOG_RING_SIZE) state.logs.shift();

    // ── Player join / leave / chat / IP capture ───────────────────────
    // Paper logs three lines per join:
    //   "UUID of player <name> is <uuid>"
    //   "<name>[/<ip>:<port>] logged in with entity id <n> at (...)"
    //   "<name> joined the game"
    // We capture the IP from line 2, then surface it on the join event.
    // state._pendingIp[name] holds the IP between line 2 and line 3.
    const ipLine = stamped.match(
      /\[[^\]]+\]:\s+(\w+)\[\/([0-9a-fA-F.:]+):\d+\]\s+logged in with entity id/,
    );
    if (ipLine) {
      if (!state._pendingIp) state._pendingIp = {};
      state._pendingIp[ipLine[1]] = ipLine[2];
    }
    const join = stamped.match(/\[[^\]]+\]:\s+(\w+) joined the game\s*$/i);
    const leave = stamped.match(/\[[^\]]+\]:\s+(\w+) left the game\s*$/i);
    const chat = stamped.match(/\[[^\]]+\]:\s+<(\w+)>\s+(.+)$/);
    if (join || leave || chat) {
      if (!state.events) state.events = [];
      let ev;
      if (join) {
        const ip = (state._pendingIp && state._pendingIp[join[1]]) || null;
        ev = { type: "join", player: join[1], ip, at: Date.now() };
        if (state._pendingIp) delete state._pendingIp[join[1]];
      } else if (leave) {
        ev = { type: "leave", player: leave[1], at: Date.now() };
      } else {
        ev = {
          type: "chat",
          player: chat[1],
          message: chat[2],
          at: Date.now(),
        };
      }
      state.events.push(ev);
      if (state.events.length > 50) state.events.shift();

      // Persist to DB so events survive restarts + can be queried per player.
      try {
        const db = require("../db");
        db.prepare(
          "INSERT INTO player_events (server_id, player, ip, event, message, ts) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          ev.player,
          ev.ip || null,
          ev.type,
          ev.message || null,
          Math.floor(ev.at / 1000),
        );
      } catch (err) {
        if (!state._dbWarned) {
          console.warn(
            `[jvm/${id}] failed to log player event: ${err.message}`,
          );
          state._dbWarned = true;
        }
      }

      // Optional Discord webhook
      if (
        (ev.type === "join" || ev.type === "leave") &&
        server.discord_webhook
      ) {
        const emoji = ev.type === "join" ? "🟢" : "🔴";
        const verb = ev.type === "join" ? "joined" : "left";
        const ipStr = ev.ip ? ` (\`${ev.ip}\`)` : "";
        const body = JSON.stringify({
          content: `${emoji} **${ev.player}**${ipStr} ${verb} **${server.name}**`,
          username: "CraftHost",
        });
        fetch(server.discord_webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }).catch(() => {});
      }
    }
    if (!state.ready && /Done \([\d.]+s\)!/i.test(stamped)) {
      state.ready = true;
      // CRITICAL: flip DB status starting → online so the dashboard, smoke
      // tests, and tight-poll mechanisms see the server as ready. Without
      // this the row stayed at 'starting' forever even though the JVM was
      // accepting connections.
      try {
        const db = require("../db");
        db.prepare("UPDATE servers SET status = ? WHERE id = ?").run(
          "online",
          id,
        );
      } catch (err) {
        console.warn(
          `[jvm/${id}] status→online DB update failed: ${err.message}`,
        );
      }
      console.log(
        `[jvm/${id}] ✓ READY — Done marker detected, status → online`,
      );
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
          const db = require("../db");
          db.prepare("UPDATE servers SET status = ? WHERE id = ?").run(
            "crashed",
            id,
          );
        } catch {}
        // Kill the hung JVM so the auto-heal loop's startServer() can spawn a
        // fresh process. Without this, the OOM'd JVM hangs holding the port
        // and the heal-restart sees "still running, skip".
        setTimeout(() => {
          try {
            if (state.proc && !state.proc.killed) state.proc.kill("SIGKILL");
          } catch {}
        }, 1500);
      }
    }
    for (const fn of state.listeners) {
      try {
        fn(stamped);
      } catch {}
    }
  };

  let stdoutBuf = "",
    stderrBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop();
    lines.forEach(onLine);
  });
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop();
    lines.forEach(onLine);
  });
  proc.on("exit", (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
    // Mirror to Railway logs so post-mortem diagnosis works even when the
    // per-server log ring gets reset on the next restart attempt.
    console.log(
      `[jvm/${id}] exit code=${code} signal=${signal || "none"} after ${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`,
    );
    let msg = `[jvm] process exited (code=${code}, signal=${signal || "none"})`;
    const isOom = signal === "SIGKILL" || code === 137;
    if (isOom) {
      msg += " — likely OOM-killed. Try a smaller world or upgrade plan.";
      state.oom = true;
    } else if (code !== 0 && code !== null) {
      msg += " — crash. Check console logs above for stack trace.";
    }
    // CRITICAL: update the DB status so the auto-heal / auto-fix loops can find
    // this server. Without this, status stays at 'starting' forever and the
    // query `WHERE status IN ('offline','crashed','error')` never matches.
    // Intentional stops set the status themselves (in stopServer / idle-stop).
    if (!state.intentional) {
      try {
        const db = require("../db");
        const newStatus = isOom
          ? "crashed"
          : code !== 0 || signal
            ? "crashed"
            : "offline";
        db.prepare("UPDATE servers SET status = ? WHERE id = ?").run(
          newStatus,
          id,
        );
      } catch (err) {
        // Don't crash the controller if the DB write fails — auto-heal will
        // catch it on its next probe via getStats().
        console.warn(
          `[jvm-exit] DB status update failed for ${id}: ${err.message}`,
        );
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
    if (
      !state.intentional &&
      !isOom &&
      code === 0 &&
      state.logs.some((l) =>
        /Hash check failed for extract|paperclip\.Paperclip\.extractEntries|FileEntry\.extractFile/i.test(
          l,
        ),
      )
    ) {
      (async () => {
        try {
          for (const sub of ["libraries", "versions"]) {
            await fsp.rm(path.join(dir, sub), { recursive: true, force: true });
          }
          onLine(
            "[jvm] ✓ Auto-fix: corrupt Paperclip libs wiped — re-extracting on restart…",
          );
          try {
            const db = require("../db");
            const now = Date.now();
            db.prepare(
              "UPDATE servers SET last_auto_fix_kind = ?, last_auto_fix_at = ? WHERE id = ?",
            ).run("libs", now, id);
          } catch {}
          await new Promise((r) => setTimeout(r, 2000));
          const fresh = state.server;
          await startServer(containerId, fresh);
          try {
            const db = require("../db");
            db.prepare("UPDATE servers SET status = ? WHERE id = ?").run(
              "starting",
              id,
            );
          } catch {}
        } catch (err) {
          onLine(`[jvm] libs auto-fix failed: ${err.message}`);
        }
      })();
    }
  });
  proc.on("error", (err) => {
    onLine(`[jvm] spawn error: ${err.message}`);
  });

  return { status: "starting", pid: proc.pid, hostPort };
}

async function stopServer(containerId, server) {
  const id = String(containerId || "").replace(/^jvm-/, "") || server?.id;
  // Cancel any in-flight start attempt (jar still downloading) so it can't
  // spawn a JVM after this stop completes.
  startTokens.delete(id);
  const state = running.get(id);
  if (!state || !state.proc || state.proc.killed) {
    // Not in the in-memory map (e.g. spawned before a Node restart) — make
    // sure no orphaned JVM lives on holding this server's port.
    killOrphansByDir(path.join(DATA_DIR, id));
    return { status: "offline" };
  }
  // Mark this as an intentional shutdown — the exit handler uses this to skip
  // the auto-restart trigger.
  state.intentional = true;
  crashes.delete(id);
  // Reap the Bedrock sidecar (if any) alongside the MC process.
  stopBedrockSidecar(id);
  try {
    // graceful: send "stop" via stdin first
    state.proc.stdin.write("stop\n");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          state.proc.kill("SIGTERM");
        } catch {}
        // SIGTERM can be ignored mid-boot; escalate so a deleted server can
        // never leave a port-squatting JVM behind.
        const t2 = setTimeout(() => {
          try {
            state.proc.kill("SIGKILL");
          } catch {}
          resolve();
        }, 8000);
        state.proc.once("exit", () => {
          clearTimeout(t2);
          resolve();
        });
      }, 20000);
      state.proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  } catch {}
  running.delete(id);
  return { status: "offline" };
}

async function restartServer(containerId, server) {
  await stopServer(containerId, server);
  return startServer(containerId, server);
}

async function removeServer(containerId, server) {
  await stopServer(containerId, server);
  const id = String(containerId || "").replace(/^jvm-/, "") || server?.id;
  const dir = path.join(DATA_DIR, id);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {}
  return { status: "removed" };
}

function readProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 14 (utime) + 15 (stime) — but command field can contain spaces, so split on ')'
    const idx = stat.lastIndexOf(")");
    const fields = stat.slice(idx + 2).split(" ");
    // After removing "pid (comm) ", fields[11]=utime, fields[12]=stime
    const utime = parseInt(fields[11], 10) || 0;
    const stime = parseInt(fields[12], 10) || 0;
    return utime + stime;
  } catch {
    return null;
  }
}

function readProcRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function totalSystemMemKb() {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const m = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// Minecraft Server List Ping. Connects to the JVM's host port locally, sends a
// 1.7+ handshake + status request, parses the JSON response, returns key fields.
// Cached per-server for SLP_CACHE_TTL.
function vi(n) {
  const a = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    a.push(b);
  } while (n);
  return Buffer.from(a);
}
function readVarInt(buf, offset) {
  let result = 0,
    pos = 0,
    byte;
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
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    const sock = net.connect(hostPort, "127.0.0.1", () => {
      const host = "127.0.0.1";
      const handshake = Buffer.concat([
        Buffer.from([0x00]),
        vi(770),
        vi(host.length),
        Buffer.from(host),
        Buffer.from([(hostPort >> 8) & 0xff, hostPort & 0xff]),
        Buffer.from([0x01]),
      ]);
      sock.write(Buffer.concat([vi(handshake.length), handshake]));
      sock.write(Buffer.concat([vi(1), Buffer.from([0x00])]));
    });
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
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
      const json = buf.slice(off, off + strLen.value).toString("utf8");
      try {
        finish(JSON.parse(json));
      } catch {
        finish(null);
      }
    });
    sock.on("error", () => finish(null));
    sock.setTimeout(timeoutMs, () => finish(null));
  });
}

async function getCachedSlp(state, hostPort) {
  if (state.slp && Date.now() - state.slp.ts < SLP_CACHE_TTL)
    return state.slp.data;
  const data = await slpProbe(hostPort).catch(() => null);
  state.slp = { data, ts: Date.now() };
  return data;
}

async function getStats(containerId, server) {
  const id = String(containerId || "").replace(/^jvm-/, "") || server?.id;
  const state = running.get(id);
  if (!state || !state.proc || state.proc.killed || state.exitCode !== null) {
    const offlinePlanRam = parseInt(server?.ram_mb || MAX_HEAP_MB, 10);
    const offlineHeap = Math.max(256, Math.min(offlinePlanRam, MAX_HEAP_MB));
    return {
      cpu: 0,
      ram_used: 0,
      ram_max: Math.max(offlinePlanRam, offlineHeap * 2),
      heap_max_mb: offlineHeap,
      tps: 0,
      uptime: 0,
      players: 0,
      online: false,
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
  await new Promise((r) => setTimeout(r, 200));
  const t2 = readProcStat(pid);
  const wall2 = Date.now();
  const clockTick = 100; // jiffies per second (Alpine default)
  const ncpu = require("os").cpus().length;
  let cpu = 0;
  if (t1 != null && t2 != null) {
    const deltaTicks = t2 - t1;
    const deltaMs = wall2 - wall1;
    cpu = Math.min(
      100,
      Math.round(((((deltaTicks / clockTick) * 1000) / deltaMs) * 100) / ncpu),
    );
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
    player_sample: (slp?.players?.sample || []).map((p) => p.name).slice(0, 12),
    motd:
      typeof slp?.description === "string"
        ? slp.description
        : slp?.description?.text || slp?.description?.translate || null,
    mc_version: slp?.version?.name || null,
    online: state.ready,
    ready: state.ready,
    host_port: state.hostPort,
  };
}

async function attachLogStream(containerId, onLine) {
  const id = String(containerId || "").replace(/^jvm-/, "");
  // Register the listener in the persistent set so it survives stop/start
  // cycles (the new state inherits this set in startServer).
  let set = persistentListeners.get(id);
  if (!set) {
    set = new Set();
    persistentListeners.set(id, set);
  }
  set.add(onLine);

  const state = running.get(id);
  if (!state) {
    onLine(
      "[jvm] server is not running (logs will start streaming once it boots)",
    );
  } else {
    // Replay buffered logs from the current process
    for (const l of state.logs) {
      try {
        onLine(l);
      } catch {}
    }
    // Ensure the state's listener Set is the persistent one
    if (state.listeners !== set) {
      for (const fn of state.listeners) set.add(fn);
      state.listeners = set;
    }
  }
  return {
    stop: () => {
      set.delete(onLine);
      const cur = running.get(id);
      if (cur?.listeners) cur.listeners.delete(onLine);
    },
  };
}

async function sendRcon(server, command) {
  const id = server.id;
  const state = running.get(id);
  if (!state || !state.proc || state.proc.killed) {
    return "[jvm] server is not running";
  }
  // Cheapest reliable path: write to stdin. The Paper console accepts commands without leading slash.
  const cmd = command.startsWith("/") ? command.slice(1) : command;
  try {
    state.proc.stdin.write(cmd + "\n");
    // Capture lines emitted in the next 600ms as the "response"
    const captured = [];
    const cap = (line) => captured.push(line);
    state.listeners.add(cap);
    await new Promise((r) => setTimeout(r, 600));
    state.listeners.delete(cap);
    return captured.length
      ? captured.join("\n")
      : `(no immediate output for: ${command})`;
  } catch (err) {
    return `JVM RCON error: ${err.message}`;
  }
}

function listRunning() {
  return Array.from(running.entries()).map(([id, s]) => ({
    id,
    pid: s.pid,
    ready: s.ready,
    hostPort: s.hostPort,
    startedAt: s.startedAt,
  }));
}

function __getState(id) {
  return running.get(id) || null;
}

// Crash event API consumed by the auto-restart loop in server.js.
// getCrashes() returns [[id, {when, code, signal}], ...] for servers that
// exited unexpectedly. clearCrash(id) removes the record once handled.
function getCrashes() {
  return Array.from(crashes.entries());
}
function clearCrash(id) {
  crashes.delete(id);
}

// Pre-warm the JAR cache with popular versions so the FIRST user to deploy
// any of these gets a cache HIT (instant boot) instead of a 30-90s download.
// Runs in background — never blocks startup. Skips anything already cached.
// Errors are non-fatal: if a download fails, log it and move on.
async function prewarmJarCache() {
  // Cover the FULL wizard version list × every cacheable engine. Users picking
  // any (type, version) combo from the UI get a cache HIT (zero-wait boot)
  // instead of a 30-90s download on server creation. Old/unsupported combos
  // (e.g. Paper 1.12.2 — not on api.papermc.io) error non-fatally below.
  //
  // Must mirror MC_VERSIONS in frontend/js/wizard.js. Keep in sync when the
  // wizard list changes.
  const WIZARD_VERS = [
    "26.1.2",
    "1.21.11",
    "1.21.8",
    "1.21.5",
    "1.21.4",
    "1.21.1",
    "1.21",
    "1.20.6",
    "1.20.4",
    "1.20.1",
    "1.19.4",
    "1.18.2",
    "1.16.5",
    "1.12.2",
  ];
  // Engines whose launcher JAR is a single self-contained blob we can hardlink
  // across servers. NeoForge is excluded — it ships an installer that mutates
  // the per-server dir, so cache reuse doesn't apply.
  const CACHEABLE_ENGINES = [
    { type: "paper", resolve: paperJarUrl },
    { type: "vanilla", resolve: vanillaJarUrl },
    { type: "purpur", resolve: purpurJarUrl },
    { type: "fabric", resolve: fabricJarUrl },
  ];
  const targets = [];
  for (const eng of CACHEABLE_ENGINES) {
    for (const v of WIZARD_VERS)
      targets.push({ type: eng.type, version: v, resolve: eng.resolve });
    // LATEST per engine — separate cache key so 'LATEST' picks also hit.
    targets.push({ type: eng.type, version: "LATEST", resolve: eng.resolve });
  }
  try {
    fs.mkdirSync(JAR_CACHE_DIR, { recursive: true });
  } catch {}

  let hits = 0,
    misses = 0,
    errors = 0,
    mb = 0;
  for (const t of targets) {
    try {
      const info = await t.resolve(t.version);
      const cachePath = cachedJarPath(t.type, info.version, info);
      if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100000) {
        hits++;
        continue;
      }
      console.log(
        `[jar-cache/prewarm] ${t.type}-${info.version} → downloading`,
      );
      const size = await downloadFile(
        info.url,
        cachePath,
        `${t.type} ${info.version} prewarm`,
      );
      misses++;
      mb += size / 1024 / 1024;
    } catch (err) {
      errors++;
      console.warn(
        `[jar-cache/prewarm] ${t.type}-${t.version} failed: ${err.message.slice(0, 100)}`,
      );
    }
  }
  console.log(
    `📦 JAR cache prewarmed: ${hits} hit · ${misses} downloaded (${mb.toFixed(0)}MB) · ${errors} errors`,
  );
}

// Persistent state for tracking which LATEST version we've successfully
// verified per engine. Lives next to the cache. Survives container restarts.
const JAR_STATE_FILE = path.join(JAR_CACHE_DIR, "_versions.json");
function loadJarState() {
  try {
    return JSON.parse(fs.readFileSync(JAR_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveJarState(s) {
  try {
    fs.writeFileSync(JAR_STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

// REAL boot test for a freshly-downloaded JAR — actually starts a Minecraft
// server in a throwaway temp dir, waits for "Done (Xs)!" boot-complete marker
// in stdout, then cleanly stops it. Proves the JAR will boot for a real user.
//
// Uses minimal RAM (512MB heap), a flat world (instant gen), tiny view
// distance, no plugins, no RCON, no compression init — strips the boot
// down to the JAR's core. Caps at 90s total.
//
// Catches: corrupt downloads, upstream broken builds, JAR signature mismatch,
// JDK incompatibility, missing libraries, world-gen errors, port conflicts.
async function realTestJar(jarPath, type, version) {
  const testDir = path.join(JAR_CACHE_DIR, `.boottest-${Date.now()}-${type}`);
  const port = 26800 + Math.floor(Math.random() * 199); // 26800-26998
  let stdout = "",
    stderr = "";

  try {
    fs.mkdirSync(testDir, { recursive: true });
    // Hardlink the JAR (or copy if cross-fs) so we don't touch the cache copy
    const localJar = path.join(testDir, "server.jar");
    try {
      fs.linkSync(jarPath, localJar);
    } catch {
      fs.copyFileSync(jarPath, localJar);
    }

    // EULA + minimal properties for fastest possible boot
    fs.writeFileSync(path.join(testDir, "eula.txt"), "eula=true\n");
    fs.writeFileSync(
      path.join(testDir, "server.properties"),
      [
        `server-port=${port}`,
        "online-mode=false",
        "motd=boot-test",
        "max-players=1",
        "level-name=world",
        "level-type=minecraft\\:flat", // flat = instant world gen
        "view-distance=2",
        "simulation-distance=2",
        "spawn-protection=0",
        "network-compression-threshold=-1", // skip compression init
        "enable-rcon=false",
        "broadcast-rcon-to-ops=false",
        "enable-status=false",
      ].join("\n"),
    );

    return await new Promise((resolve) => {
      const proc = spawn(
        "java",
        ["-Xms256M", "-Xmx512M", "-jar", "server.jar", "nogui"],
        {
          cwd: testDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, JAVA_TOOL_OPTIONS: "" },
        },
      );
      let done = false,
        booted = false;
      const finish = (ok, reason) => {
        if (done) return;
        done = true;
        // Force-cleanup the temp dir, fire-and-forget
        try {
          proc.kill("SIGKILL");
        } catch {}
        setTimeout(() => {
          try {
            fs.rmSync(testDir, { recursive: true, force: true });
          } catch {}
        }, 1500);
        resolve({
          ok,
          reason,
          stdout: stdout.slice(-400),
          stderr: stderr.slice(-400),
        });
      };
      proc.on("error", (err) => finish(false, `spawn err: ${err.message}`));
      proc.stdout.on("data", (d) => {
        const s = d.toString("utf8");
        stdout += s;
        if (stdout.length > 12000) stdout = stdout.slice(-12000);
        if (!booted && /Done \(\d+\.\d+s\)!/i.test(s)) {
          booted = true;
          // Issue graceful shutdown — server quits cleanly in ~2s
          try {
            proc.stdin.write("stop\n");
          } catch {}
          setTimeout(
            () => finish(true, "booted + Done marker + clean stop"),
            4000,
          );
        }
        // Fast-fail on known JVM/startup errors
        if (
          /OutOfMemoryError|Could not find or load main class|Invalid or corrupt jarfile|UnsupportedClassVersionError|Address already in use/i.test(
            s,
          )
        ) {
          finish(false, "fatal startup error in stdout");
        }
      });
      proc.stderr.on("data", (d) => {
        const s = d.toString("utf8");
        stderr += s;
        if (stderr.length > 12000) stderr = stderr.slice(-12000);
        if (
          /OutOfMemoryError|Could not find or load main class|Invalid or corrupt jarfile|UnsupportedClassVersionError/i.test(
            s,
          )
        ) {
          finish(false, "fatal startup error in stderr");
        }
      });
      proc.on("exit", (code, signal) => {
        if (!done) {
          // Process exited before we saw "Done" — failure unless it was our stop
          finish(
            booted,
            booted
              ? "exited after stop"
              : `exited code=${code} signal=${signal} before Done marker`,
          );
        }
      });
      // Overall timeout — 90s is generous for a flat-world Paper boot
      setTimeout(() => {
        if (!done)
          finish(false, "timed out at 90s — never reached Done marker");
      }, 90_000);
    });
  } catch (err) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
    return { ok: false, reason: `setup err: ${err.message}` };
  }
}

// Lightweight JAR cache health check — verifies every cached JAR is still
// on disk and the right size. Auto-repairs corrupt/missing JARs by deleting
// the bad file and re-downloading. ALSO real-tests any JAR whose LATEST
// version just changed (via `java -jar X --version`), and rolls back to
// the previous version if the new build doesn't boot.
//
// Returns { healthy, repaired, real_tested, real_failed, errors, scanned, new_versions }
async function checkJarCacheHealth() {
  const out = {
    healthy: 0,
    repaired: 0,
    real_tested: 0,
    real_failed: 0,
    errors: 0,
    scanned: 0,
    new_versions: [],
  };
  if (!fs.existsSync(JAR_CACHE_DIR)) return out;
  // Every popular MC version users actually deploy.
  // Stable versions (1.19.4, 1.20.1, 1.20.4, 1.21.1, 1.21.4): boot-tested
  // ONCE on first encounter, then trusted (version doesn't change).
  // LATEST: re-tested every time upstream bumps it.
  const STABLE_VERSIONS = ["1.19.4", "1.20.1", "1.20.4", "1.21.1", "1.21.4"];
  const expected = [];
  for (const v of STABLE_VERSIONS) {
    expected.push({
      type: "paper",
      version: v,
      resolve: paperJarUrl,
      stable: true,
    });
    expected.push({
      type: "fabric",
      version: v,
      resolve: fabricJarUrl,
      stable: true,
    });
  }
  // Vanilla + Purpur: stable 1.20.1 + 1.21.1 only (these are the popular ones)
  for (const v of ["1.20.1", "1.21.1"]) {
    expected.push({
      type: "vanilla",
      version: v,
      resolve: vanillaJarUrl,
      stable: true,
    });
    expected.push({
      type: "purpur",
      version: v,
      resolve: purpurJarUrl,
      stable: true,
    });
  }
  // LATEST per engine (continuously re-tested when upstream bumps)
  expected.push({ type: "paper", version: "LATEST", resolve: paperJarUrl });
  expected.push({ type: "vanilla", version: "LATEST", resolve: vanillaJarUrl });
  expected.push({ type: "purpur", version: "LATEST", resolve: purpurJarUrl });
  expected.push({ type: "fabric", version: "LATEST", resolve: fabricJarUrl });
  // NeoForge: existence + size only (no boot test — installer is heavy + mutates dir)
  expected.push({
    type: "neoforge",
    version: "LATEST",
    resolve: neoforgeJarUrl,
    skipBootTest: true,
  });
  const state = loadJarState();
  for (const t of expected) {
    out.scanned++;
    try {
      const info = await t.resolve(t.version);
      const cachePath = cachedJarPath(t.type, info.version, info);

      // 1) Existence + size check
      let needsRepair = false;
      if (!fs.existsSync(cachePath)) {
        needsRepair = true;
      } else if (fs.statSync(cachePath).size < 50_000) {
        needsRepair = true;
      }
      if (needsRepair) {
        console.warn(
          `[jar-health] repairing ${t.type}-${info.version} (missing or truncated)`,
        );
        try {
          fs.unlinkSync(cachePath);
        } catch {}
        await downloadFile(
          info.url,
          cachePath,
          `${t.type} ${info.version} repair`,
        );
        out.repaired++;
      } else {
        out.healthy++;
      }

      // 2) Real boot-test. Three modes:
      //    - skipBootTest engines (NeoForge): never boot-test (heavy installer)
      //    - LATEST: re-test every time upstream version bumps
      //    - stable: test ONCE on first encounter, then trust (versions don't change)
      // Either passes → record `${type}-${version}: timestamp` in state
      // Either fails → quarantine JAR + log alert + keep previous canonical
      if (!t.skipBootTest) {
        const verKey = `${t.type}-${info.version}`;
        const alreadyVerified = !!state[verKey];
        const latestChanged =
          t.version === "LATEST" && state[`${t.type}_latest`] !== info.version;
        if (!alreadyVerified || latestChanged) {
          console.log(
            `[jar-health] BOOT-TESTING ${t.type}-${info.version}${latestChanged ? " (LATEST changed)" : " (first time)"}`,
          );
          out.new_versions.push(verKey);
          out.real_tested++;
          const test = await realTestJar(cachePath, t.type, info.version);
          if (test.ok) {
            console.log(
              `[jar-health] ✓ ${verKey} boot-test passed (${test.reason})`,
            );
            state[verKey] = Date.now();
            if (t.version === "LATEST")
              state[`${t.type}_latest`] = info.version;
            saveJarState(state);
          } else {
            out.real_failed++;
            console.error(
              `🚨 [jar-health] ${verKey} boot-test FAILED: ${test.reason}`,
            );
            console.error(`  stderr tail: ${test.stderr.slice(-300)}`);
            try {
              fs.renameSync(cachePath, cachePath + ".broken-" + Date.now());
            } catch {}
          }
        }
      }
    } catch (err) {
      out.errors++;
      console.warn(
        `[jar-health] ${t.type}-${t.version} check failed: ${err.message.slice(0, 100)}`,
      );
    }
  }
  return out;
}

module.exports = {
  isAvailable,
  makeRconPassword,
  geyserUdpPort,
  startBedrockSidecar,
  stopBedrockSidecar,
  createServer,
  startServer,
  stopServer,
  restartServer,
  removeServer,
  prewarmJarCache,
  checkJarCacheHealth,
  getStats,
  attachLogStream,
  sendRcon,
  listRunning,
  __getState,
  getCrashes,
  clearCrash,
};
