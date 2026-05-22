require('dotenv').config();

// ─── EMERGENCY PRE-BOOT LOG PURGE ───────────────────────────────────────────
// Runs SYNCHRONOUSLY before any DB import, before any other code. If the
// volume is ENOSPC-full, the SQLite open will fail because it can't write WAL
// pages. Aggressively wipe every server's logs/, cache/, crash-reports/ to
// reclaim disk so the rest of boot can proceed. Only runs when volume free <
// 200 MB (so it doesn't punish healthy boots). Set EMERGENCY_PURGE=0 to disable.
if (process.env.EMERGENCY_PURGE !== '0') {
  try {
    const fsSync = require('fs');
    const pathBoot = require('path');
    const { statfsSync } = fsSync;
    const DATA_DIR_BOOT = process.env.DATA_DIR || pathBoot.resolve(__dirname, '../data/servers');
    const VOLUME_ROOT_BOOT = pathBoot.dirname(DATA_DIR_BOOT);
    let freeMb = 9999;
    try {
      const s = statfsSync(VOLUME_ROOT_BOOT);
      freeMb = Math.round((s.bavail * s.bsize) / 1024 / 1024);
    } catch {}
    if (freeMb < 200) {
      console.log(`🚨 EMERGENCY PURGE: only ${freeMb}MB free on ${VOLUME_ROOT_BOOT} — wiping logs/cache/crash-reports across all servers`);
      let freed = 0, hits = 0;
      const PURGE = ['logs', 'cache', 'crash-reports'];
      function dirSizeSync(p) { let t = 0; try { const st = fsSync.statSync(p); if (st.isFile()) t = st.size; else if (st.isDirectory()) { for (const c of fsSync.readdirSync(p)) t += dirSizeSync(pathBoot.join(p, c)); } } catch {} return t; }
      try {
        const dirs = fsSync.readdirSync(DATA_DIR_BOOT, { withFileTypes: true });
        for (const e of dirs) {
          if (!e.isDirectory() || !/^[0-9a-f]{16}$/.test(e.name)) continue;
          const root = pathBoot.join(DATA_DIR_BOOT, e.name);
          for (const d of PURGE) {
            const sub = pathBoot.join(root, d);
            const sz = dirSizeSync(sub);
            if (sz > 0) { try { fsSync.rmSync(sub, { recursive: true, force: true }); freed += sz; hits++; } catch {} }
          }
        }
      } catch (err) { console.warn('[emergency-purge] readdir failed:', err.message); }
      // Also clean /tmp and volume/tmp
      for (const tmpDir of ['/tmp', pathBoot.join(VOLUME_ROOT_BOOT, 'tmp')]) {
        try {
          for (const f of fsSync.readdirSync(tmpDir)) {
            const full = pathBoot.join(tmpDir, f);
            try { const st = fsSync.statSync(full); if (st.isFile() && Date.now() - st.mtimeMs > 5 * 60_000) { freed += st.size; fsSync.unlinkSync(full); hits++; } } catch {}
          }
        } catch {}
      }
      console.log(`🚨 EMERGENCY PURGE freed ${Math.round(freed/1024/1024)}MB across ${hits} items — boot continuing`);
    }
  } catch (err) {
    console.warn('[emergency-purge] failed (continuing anyway):', err.message);
  }
}

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');

const db = require('./db');
const dc = require('./lib/controller');
const dockerCtl = require('./lib/docker-controller');
const jvmCtl = require('./lib/jvm-controller');
const { verifyToken } = require('./lib/auth');

const app = express();
const server = http.createServer(app);

// Trust Railway's proxy so req.ip + secure cookies work correctly behind their TLS terminator
app.set('trust proxy', 1);

// Security
app.use(helmet({
  // Strict CSP that allows our own assets + Google Fonts + Modrinth icons (used by marketplace).
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // inline scripts used by per-page <script> blocks
      scriptSrcAttr: ["'unsafe-inline'"], // onclick="..." handlers across the UI
      styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'cdn.modrinth.com', '*.modrinth.com', '*.papermc.io'],
      connectSrc: ["'self'", 'wss:', 'https:', 'api.modrinth.com', 'api.papermc.io', 'launchermeta.mojang.com', 'meta.fabricmc.net', 'api.purpurmc.org', 'maven.neoforged.net'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 60 * 60 * 24 * 365, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Per-user OR per-IP rate limiter. Authenticated users key by user id; unauthed by IP.
// IPv6 must use ipKeyGenerator helper or express-rate-limit refuses to start.
function userKey(req, res) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|; )token=([^;]+)/);
  if (m) {
    try {
      const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64').toString('utf8'));
      if (payload?.id) return `u:${payload.id}`;
    } catch {}
  }
  return `ip:${ipKeyGenerator(req, res)}`;
}

const apiLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userKey,
});
app.use('/api', apiLimit);

const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req, res) => `ip:${ipKeyGenerator(req, res)}`,
});
app.use('/api/auth/register', authLimit);
app.use('/api/auth/login', authLimit);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/servers/:id/files', require('./routes/files'));
app.use('/api/servers/:id/plugins', require('./routes/plugins'));
app.use('/api/servers/:id/backups', require('./routes/backups'));
app.use('/api/jars', require('./routes/jars'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/versions', require('./routes/versions'));
app.use('/api/modrinth', require('./routes/modrinth'));

// Cached boot timestamp so /api/status can show platform uptime
const BOOT_TS = Date.now();

app.get('/api/health', async (req, res) => {
  const dockerOk = await dockerCtl.isDockerAvailable();
  const jvmOk = jvmCtl.isAvailable();
  const backend = await dc.backendName();

  // Disk view from INSIDE the container. Railway's dashboard metric can lag
  // behind reality; this is the truth as the JVM sees it when writing files.
  let disk = null;
  try {
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR = process.env.DATA_DIR || '/data';
    const stat = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
    if (stat) {
      const total = stat.blocks * stat.bsize;
      const free  = stat.bavail * stat.bsize;
      disk = {
        mount: DATA_DIR,
        total_mb: Math.round(total / 1024 / 1024),
        free_mb:  Math.round(free  / 1024 / 1024),
        used_mb:  Math.round((total - free) / 1024 / 1024),
        used_pct: total ? Math.round(((total - free) / total) * 100) : 0,
        inodes_total: stat.files,
        inodes_free:  stat.ffree,
      };
    }
    // List the JAR cache so we can spot a truncated download.
    const CACHE_DIR = path.join(path.dirname(DATA_DIR), '.jar-cache');
    if (fs.existsSync(CACHE_DIR)) {
      disk.jar_cache = fs.readdirSync(CACHE_DIR).map(f => {
        try {
          const st = fs.statSync(path.join(CACHE_DIR, f));
          return { name: f, mb: Math.round(st.size / 1024 / 1024 * 10) / 10 };
        } catch { return { name: f, mb: 0 }; }
      });
    }
  } catch (err) { disk = { error: err.message }; }

  res.json({
    ok: true,
    docker: dockerOk,
    jvm: jvmOk,
    backend,
    db: true,
    ts: Date.now(),
    uptime: Date.now() - BOOT_TS,
    disk,
    public_mc_port: parseInt(process.env.PUBLIC_MC_PROXY_PORT || process.env.MC_PORT || '25565', 10),
    public_mc_host: process.env.PUBLIC_MC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN || null,
  });
});

// Public status endpoint — used by /status.html. No auth, aggregates platform-
// wide stats. Cheap query: counts + last boot.
app.get('/api/status', async (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) AS c FROM servers').get().c;
    const running = db.prepare(`SELECT COUNT(*) AS c FROM servers WHERE status IN ('online','running','starting')`).get().c;
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    // Recent audit events (last 24h) — used to render "incident history" timeline
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    const events24h = db.prepare(`
      SELECT action, COUNT(*) AS n FROM audit_log
      WHERE created_at >= ?
      GROUP BY action
      ORDER BY n DESC LIMIT 12
    `).all(cutoff);
    // Live JVM stats — sum players across running servers (best-effort, may be 0 if probes flaky)
    let totalPlayers = 0;
    const onlineServers = db.prepare(`SELECT s.*, p.ram_mb FROM servers s JOIN plans p ON s.plan_id = p.id WHERE s.status IN ('online','running') AND s.container_id LIKE 'jvm-%' LIMIT 20`).all();
    for (const s of onlineServers) {
      try { const st = await dc.getStats(s); totalPlayers += (st?.players || 0); } catch {}
    }
    res.json({
      ok: true,
      uptime_ms: Date.now() - BOOT_TS,
      boot_ts: BOOT_TS,
      counts: { users, servers: total, running, players_online: totalPlayers },
      events_24h: events24h,
      checked_at: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Static frontend — disable caching for HTML so users always pick up the latest UI;
// keep modest caching for JS/CSS/img (revalidated on change since we don't fingerprint).
app.use(express.static(path.join(__dirname, '../frontend'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    }
  },
}));

// SPA fallback (only for clean URLs without an extension). Requests for a
// specific .html file that wasn't matched by express.static are real 404s —
// otherwise deleted pages like /billing.html would silently serve index.html.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (/\.[a-z0-9]+$/i.test(req.path)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// WebSocket for live logs
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (!pathname.startsWith('/ws/servers/')) { socket.destroy(); return; }

  // Auth: token in cookie or ?token=
  const cookieToken = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('token='))?.split('=')[1];
  const token = query.token || cookieToken;
  const payload = token ? verifyToken(token) : null;
  if (!payload) { socket.destroy(); return; }

  const m = pathname.match(/^\/ws\/servers\/([a-f0-9]+)\/logs$/);
  if (!m) { socket.destroy(); return; }
  const serverId = m[1];

  // Enrich with plan info for stats
  const srv = db.prepare(`
    SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.id = ? AND s.user_id = ?
  `).get(serverId, payload.id);
  if (!srv) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, async (ws) => {
    ws.send(JSON.stringify({ type: 'connected', server: srv.name }));
    const attach = await dc.attachLogStream(srv, (line) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'log', line }));
    });

    // Stream stats every 5s
    const statTimer = setInterval(async () => {
      try {
        const s = await dc.getStats(srv);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stats', stats: s }));
      } catch {}
    }, 5000);

    ws.on('close', () => { clearInterval(statTimer); attach.stop?.(); });
  });
});

const PORT = parseInt(process.env.PORT || '4000', 10);
server.listen(PORT, async () => {
  console.log(`✓ CraftHost listening on http://localhost:${PORT}`);
  const backend = await dc.backendName();
  console.log(`✓ Backend: ${backend}`);
  if (backend === 'jvm') console.log(`✓ JVM available; public MC port: ${process.env.MC_PORT || 25565}`);
  if (backend === 'stub') console.log('⚠ No Docker, no Java — stub mode');

  // Auto-promote — if no admin exists yet, make user id=1 an admin so the
  // operator can manage the platform (cleanup, user mgmt, etc.) without
  // running raw SQL. Idempotent.
  try {
    const anyAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
    if (!anyAdmin) {
      const u1 = db.prepare("SELECT id, username FROM users WHERE id = 1").get();
      if (u1) {
        db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u1.id);
        console.log(`👑 Auto-promoted user "${u1.username}" (id=1) to admin — no admin existed.`);
      }
    }
  } catch (err) {
    console.warn('[bootstrap] auto-promote failed:', err.message);
  }

  // Startup janitor — clean orphaned data dirs. Any /data/servers/<id>/ that
  // doesn't match a row in the DB is junk (test residue, deleted-mid-write,
  // stale from prior schema). The DB is the source of truth, so this is safe.
  // Bounded: refuses to delete a dir that looks like real worlds (> 100 MB)
  // without an explicit env JANITOR_AGGRESSIVE=1, to avoid catastrophic loss
  // if the DB ever got truncated.
  try {
    const fsp = require('fs/promises');
    const pathMod = require('path');
    const DATA_DIR = process.env.DATA_DIR || pathMod.resolve(__dirname, '../data/servers');
    const aggressive = process.env.JANITOR_AGGRESSIVE === '1';
    let entries;
    try { entries = await fsp.readdir(DATA_DIR, { withFileTypes: true }); }
    catch { entries = []; }
    const knownIds = new Set(db.prepare('SELECT id FROM servers').all().map(r => r.id));
    let removed = 0, kept = 0, skippedBig = 0, freed = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (knownIds.has(e.name)) { kept++; continue; }
      // Only delete 16-hex-char dirs (matches our server id format). Skip
      // anything else (backups, lost+found, etc.) for safety.
      if (!/^[0-9a-f]{16}$/.test(e.name)) { kept++; continue; }
      const dirPath = pathMod.join(DATA_DIR, e.name);
      // Size check (single os.statSync on the dir itself isn't useful; walk)
      let size = 0;
      async function walkSize(p) {
        try {
          const st = await fsp.stat(p);
          if (st.isFile()) { size += st.size; return; }
          if (st.isDirectory()) {
            const ee = await fsp.readdir(p);
            for (const c of ee) await walkSize(pathMod.join(p, c));
          }
        } catch {}
      }
      await walkSize(dirPath);
      if (size > 100 * 1024 * 1024 && !aggressive) {
        console.warn(`🧹 Janitor: skipping orphan ${e.name} (${Math.round(size/1024/1024)}MB > 100MB threshold; set JANITOR_AGGRESSIVE=1 to delete)`);
        skippedBig++;
        continue;
      }
      try {
        await fsp.rm(dirPath, { recursive: true, force: true });
        removed++;
        freed += size;
      } catch (err) {
        console.warn(`🧹 Janitor: failed to remove ${e.name}: ${err.message}`);
      }
    }
    console.log(`🧹 Janitor: ${kept} kept · ${removed} removed (${Math.round(freed/1024/1024)}MB freed)${skippedBig ? ' · ' + skippedBig + ' skipped (size>100MB)' : ''}`);
  } catch (err) {
    console.warn('[janitor] startup sweep failed:', err.message);
  }

  // Idle-stop loop: stop free-tier servers with 0 players for IDLE_STOP_MINUTES (default 30).
  // Paid plans keep running 24/7. Saves Railway resources without forcing inactive accounts to upgrade.
  // Before stopping, sends `save-all flush` over the JVM's stdin to guarantee the
  // world + player data is flushed to disk so the next /start resumes exactly
  // where players left off. The MC `stop` command also saves, but explicit
  // save-first is belt-and-suspenders against the 20s SIGTERM fallback in stopServer.
  if (backend === 'jvm' && process.env.IDLE_STOP !== '0') {
    const idleMin = parseInt(process.env.IDLE_STOP_MINUTES || '30', 10);
    const lastSeenPlayers = new Map(); // serverId → ts when last had >0 players
    const jvm = require('./lib/jvm-controller');
    setInterval(async () => {
      try {
        const rows = db.prepare(`
          SELECT s.*, p.ram_mb FROM servers s
          JOIN plans p ON s.plan_id = p.id
          WHERE s.status IN ('online','running')
            AND s.plan_id = 'free'
            AND s.container_id LIKE 'jvm-%'
        `).all();
        const now = Date.now();
        for (const s of rows) {
          let stats = null;
          try { stats = await dc.getStats(s); } catch {}
          if (!stats?.online) continue;
          if ((stats.players || 0) > 0) {
            lastSeenPlayers.set(s.id, now);
            continue;
          }
          const last = lastSeenPlayers.get(s.id);
          if (!last) { lastSeenPlayers.set(s.id, now); continue; }
          const idleMs = now - last;
          if (idleMs > idleMin * 60_000) {
            console.log(`💤 Idle-stop: ${s.name} (${s.id}) — 0 players for ${Math.round(idleMs/60000)}min · saving + stopping`);
            try {
              // 1) Explicit save: world chunks, level.dat, player files, stats/, advancements/
              const cid = String(s.container_id || '').replace(/^jvm-/, '') || s.id;
              const state = jvm.__getState ? jvm.__getState(cid) : null;
              if (state?.proc?.stdin && !state.proc.killed) {
                try { state.proc.stdin.write('save-all flush\n'); } catch {}
                try { state.proc.stdin.write('save-off\n'); } catch {}
                // Give the save 3s to flush before stop
                await new Promise(r => setTimeout(r, 3000));
              }
              // 2) Tunnel + graceful stop (sends `stop` via stdin which triggers MC's
              //    own clean shutdown — world saves AGAIN at this point as part of MC's
              //    normal stop sequence). 20s SIGTERM fallback if it hangs.
              const tunnel = require('./lib/tunnel');
              tunnel.stop(s.id);
              await dc.stopServer(s);
              db.prepare('UPDATE servers SET status = ?, last_idle_stop_at = ? WHERE id = ?').run('offline', now, s.id);
              lastSeenPlayers.delete(s.id);
              console.log(`💤 Idle-stop: ${s.name} stopped + world saved · will resume from current state on next /start`);
            } catch (err) {
              console.warn(`[idle-stop] ${s.id} failed:`, err.message);
            }
          }
        }
      } catch (err) { console.warn('[idle-stop] failed:', err.message); }
    }, 60_000);
    console.log(`💤 Idle-stop loop enabled (${idleMin}min idle → save-all flush → stop, free tier only)`);
  }

  // Auto-heal loop: when ANY free-plan server OOMs (heavy MC version, Fabric's
  // heavier boot, modded server, etc.), automatically wipe server.jar, switch
  // to Paper 1.20.1 (the proven-safe combo for the 480MB heap), and restart.
  // Doesn't touch already-on-Paper-1.20.1 servers (those need a plan upgrade).
  // Skips servers that already auto-healed in the last 24h.
  if (backend === 'jvm' && process.env.AUTO_HEAL !== '0') {
    const SAFE_TYPE = 'paper';
    // Safe combo for auto-heal. Paper 1.21.1 is current stable and runs
    // comfortably in the 2 GB plan. Previously 1.20.1 (when we had 384 MB).
    const SAFE_VERSION = process.env.SAFE_VERSION || '1.21.1';
    const HEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const { tryAutoFix } = require('./lib/auto-fix');
    const jvm = require('./lib/jvm-controller');
    // Local audit helper — there's no shared audit module, the function lives
    // in routes/servers.js. Mirror its insert here so the auto-fix loop records
    // events into the same audit_log table.
    function audit(user_id, action, resource_id, _ip, metadata) {
      try {
        db.prepare('INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip, metadata) VALUES (?, ?, ?, ?, ?, ?)')
          .run(user_id, action, 'server', resource_id, null, metadata ? JSON.stringify(metadata) : null);
      } catch {}
    }
    setInterval(async () => {
      try {
        const rows = db.prepare(`
          SELECT s.* FROM servers s
          WHERE s.status IN ('offline', 'crashed', 'error')
            AND s.container_id LIKE 'jvm-%'
        `).all();
        const now = Date.now();
        for (const s of rows) {
          let stats = null;
          try { stats = await dc.getStats(s); } catch {}

          const isFree = s.plan_id === 'free';
          const onSafe = String(s.type).toLowerCase() === SAFE_TYPE && s.version === SAFE_VERSION;
          const cooledHeal = !s.auto_healed_at || (now - s.auto_healed_at >= HEAL_COOLDOWN_MS);
          const repeatedOom = (s.auto_restart_count || 0) >= 2;

          // PATH 0: transient OOM → restart the SAME version first. With 2 GB
          // plan most OOMs are transient (chunk gen, plugin overhead). Give the
          // user's chosen version up to 2 retries before swapping types.
          // Cooldown: 30s between retries to avoid hammering.
          const LAST = s.last_auto_restart_at || 0;
          const oomRetryCooldown = (now - LAST) >= 30_000;
          if (stats?.oom && !repeatedOom && oomRetryCooldown) {
            console.log(`🔁 OOM retry: ${s.name} (${s.id}) — same version (${s.type} ${s.version}), attempt ${(s.auto_restart_count || 0) + 1}/2`);
            try {
              const r = await dc.startServer(s);
              db.prepare('UPDATE servers SET status = ?, last_auto_restart_at = ?, auto_restart_count = ? WHERE id = ?')
                .run('starting', now, (s.auto_restart_count || 0) + 1, s.id);
              if (r?.containerId && r.containerId !== s.container_id) {
                db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(r.containerId, s.id);
              }
              continue;
            } catch (err) {
              console.warn(`[oom-retry] ${s.id} failed:`, err.message);
            }
          }

          // PATH 1: persistent OOM → swap to safe combo (Paper 1.20.1). Only
          // after the retries in PATH 0 have hit the cap. Avoids the previous
          // overaggression where any 1-time OOM forced a type swap.
          if (isFree && !onSafe && cooledHeal && stats?.oom && repeatedOom) {
            console.log(`🔧 Auto-heal: ${s.name} (${s.id}) — ${s.type} ${s.version} OOM'd → swapping to ${SAFE_TYPE} ${SAFE_VERSION}`);
            try {
              const fsp = require('fs/promises');
              const pathMod = require('path');
              const DATA_DIR = process.env.DATA_DIR || pathMod.resolve(__dirname, '../data/servers');
              const serverRoot = pathMod.join(DATA_DIR, s.id);
              // Wipe server.jar so the controller re-downloads the safe version.
              await fsp.unlink(pathMod.join(serverRoot, 'server.jar')).catch(() => {});
              // CRITICAL: also wipe type-specific config files. Purpur writes
              // paper-world-defaults.yml entries with string "default" values that
              // Paper 1.20.1 can't parse — `NumberFormatException: For input string: "default"`
              // — and the JVM crashes immediately on the auto-heal restart.
              // Wipe everything type-specific so the new JAR writes clean defaults.
              const STALE_CONFIGS = [
                'paper-global.yml', 'paper-world-defaults.yml',
                'purpur.yml', 'pufferfish.yml',
                'spigot.yml', 'bukkit.yml', 'commands.yml', 'help.yml',
                'config', // entire paper config/ dir (per-world overrides)
              ];
              for (const f of STALE_CONFIGS) {
                try { await fsp.rm(pathMod.join(serverRoot, f), { recursive: true, force: true }); } catch {}
              }
              // Also wipe crash-reports/ + cache/ since they reference the old version
              for (const d of ['crash-reports', 'cache', 'logs']) {
                try { await fsp.rm(pathMod.join(serverRoot, d), { recursive: true, force: true }); } catch {}
              }
              db.prepare(`UPDATE servers SET type = ?, version = ?, status = ?, auto_healed_at = ? WHERE id = ?`)
                .run(SAFE_TYPE, SAFE_VERSION, 'starting', now, s.id);
              const updated = { ...s, type: SAFE_TYPE, version: SAFE_VERSION };
              const r = await dc.startServer(updated);
              if (r?.containerId && r.containerId !== s.container_id) {
                db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(r.containerId, s.id);
              }
              console.log(`🔧 Auto-heal: ${s.name} restarted with ${SAFE_TYPE} ${SAFE_VERSION}`);
              continue;
            } catch (err) {
              console.warn(`[auto-heal] ${s.id} failed:`, err.message);
            }
          }

          // PATH 2: broader auto-fix — scan recent log lines for known error
          // signatures (port collision, bad JAR, corrupt world, plugin crash)
          // and apply a targeted fix + restart. Runs for ANY plan, since the
          // OOM-only heal can't help here.
          if (stats?.oom) continue; // OOM handled above (or out of cooldown)
          const cid = String(s.container_id || '').replace(/^jvm-/, '') || s.id;
          const state = jvm.__getState ? jvm.__getState(cid) : null;
          const logs = state?.logs || [];
          if (!logs.length) continue;
          try {
            const fixed = await tryAutoFix(s, logs, { db, audit });
            if (!fixed) continue;
            if (fixed.skipped) continue; // cooldown
            if (!fixed.ok) { console.warn(`[auto-fix] ${s.id} failed:`, fixed.error); continue; }
            console.log(`🔧 Auto-fix: ${s.name} (${s.id}) — ${fixed.kind} (${fixed.diagnosis})`, fixed.detail || '');
            db.prepare(`UPDATE servers SET status = ? WHERE id = ?`).run('starting', s.id);
            const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id);
            const r = await dc.startServer(updated);
            if (r?.containerId && r.containerId !== s.container_id) {
              db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(r.containerId, s.id);
            }
            console.log(`🔧 Auto-fix: ${s.name} restarted after ${fixed.kind} fix`);
          } catch (err) {
            console.warn(`[auto-fix] ${s.id} loop error:`, err.message);
          }
        }
      } catch (err) { console.warn('[auto-heal] loop failed:', err.message); }
    }, 20_000);
    console.log(`🔧 Auto-heal + auto-fix loop enabled (OOM → safe JAR; port/JAR/world/plugin → targeted fix + restart)`);
  }

  // Auto-restart loop: when a JVM exits unexpectedly (non-intentional, non-OOM,
  // non-zero code or signal), the JVM controller records the crash. This loop
  // restarts the server up to AUTO_RESTART_MAX times within AUTO_RESTART_WINDOW
  // minutes. After the cap, the server stays offline to avoid a crash loop.
  if (backend === 'jvm' && process.env.AUTO_RESTART !== '0') {
    const MAX = parseInt(process.env.AUTO_RESTART_MAX || '5', 10);
    const WINDOW_MS = parseInt(process.env.AUTO_RESTART_WINDOW || '15', 10) * 60 * 1000;
    const COOLDOWN_MS = 30_000;
    setInterval(async () => {
      try {
        for (const [id, info] of dc.getCrashes()) {
          const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
          if (!s) { dc.clearCrash(id); continue; }
          const now = Date.now();
          const last = s.last_auto_restart_at || 0;
          // Reset count if last restart was outside the rolling window
          let count = s.auto_restart_count || 0;
          if (last && now - last > WINDOW_MS) count = 0;
          if (count >= MAX) {
            // Hit the cap — leave offline, let the user investigate
            db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
            dc.clearCrash(id);
            console.warn(`⛔ Auto-restart cap reached for ${s.name} (${id}) — ${count} restarts in ${WINDOW_MS/60000}min. Staying offline.`);
            continue;
          }
          if (now - last < COOLDOWN_MS) continue;
          console.log(`🔁 Auto-restart: ${s.name} (${id}) — crash code=${info.code} signal=${info.signal || 'none'}, attempt ${count + 1}/${MAX}`);
          try {
            const r = await dc.startServer(s);
            db.prepare('UPDATE servers SET status = ?, last_auto_restart_at = ?, auto_restart_count = ? WHERE id = ?')
              .run('starting', now, count + 1, s.id);
            if (r?.containerId && r.containerId !== s.container_id) {
              db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(r.containerId, s.id);
            }
            dc.clearCrash(id);
          } catch (err) {
            console.warn(`[auto-restart] ${id} start failed:`, err.message);
          }
        }
      } catch (err) { console.warn('[auto-restart] loop failed:', err.message); }
    }, 15_000);
    console.log(`🔁 Auto-restart loop enabled (max ${MAX} per ${WINDOW_MS/60000}min)`);
  }

  // ── Periodic disk-cleanup loop ──────────────────────────────────────────────
  // Every JANITOR_INTERVAL_MIN minutes (default 30), purge logs/cache/crash
  // reports from EVERY server dir + wipe orphaned /tmp upload files older than
  // 1h. Keeps the 5GB Railway volume from filling under sustained test/use load.
  // Set DISK_JANITOR=0 to disable.
  if (process.env.DISK_JANITOR !== '0') {
    const intMin = parseInt(process.env.JANITOR_INTERVAL_MIN || '30', 10);
    const PURGE_DIRS = ['logs', 'cache', 'crash-reports'];
    const PURGE_FILE_RE = [/\.log$/, /\.log\.\d+$/, /\.log\.gz$/, /^debug\.log/];
    const fspMod = require('fs/promises');
    const pathMod = require('path');
    const DATA_DIR = process.env.DATA_DIR || pathMod.resolve(__dirname, '../data/servers');
    const VOLUME_ROOT = pathMod.dirname(DATA_DIR);
    async function dirSize(p) { let t = 0; try { const st = await fspMod.stat(p); if (st.isFile()) t = st.size; else if (st.isDirectory()) { const ee = await fspMod.readdir(p); for (const c of ee) t += await dirSize(pathMod.join(p, c)); } } catch {} return t; }
    setInterval(async () => {
      let freed = 0, hits = 0;
      try {
        const ids = db.prepare('SELECT id FROM servers').all().map(r => r.id);
        for (const id of ids) {
          const root = pathMod.join(DATA_DIR, id);
          for (const d of PURGE_DIRS) {
            const sub = pathMod.join(root, d);
            const sz = await dirSize(sub);
            if (sz > 0) { try { await fspMod.rm(sub, { recursive: true, force: true }); freed += sz; hits++; } catch {} }
          }
          try {
            const top = await fspMod.readdir(root, { withFileTypes: true });
            for (const e of top) {
              if (!e.isFile()) continue;
              if (PURGE_FILE_RE.some(re => re.test(e.name))) {
                const full = pathMod.join(root, e.name);
                try { const st = await fspMod.stat(full); freed += st.size; await fspMod.unlink(full); hits++; } catch {}
              }
            }
          } catch {}
        }
        // Tmp files
        for (const tmpDir of ['/tmp', pathMod.join(VOLUME_ROOT, 'tmp')]) {
          try {
            const files = await fspMod.readdir(tmpDir);
            for (const f of files) {
              const full = pathMod.join(tmpDir, f);
              try { const st = await fspMod.stat(full); if (st.isFile() && Date.now() - st.mtimeMs > 60 * 60 * 1000) { freed += st.size; await fspMod.unlink(full); hits++; } } catch {}
            }
          } catch {}
        }
        if (freed > 0) console.log(`🧹 Janitor: freed ${Math.round(freed / 1024 / 1024)}MB across ${hits} items`);
      } catch (err) { console.warn('[janitor] loop failed:', err.message); }
    }, intMin * 60_000);
    console.log(`🧹 Disk janitor loop enabled (${intMin}min interval — clears logs/cache/crash-reports + old /tmp uploads)`);
  }

  // ── Auto-delete backups after server stays offline for N days ───────────────
  // DISABLED by default per user policy: never auto-delete user backups.
  // We now have 1 TB volume (Railway Pro) so disk pressure isn't the
  // bottleneck. Set BACKUP_PRUNE=1 to opt back in.
  if (process.env.BACKUP_PRUNE === '1') {
    const pruneDays = parseInt(process.env.BACKUP_PRUNE_DAYS || '7', 10);
    const fspMod = require('fs/promises');
    const pathMod = require('path');
    const DATA_DIR = process.env.DATA_DIR || pathMod.resolve(__dirname, '../data/servers');
    setInterval(async () => {
      try {
        const cutoffSec = Math.floor(Date.now() / 1000) - pruneDays * 86400;
        const stale = db.prepare(`
          SELECT id FROM servers
          WHERE status IN ('offline','stopped','crashed')
            AND (last_idle_stop_at IS NULL OR last_idle_stop_at / 1000 < ?)
        `).all(cutoffSec);
        let freed = 0, hits = 0;
        for (const { id } of stale) {
          const dir = pathMod.join(DATA_DIR, id, 'backups');
          try {
            const ee = await fspMod.readdir(dir);
            for (const f of ee) {
              const full = pathMod.join(dir, f);
              try { const st = await fspMod.stat(full); if (st.isFile()) { freed += st.size; await fspMod.unlink(full); hits++; } } catch {}
            }
          } catch {}
        }
        if (freed > 0) console.log(`🗑  Backup prune: freed ${Math.round(freed / 1024 / 1024)}MB across ${hits} backup files (${pruneDays}d+ idle)`);
      } catch (err) { console.warn('[backup-prune] loop failed:', err.message); }
    }, 6 * 60 * 60_000); // every 6h
    console.log(`🗑  Backup prune loop enabled (every 6h, deletes backups for servers offline ${pruneDays}+ days)`);
  }

  // ── Scheduled daily restart ─────────────────────────────────────────────────
  // Every minute, check each server's `scheduled_restart_at` ("HH:MM" UTC).
  // When the wall clock matches, do a graceful save-all + restart. Cleared
  // memory leaks, refreshed connections, predictable downtime.
  if (backend === 'jvm' && process.env.SCHEDULED_RESTART !== '0') {
    const jvmCtl2 = require('./lib/jvm-controller');
    setInterval(async () => {
      try {
        const now = new Date();
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const slot = `${hh}:${mm}`;
        const slotEpoch = Math.floor(now.getTime() / 60_000); // current minute since epoch
        const due = db.prepare(`
          SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s
          JOIN plans p ON s.plan_id = p.id
          WHERE s.scheduled_restart_at = ?
            AND s.status IN ('online','running')
            AND (s.last_scheduled_restart_at IS NULL OR s.last_scheduled_restart_at < ?)
        `).all(slot, slotEpoch);
        for (const s of due) {
          console.log(`⏰ Scheduled restart: ${s.name} (${s.id}) at ${slot} UTC`);
          try {
            // Same graceful path the idle-stop uses: save-all + stop + start
            const cid = String(s.container_id || '').replace(/^jvm-/, '') || s.id;
            const state = jvmCtl2.__getState ? jvmCtl2.__getState(cid) : null;
            if (state?.proc?.stdin && !state.proc.killed) {
              try { state.proc.stdin.write('say §e[CraftHost] Scheduled restart in 5s — saving world…\n'); } catch {}
              try { state.proc.stdin.write('save-all flush\n'); } catch {}
              await new Promise(r => setTimeout(r, 5000));
            }
            await dc.restartServer(s);
            db.prepare('UPDATE servers SET status = ?, last_scheduled_restart_at = ? WHERE id = ?')
              .run('starting', slotEpoch, s.id);
            console.log(`⏰ Scheduled restart: ${s.name} restarted`);
          } catch (err) {
            console.warn(`[scheduled-restart] ${s.id} failed:`, err.message);
          }
        }
      } catch (err) { console.warn('[scheduled-restart] loop failed:', err.message); }
    }, 60_000);
    console.log(`⏰ Scheduled-restart loop enabled (checks every minute UTC)`);
  }

  // ── Auto-delete inactive servers ────────────────────────────────────────────
  // DISABLED by default per user policy: never auto-delete user servers or
  // their files. User data is sacred. Idle-stop (above) already stops the JVM
  // after 30 min of 0 players, which frees RAM/CPU without losing data.
  // Set INACTIVE_DELETE=1 to opt back in (NOT recommended).
  if (process.env.INACTIVE_DELETE === '1') {
    const dDays = parseInt(process.env.INACTIVE_DELETE_DAYS || '14', 10);
    const fspMod = require('fs/promises');
    const pathMod = require('path');
    const DATA_DIR = process.env.DATA_DIR || pathMod.resolve(__dirname, '../data/servers');
    setInterval(async () => {
      try {
        const cutoffMs = Date.now() - dDays * 86400_000;
        // Eligible: status offline/stopped/crashed AND last_idle_stop_at older than cutoff
        // (or NULL last_idle_stop_at AND server.created older than cutoff).
        const stale = db.prepare(`
          SELECT id, name, user_id FROM servers
          WHERE status IN ('offline','stopped','crashed')
            AND (
              (last_idle_stop_at IS NOT NULL AND last_idle_stop_at < ?)
              OR (last_idle_stop_at IS NULL AND created_at < ?)
            )
        `).all(cutoffMs, Math.floor(cutoffMs / 1000));
        let freed = 0, removed = 0;
        for (const { id, name, user_id } of stale) {
          const dir = pathMod.join(DATA_DIR, id);
          try {
            // measure before delete
            async function sz(p) { let t = 0; try { const s = await fspMod.stat(p); if (s.isFile()) t = s.size; else if (s.isDirectory()) { const ee = await fspMod.readdir(p); for (const c of ee) t += await sz(pathMod.join(p, c)); } } catch {} return t; }
            const before = await sz(dir);
            try { tunnel.stop(id); } catch {}
            try { await dc.removeServer({ id, container_id: `jvm-${id}` }); } catch {}
            db.prepare('DELETE FROM servers WHERE id = ?').run(id);
            freed += before;
            removed++;
            console.log(`🗑  Auto-delete: ${name} (${id}) — inactive ${dDays}d+ — freed ${Math.round(before / 1024 / 1024)}MB`);
          } catch (err) { console.warn(`[auto-delete] ${id} failed:`, err.message); }
        }
        if (removed > 0) console.log(`🗑  Auto-delete swept ${removed} server(s), freed ${Math.round(freed / 1024 / 1024)}MB`);
      } catch (err) { console.warn('[auto-delete] loop failed:', err.message); }
    }, 6 * 60 * 60_000); // every 6h
    console.log(`🗑  Auto-delete loop enabled (every 6h, deletes servers offline ${dDays}+ days)`);
  }

  // Auto-backup scheduler — runs every BACKUP_INTERVAL_HOURS (default 6h).
  // Paid plans get auto-backups; Free does not. Snapshot without stopping the JVM
  // (we save-all + save-off for ~2s, then zip while writes are paused).
  if (backend === 'jvm' && process.env.AUTO_BACKUP !== '0') {
    const intervalHours = parseFloat(process.env.BACKUP_INTERVAL_HOURS || '6');
    const intervalMs = Math.max(0.1, intervalHours) * 60 * 60 * 1000;
    const bk = require('./lib/backup');
    setInterval(async () => {
      try {
        const rows = db.prepare(`
          SELECT s.*, p.backups_count, p.id as plan_id FROM servers s
          JOIN plans p ON s.plan_id = p.id
          WHERE s.status IN ('online','starting','running')
            AND s.plan_id != 'free'
        `).all();
        if (!rows.length) return;
        console.log(`⏰ Auto-backup: ${rows.length} eligible server(s)`);
        for (const s of rows) {
          try {
            try { await dc.sendRcon(s, '/save-all'); await dc.sendRcon(s, '/save-off'); } catch {}
            await new Promise(r => setTimeout(r, 1500));
            const info = await bk.createBackup(s.id, { retention: s.backups_count || 1 });
            try { await dc.sendRcon(s, '/save-on'); } catch {}
            console.log(`  ✓ ${s.name}: ${info.filename} (${(info.size/1024/1024).toFixed(1)} MB)`);
          } catch (err) {
            console.warn(`  ✗ ${s.name}: ${err.message}`);
          }
        }
      } catch (err) { console.warn('[auto-backup] failed:', err.message); }
    }, intervalMs);
    console.log(`⏰ Auto-backup scheduler enabled (every ${intervalHours}h, paid plans only)`);
  }

  // Pre-warm the JAR cache in background so the FIRST user deploying any
  // engine gets a cache HIT (5s boot) instead of a MISS (60s+ download).
  // Re-runs every 24h to pick up new LATEST builds from Paper/Fabric/Purpur.
  if (backend === 'jvm' && jvmCtl.prewarmJarCache) {
    // Run after a short delay so it doesn't compete with auto-resume of
    // existing servers for bandwidth.
    setTimeout(() => { jvmCtl.prewarmJarCache().catch(err => console.warn('[prewarm] failed:', err.message)); }, 10_000);
    setInterval(() => { jvmCtl.prewarmJarCache().catch(err => console.warn('[prewarm] failed:', err.message)); }, 24 * 60 * 60 * 1000);
    console.log('📦 JAR pre-warm scheduled (10s + every 24h)');
  }

  // Continuous JAR health probe — every 10 min verifies every cached JAR
  // is on disk + correct size, and AUTO-REPAIRS corrupt/missing ones by
  // re-downloading. Cheap when healthy (just stat() + 4 HTTP HEAD/GET).
  // Logs 🚨 if anything had to be repaired so ops can investigate root cause.
  if (backend === 'jvm' && process.env.AUTO_SMOKE !== '0' && jvmCtl.checkJarCacheHealth) {
    const runHealth = async () => {
      try {
        const r = await jvmCtl.checkJarCacheHealth();
        if (r.repaired > 0 || r.errors > 0) {
          console.log(`🚨 JAR health: ${r.healthy}✓ ${r.repaired} repaired · ${r.errors} errors (of ${r.scanned})`);
        } else {
          console.log(`🩺 JAR health: ${r.healthy}/${r.scanned} OK`);
        }
      } catch (err) {
        console.error(`🚨 JAR health probe failed: ${err.message}`);
      }
    };
    // First run 60s after boot (after the prewarm has had a chance), then
    // every 10 min forever.
    setTimeout(runHealth, 60_000);
    setInterval(runHealth, 10 * 60 * 1000);
    console.log('🩺 JAR health probe scheduled (every 10 min, auto-repair enabled)');
  }

  // Deep auto-smoke — every 6h re-run the full JAR cache prewarm. Catches
  // new LATEST builds + verifies upstream APIs are reachable.
  if (backend === 'jvm' && process.env.AUTO_SMOKE !== '0' && jvmCtl.prewarmJarCache) {
    const deepSmoke = async () => {
      try {
        await jvmCtl.prewarmJarCache();
      } catch (err) {
        console.error(`🚨 Deep auto-smoke FAILED: ${err.message}`);
      }
    };
    setInterval(deepSmoke, 6 * 60 * 60 * 1000);
    console.log('🩺 Deep auto-smoke scheduled (every 6h)');
  }

  // Clear stale tunnel rows on boot. Bore allocates a fresh remote port every
  // time, so cached values from before restart are guaranteed to be wrong.
  try { db.prepare('UPDATE servers SET tunnel_host = NULL, tunnel_port = NULL').run(); } catch {}

  // One-shot cleanup of orphan test users (qt-*, tx-*, smoke-*) — these come
  // from smoke-test runs whose own cleanup got interrupted by a Railway edge
  // hiccup. Always-on, idempotent. Costs ~5ms per boot if there's nothing to do.
  try {
    const fs = require('fs');
    const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data/servers');
    const orphans = db.prepare(`
      SELECT id, username FROM users
       WHERE username LIKE 'qt%' OR username LIKE 'tx%' OR username LIKE 'smoke%'
          OR email LIKE 'qt-%@crafthost.local'
          OR email LIKE 'tx-%@crafthost.local'
          OR email LIKE 'smoke-%@crafthost.local'
    `).all();
    if (orphans.length) {
      let dirs = 0, srvs = 0;
      for (const u of orphans) {
        const ss = db.prepare('SELECT id FROM servers WHERE user_id = ?').all(u.id);
        for (const s of ss) {
          const dir = path.join(DATA_DIR, s.id);
          if (fs.existsSync(dir)) { try { fs.rmSync(dir, { recursive: true, force: true }); dirs++; } catch {} }
          db.prepare('DELETE FROM servers WHERE id = ?').run(s.id); srvs++;
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      }
      console.log(`🧹 Cleaned ${orphans.length} test-user orphans (${srvs} servers, ${dirs} data dirs)`);
    }
  } catch (err) { console.warn('[orphan-cleanup] failed:', err.message); }

  // Auto-resume any server that was online/starting before the container restarted.
  // Cap at MAX_AUTO_RESUME so free-tier RAM doesn't get crushed by stale tests.
  if (backend === 'jvm' && process.env.JVM_AUTO_RESUME !== '0') {
    try {
      const maxResume = parseInt(process.env.MAX_AUTO_RESUME || '3', 10);
      const all = db.prepare(`
        SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s
        JOIN plans p ON s.plan_id = p.id
        WHERE s.status IN ('online','starting','running')
          AND s.container_id LIKE 'jvm-%'
        ORDER BY s.is_public DESC, s.created_at DESC
      `).all();
      const rows = all.slice(0, maxResume);
      const skipped = all.length - rows.length;
      if (skipped > 0) {
        console.log(`↻ Auto-resume: keeping ${rows.length} most-recent server(s), skipping ${skipped} older one(s) (raise MAX_AUTO_RESUME to change).`);
        // Mark skipped ones offline so the dashboard reflects reality.
        const skip = all.slice(maxResume);
        for (const s of skip) {
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
        }
      }
      if (rows.length) console.log(`↻ Auto-resuming ${rows.length} server(s) from previous run…`);
      const tunnel = require('./lib/tunnel');
      // Stagger restarts: free-tier RAM can't handle 8 simultaneous JVM boots.
      // Sleep ~6s between each so the previous server has a chance to settle.
      for (const s of rows) {
        try {
          await dc.startServer(s);
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
          console.log(`  ↻ ${s.name} (#${s.user_slot}) — resumed`);
          if (tunnel.isAvailable()) {
            const offset = Math.max(0, parseInt(s.port, 10) - 25565);
            const internal = 26000 + (offset % 1000);
            tunnel.start(s.id, internal).catch(err => console.warn(`  ! ${s.name} tunnel:`, err.message));
          }
        } catch (err) {
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
          console.warn(`  ✗ ${s.name}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 6000));
      }
    } catch (err) {
      console.warn('[auto-resume] failed:', err.message);
    }
  }
});
