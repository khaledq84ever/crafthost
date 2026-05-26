const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const os = require('os');
const db = require('../db');
const { authMiddleware } = require('../lib/auth');
const dc = require('../lib/controller');
const railway = require('../lib/railway-api');
const tunnel = require('../lib/tunnel');
const playit = require('../lib/playit');

const MAX_WORLD_ZIP_BYTES = 500 * 1024 * 1024; // 500MB cap for world.zip uploads
const worldUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_WORLD_ZIP_BYTES, files: 1 },
});
const MAX_ICON_BYTES = 256 * 1024; // 256KB cap — MC server icons are 64x64 PNG (~5KB typical)
const iconUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_ICON_BYTES, files: 1 },
});

function internalListenPort(server) {
  // Mirrors jvm-controller.pickHostPort for non-public servers.
  const offset = Math.max(0, parseInt(server.port, 10) - 25565);
  return 26000 + (offset % 1000);
}

const router = express.Router();

// ─── PUBLIC ENDPOINTS (no auth required) ───
// Listed BEFORE authMiddleware so they don't get gated.

// GET /api/servers/public — running public servers with live SLP data
router.get('/public', async (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.id, s.name, s.type, s.version, s.user_slot, s.is_public,
             s.status, s.container_id, s.max_players, s.motd, s.gamemode,
             p.ram_mb, p.cpu_cores
      FROM servers s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.is_public = 1
        AND s.status IN ('online','starting','running')
      ORDER BY s.created_at DESC
      LIMIT 24
    `).all();
    const out = [];
    for (const s of rows) {
      let stats = null;
      try { stats = await dc.getStats(s); } catch {}
      if (stats?.online) {
        out.push({
          id: s.id,
          name: s.name,
          type: s.type,
          version: stats.mc_version || s.version,
          motd: stats.motd || s.motd,
          players_online: stats.players,
          players_max: stats.players_max || s.max_players,
          player_sample: stats.player_sample || [],
          tps: stats.tps,
          mc_version: stats.mc_version,
        });
      }
    }
    res.json({
      servers: out,
      public_host: publicHost(),
      public_mc_port: parseInt(process.env.PUBLIC_MC_PROXY_PORT || process.env.MC_PORT || '25565', 10),
      total: out.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list public servers' });
  }
});

router.use(authMiddleware);

// Port pool 25565..25665. Lowest free is allocated and persisted in `servers.port`.
const PORT_START = parseInt(process.env.SERVER_PORT_START || '25565', 10);
const PORT_END = parseInt(process.env.SERVER_PORT_END || '25665', 10);

function allocPort() {
  const used = new Set(db.prepare('SELECT port FROM servers').all().map(r => r.port));
  for (let p = PORT_START; p <= PORT_END; p++) if (!used.has(p)) return p;
  throw new Error('No free ports available');
}

function nextSlotFor(userId) {
  const row = db.prepare('SELECT COALESCE(MAX(user_slot), 0) AS m FROM servers WHERE user_id = ?').get(userId);
  return (row?.m || 0) + 1;
}

function publicHost() {
  // Allow operator to override (e.g. when they generate a TCP proxy domain on Railway)
  return process.env.PUBLIC_MC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN || 'mc.crafthost.gg';
}

// Strip sensitive fields from server rows before sending to the client.
// Replaces playit_secret with a boolean playit_enabled flag — the actual
// secret never leaves the database after it's set.
function redact(row) {
  if (!row) return row;
  const { playit_secret, ...rest } = row;
  return { ...rest, playit_enabled: !!playit_secret };
}

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, p.name as plan_name, p.ram_mb, p.cpu_cores, p.max_players as plan_max_players
    FROM servers s JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ?
    ORDER BY s.user_slot ASC, s.created_at ASC
  `).all(req.user.id);
  res.json({
    servers: rows.map(redact),
    public_host: publicHost(),
    proxy_enabled: railway.isConfigured(),
    playit_available: playit.isAvailable(),
  });
});

// Per-user server cap. Every account may create up to MAX_SERVERS_PER_USER
// servers total. Owner/admin accounts are exempt (unlimited): any user whose
// role is 'admin', or whose username / email (or email local-part) is listed in
// UNLIMITED_USERS (case-insensitive). Defaults: 3 per user, khaledq84ever unlimited.
const MAX_SERVERS_PER_USER = parseInt(process.env.MAX_SERVERS_PER_USER || '3', 10);
const UNLIMITED_USERS = (process.env.UNLIMITED_USERS || 'khaledq84ever')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isUnlimitedUser(user) {
  if (user?.role === 'admin') return true;
  const uname = (user?.username || '').toLowerCase();
  const email = (user?.email || '').toLowerCase();
  return UNLIMITED_USERS.includes(uname)
      || UNLIMITED_USERS.includes(email)
      || UNLIMITED_USERS.includes(email.split('@')[0]);
}

// Shared playit secret store — makes Bedrock one-click for EVERY server after the
// owner approves playit.gg just ONCE. Resolution order: PLAYIT_SHARED_SECRET env
// var first, then the secret captured from the owner's first successful claim
// (persisted in app_settings). No env var or SSH needed — the system remembers it.
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
function getSharedPlayitSecret() {
  if (process.env.PLAYIT_SHARED_SECRET) return process.env.PLAYIT_SHARED_SECRET;
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'playit_shared_secret'").get();
  return row?.value || null;
}
function setSharedPlayitSecret(secret) {
  if (!secret) return;
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('playit_shared_secret', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(secret);
}

// Shared server-creation logic. Used by POST /api/servers AND by the auto-starter
// that fires on registration. `opts` is the deploy spec, `user` is { id, username }.
// Throws on validation/quota error; returns the response payload otherwise.
async function createServerForUser(user, opts, ip) {
  const { name, type, version, plan, region, motd, difficulty, gamemode, whitelist, customJarPath, seed_plugins, skipAutoStart, seed } = opts || {};
  if (!type || !plan) { const e = new Error('Missing fields'); e.status = 400; throw e; }

  const planRow = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan);
  if (!planRow) { const e = new Error('Invalid plan'); e.status = 400; throw e; }

  if (!isUnlimitedUser(user)) {
    const existing = db.prepare('SELECT COUNT(*) AS c FROM servers WHERE user_id = ?').get(user.id);
    if (existing.c >= MAX_SERVERS_PER_USER) {
      const e = new Error(`Server limit reached — you can create up to ${MAX_SERVERS_PER_USER} servers. Delete one to make room.`);
      e.status = 409; throw e;
    }
  }

  const slot = nextSlotFor(user.id);
  const fallbackName = `${user.username || 'server'}-${slot}`;
  const finalName = (name || fallbackName).slice(0, 40);

  const id = crypto.randomBytes(8).toString('hex');
  let port;
  try { port = allocPort(); }
  catch (err) { const e = new Error('No free server ports'); e.status = 503; throw e; }

  const rcon = dc.makeRconPassword();

  // First server overall = automatic public. Otherwise internal until promoted.
  const anyPublic = db.prepare('SELECT 1 FROM servers WHERE is_public = 1 LIMIT 1').get();
  const isPublic = anyPublic ? 0 : 1;

  db.prepare(`
    INSERT INTO servers (id, user_id, name, type, version, plan_id, port, region, motd, difficulty, gamemode, max_players, whitelist, rcon_password, custom_jar_path, user_slot, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.id, finalName, type, version || null, plan, port, region || 'eu', motd || '', difficulty || 'normal', gamemode || 'survival', planRow.max_players, whitelist ? 1 : 0, rcon, customJarPath || null, slot, isPublic);

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  const enriched = { ...server, ram_mb: planRow.ram_mb, cpu_cores: planRow.cpu_cores };

  try {
    const r = await dc.createServer(enriched);
    db.prepare('UPDATE servers SET container_id = ?, status = ? WHERE id = ?').run(r.containerId, 'created', id);
    audit(user.id, 'server.create', id, ip, { slot, port, plan });

    // Write an owner.txt file inside the server's data dir so admins / disk
    // browsers can tell which user owns which directory at a glance — useful
    // when ssh'ing into Railway and listing /data/servers/. Idempotent.
    try {
      const fsp = require('fs/promises');
      const pathMod = require('path');
      const DATA_DIR = process.env.DATA_DIR || pathMod.resolve(__dirname, '../../data/servers');
      const ownerPath = pathMod.join(DATA_DIR, id, 'owner.txt');
      const lines = [
        `# CraftHost server ownership record`,
        `server_id=${id}`,
        `server_name=${finalName}`,
        `user_id=${user.id}`,
        `username=${user.username}`,
        `email=${user.email || ''}`,
        `plan=${plan}`,
        `type=${type}`,
        `version=${version || 'LATEST'}`,
        `created_at=${new Date().toISOString()}`,
        `created_from_ip=${ip || 'unknown'}`,
      ];
      await fsp.mkdir(pathMod.dirname(ownerPath), { recursive: true });
      await fsp.writeFile(ownerPath, lines.join('\n') + '\n', 'utf8');
    } catch (err) {
      console.warn('[owner.txt] write failed:', err.message);
    }

    // World seed — pre-write server.properties with level-seed so the very first
    // world generation uses it. Otherwise Minecraft generates a random seed and
    // setting it after the fact has no effect (world is already created).
    if (seed && typeof seed === 'string' && seed.trim()) {
      try {
        const fsp = require('fs/promises');
        const path = require('path');
        const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
        const propsPath = path.join(DATA_DIR, id, 'server.properties');
        await fsp.mkdir(path.dirname(propsPath), { recursive: true });
        let existing = '';
        try { existing = await fsp.readFile(propsPath, 'utf8'); } catch {}
        const cleanSeed = seed.trim().slice(0, 80);
        // Replace any existing level-seed line, otherwise append
        if (/^level-seed=/m.test(existing)) {
          existing = existing.replace(/^level-seed=.*$/m, `level-seed=${cleanSeed}`);
        } else {
          existing = (existing ? existing.trimEnd() + '\n' : '') + `level-seed=${cleanSeed}\n`;
        }
        await fsp.writeFile(propsPath, existing, 'utf8');
        audit(user.id, 'server.seed', id, ip, { seed: cleanSeed });
      } catch (err) {
        console.warn(`[create] failed to write seed for ${id}:`, err.message);
      }
    }

    // Seed starter plugins. Accepts:
    //   seed_plugins: true            → install the LuckPerms default
    //   seed_plugins: [pid, pid, ...] → install each Modrinth project id (best-effort)
    if (Array.isArray(seed_plugins) && seed_plugins.length) {
      seedDefaultPlugins(user.id, id, seed_plugins, version).catch(err => console.warn('[seed]', err.message));
    } else if (seed_plugins === true) {
      seedDefaultPlugins(user.id, id, ['Vebnzrzj'], version).catch(err => console.warn('[seed]', err.message));
    }

    let autoStarted = false;
    let startSkippedReason = null;
    const enrichedForStart = { ...enriched, container_id: r.containerId, status: 'created' };
    const quotaErr = checkRunningQuota(enrichedForStart);
    if (skipAutoStart) {
      startSkippedReason = 'skipped by caller';
    } else if (quotaErr) {
      startSkippedReason = quotaErr;
    } else {
      try {
        await dc.startServer(enrichedForStart);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', id);
        audit(user.id, 'server.start', id, ip, { auto: true });
        autoStarted = true;
      } catch (err) {
        console.warn('[create] auto-start failed:', err.message);
        startSkippedReason = err.message || 'start failed';
      }
    }

    // Per-server free TCP tunnel via bore.pub. Each MC server gets its own
    // real public host:port that friends can paste into Minecraft. Only useful
    // if the server actually started — otherwise nothing to forward to.
    let proxy = null;
    if (autoStarted && tunnel.isAvailable()) {
      try {
        const t = await tunnel.start(id, internalListenPort({ port }));
        if (t) {
          proxy = { host: t.host, port: t.port };
          audit(user.id, 'server.tunnel_create', id, ip, proxy);
        }
      } catch (err) {
        console.warn('[create] tunnel start failed:', err.message);
      }
    }

    return {
      id, port, slot,
      is_public: !!isPublic,
      public_host: publicHost(),
      proxy,
      server: enriched,
      auto_started: autoStarted,
      start_skipped_reason: startSkippedReason,
    };
  } catch (err) {
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    const e = new Error(err.message); e.status = 500; throw e;
  }
}

router.post('/', async (req, res) => {
  try {
    const out = await createServerForUser(req.user, req.body || {}, req.ip);
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/servers/:id/clone  { name?, skipWorld?: false, skipPlugins?: false }
// Duplicates an existing owned server: creates a new server row with the same
// type/version/plan/properties as the source, then copies world dirs + plugins
// + config files into the new data dir. server.jar is intentionally NOT copied
// (the controller re-downloads it on first start so it's always current).
// Returns the same shape as POST /api/servers, with `cloned_from: <src id>`.
router.post('/clone', async (req, res) => {
  // Note: this route MUST be registered before `/:id/*` to avoid express matching
  // "clone" as a server id. The trick: we look up the source id from the body.
  const { source_id, name, skipWorld, skipPlugins } = req.body || {};
  if (!source_id) return res.status(400).json({ error: 'source_id required' });

  const src = db.prepare(`
    SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.id = ? AND s.user_id = ?
  `).get(source_id, req.user.id);
  if (!src) return res.status(404).json({ error: 'Source server not found' });

  const fsp = require('fs/promises');
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');

  let out;
  try {
    // Build opts from source. Auto-start is skipped so we can inject files first.
    out = await createServerForUser(
      req.user,
      {
        name: (name || `Copy of ${src.name}`).slice(0, 40),
        type: src.type,
        version: src.version,
        plan: src.plan_id,
        region: src.region,
        motd: src.motd,
        difficulty: src.difficulty,
        gamemode: src.gamemode,
        whitelist: !!src.whitelist,
        customJarPath: src.custom_jar_path || null,
        skipAutoStart: true,
      },
      req.ip,
    );
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  // Copy almost everything from src → dest. Allow-list of dirs (so we don't
  // wander into surprising places), but copy ALL top-level files except a
  // SKIP set. The skip set excludes things that:
  //   • get re-derived on next start (server.jar, libraries/, versions/)
  //   • belong to the source server identity (usercache.json, session.lock)
  //   • are EULA bookkeeping or local history (eula.txt, .console_history)
  //   • are noisy / source-specific (logs/, crash-reports/)
  const COPY_DIRS  = ['world', 'world_nether', 'world_the_end', 'plugins', 'config'];
  const SKIP       = new Set(['server.jar', 'eula.txt', 'cache', 'libraries', 'versions', 'crash-reports', '.console_history', 'usercache.json', 'session.lock', 'logs']);
  const COPY_DIRS_FILTERED = COPY_DIRS;

  const srcRoot = path.join(DATA_DIR, src.id);
  const dstRoot = path.join(DATA_DIR, out.id);
  const copyStats = { dirs: 0, files: 0, bytes: 0 };

  async function copyDir(from, to) {
    await fsp.mkdir(to, { recursive: true });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.name === 'session.lock') continue; // never copy lock files
      const f = path.join(from, e.name);
      const t = path.join(to, e.name);
      if (e.isDirectory()) {
        copyStats.dirs++;
        await copyDir(f, t);
      } else if (e.isFile()) {
        try {
          await fsp.copyFile(f, t);
          const st = await fsp.stat(t);
          copyStats.files++;
          copyStats.bytes += st.size;
        } catch (err) {
          console.warn(`[clone] failed to copy ${f}:`, err.message);
        }
      }
    }
  }

  try {
    if (!skipWorld) {
      for (const d of COPY_DIRS_FILTERED) {
        if (d === 'plugins' && skipPlugins) continue;
        const srcDir = path.join(srcRoot, d);
        if (fs.existsSync(srcDir)) {
          await copyDir(srcDir, path.join(dstRoot, d));
        }
      }
    } else if (!skipPlugins) {
      // skipWorld=true but still copy plugins
      const srcDir = path.join(srcRoot, 'plugins');
      if (fs.existsSync(srcDir)) await copyDir(srcDir, path.join(dstRoot, 'plugins'));
    }
    // Copy ALL top-level flat files except those in SKIP. This matches user
    // expectation (custom configs, banlists, motd icons, .txt notes get copied)
    // without dragging in noisy/identity-specific files.
    try {
      const entries = await fsp.readdir(srcRoot, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (SKIP.has(e.name)) continue;
        const srcFile = path.join(srcRoot, e.name);
        try {
          await fsp.copyFile(srcFile, path.join(dstRoot, e.name));
          const st = await fsp.stat(path.join(dstRoot, e.name));
          copyStats.files++;
          copyStats.bytes += st.size;
        } catch (err) {
          console.warn(`[clone] failed to copy ${e.name}:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[clone] readdir on src root failed:`, err.message);
    }
  } catch (err) {
    console.warn('[clone] copy failed:', err.message);
    // Don't abort — the server is created, user can investigate or delete and retry.
  }

  // Now auto-start the clone (unless free-tier quota blocks it).
  let autoStarted = false, startSkippedReason = null;
  try {
    const dst = db.prepare('SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s JOIN plans p ON s.plan_id = p.id WHERE s.id = ?').get(out.id);
    const quotaErr = checkRunningQuota(dst);
    if (quotaErr) {
      startSkippedReason = quotaErr;
    } else {
      await dc.startServer(dst);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', out.id);
      audit(req.user.id, 'server.start', out.id, req.ip, { auto: true, cloned_from: src.id });
      autoStarted = true;
      // Tunnel for the clone
      if (tunnel.isAvailable()) {
        try {
          const t = await tunnel.start(out.id, internalListenPort({ port: out.port }));
          if (t) out.proxy = { host: t.host, port: t.port };
        } catch (err) { console.warn('[clone] tunnel start failed:', err.message); }
      }
    }
  } catch (err) {
    startSkippedReason = err.message || 'start failed';
  }

  audit(req.user.id, 'server.clone', out.id, req.ip, { source_id: src.id, copy: copyStats });

  res.json({
    ...out,
    cloned_from: src.id,
    copy_stats: copyStats,
    auto_started: autoStarted,
    start_skipped_reason: startSkippedReason,
  });
});

// GET /api/servers/health-check
// Aggregate health snapshot of every server owned by the authed user.
// MUST be registered before `/:id/...` routes (otherwise express treats
// "health-check" as a server id and 404s).
// Returns:
//   { servers: [{id,name,type,version,status,online,stats,oom,last_crash,
//                auto_restart_count,last_auto_restart_at,auto_healed_at,
//                recent_logs[],issues[],health:'good'|'warn'|'error'}],
//     summary: { good, warn, error, total } }
router.get('/health-check', async (req, res) => {
  const jvm = require('../lib/jvm-controller');
  const rows = db.prepare(`
    SELECT s.*, p.name as plan_name, p.ram_mb, p.cpu_cores
    FROM servers s JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ?
    ORDER BY s.user_slot ASC
  `).all(req.user.id);

  // Lookup recent unexpected crashes (in-memory map keyed by container id)
  const crashMap = new Map();
  for (const [cid, info] of jvm.getCrashes ? jvm.getCrashes() : []) {
    crashMap.set(cid, info);
  }

  const HEALED_WINDOW_MS = 10 * 60 * 1000;       // green pill for 10 min after auto-heal
  const RESTART_WINDOW_MS = 10 * 60 * 1000;      // green-with-note for 10 min after auto-restart

  const servers = [];
  let good = 0, warn = 0, error = 0;
  for (const s of rows) {
    let stats = null;
    try { stats = await dc.getStats(s); } catch {}

    const cid = String(s.container_id || '').replace(/^jvm-/, '') || s.id;
    const state = jvm.__getState ? jvm.__getState(cid) : null;
    const recent_logs = (state?.logs || []).slice(-8);
    const last_crash = crashMap.get(cid) || null;

    const issues = []; // {severity:'error'|'warn'|'info', code, message}
    const now = Date.now();
    const healedRecently = s.auto_healed_at && (now - s.auto_healed_at * 1000) < HEALED_WINDOW_MS;
    const restartedRecently = s.last_auto_restart_at && (now - s.last_auto_restart_at * 1000) < RESTART_WINDOW_MS;

    // Status checks (most-severe first)
    // OOM detection — but if the server has already been auto-healed recently,
    // the OOM is historical state, not a current problem. Downgrade to info so
    // the health rollup isn't stuck on "error" forever after a successful heal.
    if (stats?.oom || state?.oom) {
      if (healedRecently) {
        // Suppressed — the auto_healed_at info pill already tells the user
        // what happened. Showing red "OOM error" alongside green "Healed"
        // is confusing.
      } else {
        issues.push({ severity: 'error', code: 'oom', message: 'Server ran out of memory (OOM kill). Try a lighter JAR or upgrade plan.' });
      }
    }
    // Crash detection — same logic. If we healed within the window the crash
    // is the cause that triggered the heal, not a new problem.
    if (last_crash && (!stats?.online) && !healedRecently) {
      const ago = Math.round((now - last_crash.when) / 1000);
      issues.push({
        severity: 'error',
        code: 'crashed',
        message: `Server crashed ${ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm'} ago (exit code ${last_crash.code}${last_crash.signal ? ', signal ' + last_crash.signal : ''}).`,
      });
    }
    if (s.status === 'offline' || s.status === 'stopped') {
      issues.push({ severity: 'info', code: 'offline', message: 'Server is stopped.' });
    }
    if (stats?.online && stats.cpu >= 95) {
      issues.push({ severity: 'warn', code: 'cpu_high', message: `CPU pegged at ${stats.cpu}% — may cause TPS drops.` });
    }
    if (stats?.online && stats.ram_max && stats.ram_used / stats.ram_max >= 0.92) {
      issues.push({ severity: 'warn', code: 'ram_high', message: `RAM at ${Math.round((stats.ram_used / stats.ram_max) * 100)}% (${stats.ram_used}/${stats.ram_max} MB) — OOM risk.` });
    }
    if (restartedRecently && (s.auto_restart_count || 0) >= 3) {
      issues.push({ severity: 'warn', code: 'restart_loop', message: `Auto-restarted ${s.auto_restart_count}× recently. Server may be unstable.` });
    }
    if (s.status === 'starting' && state?.startedAt && (now - state.startedAt) > 120000) {
      issues.push({ severity: 'warn', code: 'slow_boot', message: 'Server has been "starting" for over 2 minutes.' });
    }
    if (healedRecently) {
      issues.push({ severity: 'info', code: 'auto_healed', message: '✓ Auto-healed recently (rolled to safe JAR after OOM).' });
    }
    if (restartedRecently) {
      issues.push({ severity: 'info', code: 'auto_restarted', message: `✓ Auto-restarted on crash (${s.auto_restart_count}×).` });
    }
    const FIX_WINDOW_MS = 30 * 60 * 1000; // show fix pill for 30 min
    if (s.last_auto_fix_at && (now - s.last_auto_fix_at * 1) < FIX_WINDOW_MS && s.last_auto_fix_kind) {
      const KIND_LABEL = { port: 'port collision', jar: 'corrupt JAR', world: 'corrupt world data', plugin: 'broken plugin' };
      issues.push({
        severity: 'info',
        code: 'auto_fixed',
        message: `✓ Auto-fixed by CraftHost: ${KIND_LABEL[s.last_auto_fix_kind] || s.last_auto_fix_kind}.`,
      });
    }

    // Health rollup
    let health = 'good';
    if (issues.some(i => i.severity === 'error')) health = 'error';
    else if (issues.some(i => i.severity === 'warn')) health = 'warn';
    if (health === 'good') good++; else if (health === 'warn') warn++; else error++;

    servers.push({
      id: s.id,
      name: s.name,
      type: s.type,
      version: s.version,
      status: s.status,
      online: !!stats?.online,
      stats: stats ? {
        cpu: stats.cpu,
        ram_used: stats.ram_used,
        ram_max: stats.ram_max,
        uptime: stats.uptime,
        players: stats.players,
        players_max: stats.players_max,
        tps: stats.tps,
      } : null,
      oom: !!(stats?.oom || state?.oom),
      last_crash,
      auto_restart_count: s.auto_restart_count || 0,
      last_auto_restart_at: s.last_auto_restart_at || null,
      auto_healed_at: s.auto_healed_at || null,
      address: (s.tunnel_host && s.tunnel_port) ? `${s.tunnel_host}:${s.tunnel_port}` : null,
      recent_logs,
      issues,
      health,
    });
  }
  res.json({
    servers,
    summary: { good, warn, error, total: servers.length },
    checked_at: Date.now(),
  });
});

async function seedDefaultPlugins(userId, serverId, projectIds, mcVersion) {
  // Best-effort bulk install of Modrinth project IDs into <server>/plugins/.
  // Tries the local plugin-cache first (instant hardlink, no network); falls
  // back to a live Modrinth fetch filtered by THIS server's MC version, then
  // populates the cache so future installs at the same MC version are HITs.
  const path = require('path');
  const fsp = require('fs/promises');
  const pluginCache = require('../lib/plugin-cache');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  const pluginsDir = path.join(DATA_DIR, serverId, 'plugins');
  await fsp.mkdir(pluginsDir, { recursive: true });
  const ids = (Array.isArray(projectIds) ? projectIds : [projectIds]).filter(Boolean);
  for (const pid of ids) {
    try {
      // ── CACHE FIRST — try exact-MC slot, then 'any' fallback
      const hit = await pluginCache.copyFromCache(pid, pluginsDir, mcVersion);
      if (hit) {
        console.log(`[plugin-cache] HIT  ${pid}@${hit.mc} → ${hit.filename}`);
        audit(userId, 'plugin.seed', serverId, null, { name: hit.filename, project: pid, cached: true, mc: hit.mc });
        continue;
      }
      // ── CACHE MISS — fetch from Modrinth/upstream filtered by MC version
      const meta = await pluginCache.resolveLatestVersion(pid, mcVersion);
      const dl = await fetch(meta.url, { headers: { 'User-Agent': 'CraftHost/1.0' } });
      if (!dl.ok) { console.warn(`[seed] download failed ${pid}: ${dl.status}`); continue; }
      const buf = Buffer.from(await dl.arrayBuffer());
      const safe = String(meta.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      await fsp.writeFile(path.join(pluginsDir, safe), buf);
      try {
        await pluginCache.writeIntoCache(pid, meta.filename, buf, {
          version_id: meta.version_id,
          version_number: meta.version_number,
          sha512: meta.sha512,
        }, mcVersion);
      } catch (err) { console.warn(`[plugin-cache] writeIntoCache ${pid}:`, err.message); }
      console.log(`[plugin-cache] MISS ${pid}@${mcVersion || 'any'} → fetched + cached`);
      audit(userId, 'plugin.seed', serverId, null, { name: safe, project: pid, cached: false, mc: mcVersion || 'any' });
    } catch (err) {
      console.warn(`[seed] ${pid} failed:`, err.message);
    }
  }
}

function getOwnedServer(req, res) {
  const s = db.prepare(`
    SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.id = ? AND s.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!s) { res.status(404).json({ error: 'Server not found' }); return null; }
  return s;
}

// Running-server quota. On Railway Pro (1 TB RAM) we can run many concurrent
// servers. Cap at 3 per user as a safety bound — way more than the prior 1 —
// without being effectively unlimited. Override via MAX_RUNNING_PER_USER env.
function checkRunningQuota(s) {
  const MAX = parseInt(process.env.MAX_RUNNING_PER_USER || '3', 10);
  const running = db.prepare(`
    SELECT id, name FROM servers
    WHERE user_id = ? AND id != ? AND status IN ('starting','online','running')
      AND container_id NOT LIKE 'stub-%'
  `).all(s.user_id, s.id);
  if (running.length >= MAX) {
    return `You can have up to ${MAX} servers running at a time. Stop one (e.g. "${running[0].name}") to start another.`;
  }
  return null;
}

router.post('/:id/start', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const quotaErr = checkRunningQuota(s);
  if (quotaErr) return res.status(409).json({ error: quotaErr });
  try {
    const r = await dc.startServer(s);
    if (r.containerId && r.containerId !== s.container_id) {
      db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(r.containerId, s.id);
    }
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
    audit(req.user.id, 'server.start', s.id, req.ip);
    // Start tunnel after JVM is launching. Don't await — tunnel can come up
    // within a few seconds and the response shouldn't block on it.
    if (tunnel.isAvailable()) {
      tunnel.start(s.id, internalListenPort(s))
        .catch(err => console.warn('[start] tunnel:', err.message));
    }
    // playit.gg agent (UDP — Bedrock cross-play via Geyser). Only if the user
    // configured a playit secret on this server. Java still uses bore above.
    if (s.playit_secret && playit.isAvailable()) {
      playit.start(s.id, internalListenPort(s), s.playit_secret)
        .catch(err => console.warn('[start] playit:', err.message));
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message || 'start failed' });
  }
});

router.post('/:id/stop', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  tunnel.stop(s.id);
  playit.stop(s.id);
  const r = await dc.stopServer(s);
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
  audit(req.user.id, 'server.stop', s.id, req.ip);
  res.json(r);
});

router.post('/:id/restart', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  try {
    tunnel.stop(s.id);
    playit.stop(s.id);
    const r = await dc.restartServer(s);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
    audit(req.user.id, 'server.restart', s.id, req.ip);
    if (tunnel.isAvailable()) {
      tunnel.start(s.id, internalListenPort(s))
        .catch(err => console.warn('[restart] tunnel:', err.message));
    }
    if (s.playit_secret && playit.isAvailable()) {
      playit.start(s.id, internalListenPort(s), s.playit_secret)
        .catch(err => console.warn('[restart] playit:', err.message));
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message || 'restart failed' });
  }
});

router.delete('/:id', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  tunnel.stop(s.id);
  playit.stop(s.id);
  await dc.removeServer(s);
  if (s.proxy_id && railway.isConfigured()) {
    try { await railway.deleteTcpProxy(s.proxy_id); }
    catch (err) { console.warn('[delete] proxy cleanup failed:', err.message); }
  }
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  audit(req.user.id, 'server.delete', s.id, req.ip);
  res.json({ ok: true });
});

router.get('/:id/status', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  try {
    const stats = await dc.getStats(s);
    res.json({ ...s, stats, public_host: publicHost() });
  } catch (err) {
    res.json({ ...s, stats: null, error: err.message });
  }
});

// Promote this server to the public TCP port. Demotes any other server.
router.post('/:id/promote', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const prev = db.prepare('SELECT id, container_id FROM servers WHERE is_public = 1').get();
  db.prepare('UPDATE servers SET is_public = 0').run();
  db.prepare('UPDATE servers SET is_public = 1 WHERE id = ?').run(s.id);
  audit(req.user.id, 'server.promote', s.id, req.ip, { previous_public: prev?.id });
  // Restart this server so the JVM binds to the public MC_PORT
  try {
    if (s.container_id && !String(s.container_id).startsWith('stub-')) {
      await dc.restartServer({ ...s, is_public: 1 });
    }
  } catch (err) {
    // best-effort
  }
  res.json({ ok: true, public_host: publicHost(), mc_port: parseInt(process.env.MC_PORT || '25565', 10) });
});

// PATCH /api/servers/:id — update live settings (motd, difficulty, gamemode,
// max_players, whitelist, pvp, hardcore, view_distance). Persists to DB +
// rewrites server.properties on disk. Optionally restarts if currently running.
router.patch('/:id', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const allowed = ['motd', 'difficulty', 'gamemode', 'max_players', 'whitelist', 'pvp', 'hardcore', 'view_distance', 'simulation_distance', 'scheduled_restart_at'];
  const updates = {};
  for (const key of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields' });

  // Validate
  if (updates.difficulty != null && !['peaceful','easy','normal','hard'].includes(updates.difficulty))
    return res.status(400).json({ error: 'Invalid difficulty' });
  if (updates.gamemode != null && !['survival','creative','adventure','spectator'].includes(updates.gamemode))
    return res.status(400).json({ error: 'Invalid gamemode' });
  if (updates.max_players != null) {
    const n = parseInt(updates.max_players, 10);
    if (isNaN(n) || n < 1 || n > 999) return res.status(400).json({ error: 'Invalid max_players' });
    updates.max_players = n;
  }
  if (updates.motd != null) {
    // Allow up to 120 chars so the user can use color codes (each "&X" is 2 chars).
    // Convert &-codes to §-codes on the way in so MC renders them as colors.
    updates.motd = String(updates.motd)
      .slice(0, 120)
      .replace(/[\n\r]/g, ' ')
      .replace(/&([0-9a-fk-or])/gi, '§$1');
  }
  for (const k of ['whitelist', 'pvp', 'hardcore']) {
    if (updates[k] != null) updates[k] = updates[k] ? 1 : 0;
  }

  // Validate scheduled_restart_at — must match HH:MM (UTC) or be empty (=disable).
  if (updates.scheduled_restart_at !== undefined) {
    const v = updates.scheduled_restart_at;
    if (v === '' || v === null) updates.scheduled_restart_at = null;
    else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) {
      return res.status(400).json({ error: 'scheduled_restart_at must be HH:MM (24h UTC) or empty to disable' });
    }
  }

  // DB columns vs flags-only. We have: motd, difficulty, gamemode, max_players,
  // whitelist, scheduled_restart_at. Others (pvp, hardcore, view_distance) live
  // only in server.properties.
  const dbCols = ['motd', 'difficulty', 'gamemode', 'max_players', 'whitelist', 'scheduled_restart_at'];
  const dbSets = [];
  const dbVals = [];
  for (const k of dbCols) {
    if (updates[k] !== undefined) { dbSets.push(`${k} = ?`); dbVals.push(updates[k]); }
  }
  if (dbSets.length) {
    dbVals.push(s.id);
    db.prepare(`UPDATE servers SET ${dbSets.join(', ')} WHERE id = ?`).run(...dbVals);
  }

  // Rewrite server.properties (preserve unknown lines)
  const path = require('path');
  const fs = require('fs');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  const propPath = path.join(DATA_DIR, s.id, 'server.properties');
  let props = {};
  if (fs.existsSync(propPath)) {
    fs.readFileSync(propPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) props[m[1].trim()] = m[2];
    });
  }
  // Apply updates with the right key names + types
  const merged = { ...s, ...updates };
  if (updates.motd !== undefined) props['motd'] = merged.motd;
  if (updates.difficulty !== undefined) props['difficulty'] = merged.difficulty;
  if (updates.gamemode !== undefined) props['gamemode'] = merged.gamemode;
  if (updates.max_players !== undefined) props['max-players'] = String(merged.max_players);
  if (updates.whitelist !== undefined) {
    props['white-list'] = merged.whitelist ? 'true' : 'false';
    if (merged.whitelist) props['enforce-whitelist'] = 'true';
  }
  if (updates.pvp !== undefined) props['pvp'] = updates.pvp ? 'true' : 'false';
  if (updates.hardcore !== undefined) props['hardcore'] = updates.hardcore ? 'true' : 'false';
  if (updates.view_distance !== undefined) {
    const v = Math.max(3, Math.min(32, parseInt(updates.view_distance, 10) || 8));
    props['view-distance'] = String(v);
  }
  if (updates.simulation_distance !== undefined) {
    const v = Math.max(3, Math.min(32, parseInt(updates.simulation_distance, 10) || 6));
    props['simulation-distance'] = String(v);
  }
  try {
    fs.mkdirSync(path.dirname(propPath), { recursive: true });
    fs.writeFileSync(propPath, Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  } catch (err) {
    return res.status(500).json({ error: 'Could not write server.properties' });
  }

  audit(req.user.id, 'server.settings', s.id, req.ip, updates);

  // Optionally restart to apply (most server.properties changes need a restart)
  let restarted = false;
  if (req.body?.restart && s.container_id && !String(s.container_id).startsWith('stub-')) {
    try {
      const fresh = getOwnedServer(req, res); // refetch with new DB state
      await dc.restartServer(fresh);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
      restarted = true;
    } catch {}
  }

  const final = db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id);
  res.json({ ok: true, server: final, restarted });
});

// GET /api/servers/:id/progress — synthesize deploy phases (port reserved →
// JAR downloaded → world prepared → JVM ready → tunnel open). Polled by the
// wizard's live progress screen so the user can see what's happening during
// the 30–60s boot instead of staring at a spinner.
router.get('/:id/progress', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const path = require('path');
  const fs = require('fs');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  const id = String(s.container_id || '').replace(/^jvm-/, '') || s.id;
  const state = require('../lib/jvm-controller').__getState(id);
  const logs = (state?.logs || []).join('\n');

  const jarPath = path.join(DATA_DIR, s.id, 'server.jar');
  let jarSizeMb = 0;
  try {
    if (fs.existsSync(jarPath)) jarSizeMb = Math.round(fs.statSync(jarPath).size / (1024 * 1024));
  } catch {}
  const jarReady = jarSizeMb > 0;
  const worldReady = /Preparing level|Preparing start region|Loaded \d+ recipes/.test(logs);
  const jvmReady = state?.ready === true || /Done \([\d.]+s\)!/i.test(logs);
  const tunnelOpen = !!(s.tunnel_host && s.tunnel_port);

  const phases = [
    { id: 'port',    label: 'Reserve internal port',   done: !!s.port },
    { id: 'jar',     label: jarReady ? `Download server JAR (${jarSizeMb} MB)` : 'Download server JAR', done: jarReady },
    { id: 'world',   label: 'Create world files',      done: worldReady },
    { id: 'jvm',     label: 'Start Minecraft server',  done: jvmReady },
    { id: 'tunnel',  label: 'Open public address',     done: tunnelOpen },
  ];
  let foundCurrent = false;
  for (const p of phases) {
    if (!p.done && !foundCurrent) { p.current = true; foundCurrent = true; }
  }

  res.json({
    phases,
    ready: jvmReady && tunnelOpen,
    status: s.status,
    address: tunnelOpen ? `${s.tunnel_host}:${s.tunnel_port}` : null,
    port: s.port,
    oom: !!state?.oom,
    exit_code: state?.exitCode ?? null,
    last_log: (state?.logs || []).slice(-5),
  });
});

// GET /api/servers/:id/logs?lines=200 — return the last N log lines from the JVM
// ring buffer. Used for debugging server boot failures from outside.
router.get('/:id/logs', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const n = Math.min(parseInt(req.query.lines || '200', 10), 1000);
  try {
    const id = String(s.container_id || '').replace(/^jvm-/, '') || s.id;
    const state = require('../lib/jvm-controller').__getState(id);
    res.json({ logs: state?.logs ? state.logs.slice(-n) : [], note: state ? null : 'no live process state (server may not be running)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/events — last 50 player join/leave/chat events.
// Parsed live from the JVM stdout ring; persists across log-ring rotation.
router.get('/:id/events', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const n = Math.min(parseInt(req.query.limit || '50', 10), 200);
  try {
    const id = String(s.container_id || '').replace(/^jvm-/, '') || s.id;
    const state = require('../lib/jvm-controller').__getState(id);
    res.json({ events: state?.events ? state.events.slice(-n) : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/players — per-player data: name, IP, first seen,
// last seen, total session count. Persists across restarts (read from
// player_events table). Owner-only.
router.get('/:id/players', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  try {
    const rows = db.prepare(`
      SELECT
        player,
        MIN(ts)  AS first_seen,
        MAX(ts)  AS last_seen,
        SUM(CASE WHEN event='join'  THEN 1 ELSE 0 END) AS joins,
        SUM(CASE WHEN event='leave' THEN 1 ELSE 0 END) AS leaves,
        SUM(CASE WHEN event='chat'  THEN 1 ELSE 0 END) AS messages,
        (SELECT ip FROM player_events
          WHERE server_id=? AND player=pe.player AND ip IS NOT NULL
          ORDER BY ts DESC LIMIT 1) AS last_ip
      FROM player_events pe
      WHERE server_id = ?
      GROUP BY player
      ORDER BY last_seen DESC
      LIMIT 100
    `).all(s.id, s.id);
    res.json({ players: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/players/:name — full timeline of one specific player
// on this server (every join, leave, chat with timestamp + IP).
router.get('/:id/players/:name', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  try {
    const rows = db.prepare(`
      SELECT event, ip, message, ts
        FROM player_events
       WHERE server_id = ? AND player = ?
       ORDER BY ts DESC
       LIMIT 500
    `).all(s.id, req.params.name);
    res.json({ player: req.params.name, events: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/servers/:id/webhook — set or clear the Discord webhook URL for
// this server. Owner-only. Body: { url: "https://discord.com/api/webhooks/..." | "" }
router.patch('/:id/webhook', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const url = String(req.body?.url || '').trim();
  if (url && !/^https:\/\/(discord(app)?\.com|ptb\.discord\.com)\/api\/webhooks\//i.test(url)) {
    return res.status(400).json({ error: 'Must be a https://discord.com/api/webhooks/... URL or empty to clear' });
  }
  db.prepare('UPDATE servers SET discord_webhook = ? WHERE id = ?').run(url || null, s.id);
  audit(req.user.id, 'server.discord_webhook', s.id, req.ip, { set: !!url });
  res.json({ ok: true, set: !!url });
});

// GET /api/servers/:id/diag — live debug snapshot: tunnel state, JVM port
// reachability, DNS, etc. Owner-only.
router.get('/:id/diag', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const net = require('net');
  const dns = require('dns/promises');
  const internalPort = internalListenPort(s);

  function probe(host, port, timeout = 4000) {
    return new Promise(resolve => {
      const sock = net.connect({ host, port });
      sock.setTimeout(timeout);
      sock.on('connect', () => { sock.destroy(); resolve({ ok: true }); });
      sock.on('error', err => resolve({ ok: false, err: err.message, code: err.code }));
      sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, err: 'timeout' }); });
    });
  }

  const tunnelState = tunnel.info(s.id);
  const localCheck = await probe('127.0.0.1', internalPort);
  const remoteCheck = s.tunnel_port ? await probe(s.tunnel_host, s.tunnel_port, 6000) : null;
  let dnsLookup = null;
  try { dnsLookup = await dns.lookup(s.tunnel_host || 'bore.pub', { all: true }); }
  catch (e) { dnsLookup = { err: e.message }; }

  res.json({
    server_id: s.id,
    internal_port: internalPort,
    tunnel_host: s.tunnel_host,
    tunnel_port: s.tunnel_port,
    tunnel_proc_alive: !!tunnelState,
    local_jvm_reachable: localCheck,
    public_tunnel_reachable_from_container: remoteCheck,
    bore_dns: dnsLookup,
  });
});

// GET /api/servers/:id/properties — return the live server.properties as a dict
router.get('/:id/properties', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const path = require('path');
  const fs = require('fs');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  const propPath = path.join(DATA_DIR, s.id, 'server.properties');
  if (!fs.existsSync(propPath)) return res.json({ properties: {} });
  const props = {};
  fs.readFileSync(propPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) props[m[1].trim()] = m[2];
  });
  res.json({ properties: props });
});

// Swap the server's JAR (paper/vanilla/purpur/fabric + version). Wipes server.jar then restarts.
// POST /api/servers/:id/playit/auto-enable
// One-click Bedrock enable using the OPERATOR's shared playit secret
// (PLAYIT_SHARED_SECRET env var). Skips the per-server claim flow entirely.
// If the env var isn't set, the UI falls back to the claim flow.
router.post('/:id/playit/auto-enable', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const sharedSecret = getSharedPlayitSecret();
  if (!sharedSecret) {
    return res.status(503).json({ error: 'no shared playit secret yet — fall back to claim flow (the first owner claim captures it)' });
  }
  if (!playit.isAvailable()) {
    return res.status(503).json({ error: 'playit agent not installed' });
  }
  try {
    db.prepare('UPDATE servers SET playit_secret = ? WHERE id = ?').run(sharedSecret, s.id);
    audit(req.user.id, 'server.playit_auto_enable', s.id, req.ip);
    // Hot-start agent if server is running
    if (['online', 'running', 'starting'].includes(s.status) && !playit.info(s.id)) {
      playit.start(s.id, internalListenPort(s), sharedSecret)
        .catch(err => console.warn('[playit auto-enable] hot-start:', err.message));
    }
    // Auto-install Geyser + Floodgate from cache
    seedDefaultPlugins(req.user.id, s.id, ['wKkoqHrH', 'bWrNNfkb'], s.version)
      .catch(err => console.warn('[playit auto-enable] plugin install:', err.message));
    const restartRequired = ['online', 'running'].includes(s.status);
    res.json({
      ok: true,
      mode: 'shared',
      restart_required: restartRequired,
      restart_reason: restartRequired ? 'Geyser + Floodgate installed — restart so the server loads them.' : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'auto-enable failed' });
  }
});

// POST /api/servers/:id/playit/claim/start
// Kicks off the playit.gg claim flow for this server. Returns { code, url }
// — the user visits the URL, signs into playit.gg, and approves. The agent
// then receives a permanent secret which we store in servers.playit_secret.
// The exchange runs in the background for up to 5 minutes.
router.post('/:id/playit/claim/start', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  if (!playit.isAvailable()) return res.status(503).json({ error: 'playit agent not installed' });
  try {
    const out = playit.claimStart(s.id, `CraftHost-${s.name || s.id.slice(0,8)}`);
    audit(req.user.id, 'server.playit_claim_start', s.id, req.ip);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message || 'claim start failed' });
  }
});

// GET /api/servers/:id/playit/claim/status
// Polled by the UI while the user is approving the claim. Returns one of:
//   { status: 'pending', claim_url, code, elapsed_sec }
//   { status: 'connected', secret_set: true, plugins_installed: [...] }
//   { status: 'expired' | 'failed', error?, claim_url, code }
//   { status: 'none' } — no claim in flight, no secret saved
//
// On first 'connected' detection, auto-installs Geyser + Floodgate from the
// plugin cache so Bedrock cross-play works without a separate trip to the
// marketplace. Restart hint surfaced in the response.
const BEDROCK_PLUGINS = ['wKkoqHrH', 'bWrNNfkb']; // Geyser, Floodgate
router.get('/:id/playit/claim/status', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  try {
    const out = playit.claimStatus(s.id);
    if (out.status === 'connected' && playit.isAvailable()) {
      // Hot-start agent if server is running
      const fresh = db.prepare('SELECT playit_secret FROM servers WHERE id = ?').get(s.id);
      if (fresh?.playit_secret && ['online', 'running', 'starting'].includes(s.status) && !playit.info(s.id)) {
        playit.start(s.id, internalListenPort(s), fresh.playit_secret)
          .catch(err => console.warn('[playit claim] hot-start:', err.message));
      }
      // Capture the owner's secret as the shared one (once) so every future
      // server can auto-enable Bedrock with no extra playit.gg approval.
      if (fresh?.playit_secret && isUnlimitedUser(req.user) && !getSharedPlayitSecret()) {
        setSharedPlayitSecret(fresh.playit_secret);
        console.log('[playit] captured owner secret as shared — Bedrock is now one-click for all servers');
      }
      // Auto-install Geyser + Floodgate from the per-MC plugin cache. Idempotent —
      // re-running is harmless (cache hardlink errors on EEXIST are swallowed).
      // Done once per claim by tracking on the playit state via the request.
      const path = require('path');
      const fs = require('fs');
      const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
      const pluginsDir = path.join(DATA_DIR, s.id, 'plugins');
      const geyserInstalled = fs.existsSync(pluginsDir) && fs.readdirSync(pluginsDir).some(f => /geyser/i.test(f));
      const floodgateInstalled = fs.existsSync(pluginsDir) && fs.readdirSync(pluginsDir).some(f => /floodgate/i.test(f));
      out.bedrock_plugins = { geyser: geyserInstalled, floodgate: floodgateInstalled };
      if (!geyserInstalled || !floodgateInstalled) {
        seedDefaultPlugins(req.user.id, s.id, BEDROCK_PLUGINS, s.version)
          .then(() => console.log(`[playit claim] auto-installed Geyser+Floodgate for ${s.id}`))
          .catch(err => console.warn(`[playit claim] plugin auto-install failed:`, err.message));
        out.bedrock_plugins.installing = true;
      }
      // Restart hint — if server's online, plugins need a reload to take effect
      if (['online', 'running'].includes(s.status)) {
        out.restart_required = true;
        out.restart_reason = 'Geyser + Floodgate plugins installed — restart the server so it loads them.';
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message || 'claim status failed' });
  }
});

// POST /api/servers/:id/playit/claim/cancel
router.post('/:id/playit/claim/cancel', (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  playit.claimCancel(s.id);
  res.json({ ok: true });
});

// POST /api/servers/:id/playit  { secret: '<playit.gg secret>' | null }
// Set or clear the playit.gg agent secret for this server. Storing a secret
// enables Bedrock cross-play (UDP tunnel via playit.gg) the next time the
// server starts. Setting null disables it + stops any running agent.
router.post('/:id/playit', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const { secret } = req.body || {};
  if (secret && typeof secret !== 'string') {
    return res.status(400).json({ error: 'secret must be a string or null' });
  }
  const cleaned = secret ? secret.trim() : null;
  if (cleaned && (cleaned.length < 8 || cleaned.length > 512)) {
    return res.status(400).json({ error: 'secret length out of range' });
  }
  try {
    db.prepare('UPDATE servers SET playit_secret = ?, playit_host = NULL, playit_port = NULL WHERE id = ?')
      .run(cleaned || null, s.id);
    if (!cleaned) {
      playit.stop(s.id);
    } else if (s.status === 'online' || s.status === 'running' || s.status === 'starting') {
      // Hot-start the agent if the server is already running
      if (playit.isAvailable()) {
        playit.start(s.id, internalListenPort(s), cleaned)
          .catch(err => console.warn('[playit set] hot-start:', err.message));
      }
    }
    audit(req.user.id, 'server.playit_set', s.id, req.ip, { enabled: !!cleaned });
    res.json({ ok: true, enabled: !!cleaned, available: playit.isAvailable() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'failed to update playit secret' });
  }
});

router.post('/:id/swap-jar', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const { type, version } = req.body || {};
  if (!type) return res.status(400).json({ error: 'Missing type' });
  const allowed = new Set(['paper', 'vanilla', 'purpur', 'fabric', 'spigot', 'forge', 'neoforge']);
  if (!allowed.has(type)) return res.status(400).json({ error: 'Unsupported type' });

  const path = require('path');
  const fsp = require('fs/promises');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');

  try {
    // Stop, wipe server.jar + type-specific configs, persist new fields, restart.
    await dc.stopServer(s);
    const serverRoot = path.join(DATA_DIR, s.id);
    await fsp.unlink(path.join(serverRoot, 'server.jar')).catch(() => {});
    // CRITICAL: when swapping types (e.g. purpur → paper), wipe type-specific
    // config files. Purpur writes paper-world-defaults.yml entries with string
    // "default" values that Paper 1.20.1 can't parse — `NumberFormatException`
    // — and the new JVM crashes on boot. Wipe them so the new JAR writes clean
    // defaults. World data + plugins are PRESERVED.
    const STALE_CONFIGS = [
      'paper-global.yml', 'paper-world-defaults.yml',
      'purpur.yml', 'pufferfish.yml',
      'spigot.yml', 'bukkit.yml', 'commands.yml', 'help.yml',
      'config', // per-world paper config dir
    ];
    for (const f of STALE_CONFIGS) {
      try { await fsp.rm(path.join(serverRoot, f), { recursive: true, force: true }); } catch {}
    }

    // Cross-engine swap from a Paper-family engine to Vanilla: Paper writes a
    // `paper` datapack reference into level.dat, and Vanilla refuses to boot
    // with "Missing data pack paper / Overworld settings missing". Vanilla's
    // own escape hatch is `--safeMode` (resets WorldGen settings, keeps chunks).
    // Drop a one-shot sentinel that the controller consumes on next boot.
    const PAPER_FAMILY = new Set(['paper', 'purpur', 'spigot', 'fabric']);
    if (PAPER_FAMILY.has(s.type) && type === 'vanilla') {
      // Paper writes its WorldGenSettings into level.dat with paper-namespace
      // dimension references. Vanilla refuses to boot with "Overworld settings
      // missing". --safeMode is not enough — it ignores datapacks but the
      // level.dat references are still evaluated. The pragmatic fix: wipe
      // level.dat so Vanilla regenerates clean defaults. CHUNKS (region/*.mca)
      // and PLAYER DATA (playerdata/) are preserved — only the world seed,
      // spawn point, game time, and gamerules reset to vanilla defaults.
      try {
        await fsp.writeFile(path.join(serverRoot, '.crafthost-vanilla-safemode'), String(Date.now()));
      } catch {}
      try { await fsp.rm(path.join(serverRoot, 'world', 'datapacks'),    { recursive: true, force: true }); } catch {}
      try { await fsp.rm(path.join(serverRoot, 'world', 'data'),         { recursive: true, force: true }); } catch {}
      try { await fsp.rm(path.join(serverRoot, 'world', 'level.dat'),    { recursive: true, force: true }); } catch {}
      try { await fsp.rm(path.join(serverRoot, 'world', 'level.dat_old'),{ recursive: true, force: true }); } catch {}
    }

    db.prepare('UPDATE servers SET type = ?, version = ?, status = ? WHERE id = ?')
      .run(type, version || null, 'starting', s.id);
    const updated = { ...s, type, version: version || null };
    const r = await dc.startServer(updated);
    if (r.containerId && r.containerId !== s.container_id) {
      db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(r.containerId, s.id);
    }
    audit(req.user.id, 'server.swap_jar', s.id, req.ip, { type, version });
    res.json({ ok: true, type, version, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message || 'swap-jar failed' });
  }
});

// POST /api/servers/:id/import-world  (multipart: field "world", a .zip)
// Stops the server, wipes existing world dirs, extracts the zip into the server
// data dir, then restarts. Supports two zip layouts:
//   1) The zip contains a top-level "world/" dir (and optionally world_nether/,
//      world_the_end/) — extracted as-is.
//   2) The zip contents are world internals directly (region/, level.dat,
//      playerdata/, etc.) — wrapped into a "world/" dir during extraction.
// Returns { ok, restored: { world?: count, world_nether?: count, ... }, size }.
router.post('/:id/import-world', worldUpload.single('world'), async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  if (!req.file) return res.status(400).json({ error: 'No "world" file in upload' });

  const fsp = require('fs/promises');
  const fs = require('fs');
  const path = require('path');
  const AdmZip = require('adm-zip');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  const root = path.join(DATA_DIR, s.id);

  async function rmTree(p) { try { await fsp.rm(p, { recursive: true, force: true }); } catch {} }

  try {
    // 1) Stop the server (no-op if already stopped).
    try { await dc.stopServer(s); } catch (err) { console.warn('[import-world] stop failed:', err.message); }

    // 2) Crack the zip and figure out its layout.
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();
    if (!entries.length) return res.status(400).json({ error: 'Empty zip' });

    // Detect layout: check if any entry path starts with "world/" or "world_nether/" etc.
    const dimDirs = ['world', 'world_nether', 'world_the_end'];
    const detectedDims = new Set();
    for (const e of entries) {
      const top = e.entryName.replace(/^\/+/, '').split('/')[0];
      if (dimDirs.includes(top)) detectedDims.add(top);
    }
    const isWrappedLayout = detectedDims.size > 0;
    // Heuristic for the "internals at root" layout: see if `level.dat` is at the
    // top level or under a single dir.
    let internalsRootPrefix = null;
    if (!isWrappedLayout) {
      const levelDatEntry = entries.find(e => /(^|\/)level\.dat$/.test(e.entryName));
      if (levelDatEntry) {
        internalsRootPrefix = path.posix.dirname('/' + levelDatEntry.entryName).replace(/^\//, '');
        // Empty prefix means level.dat is at the very root.
      } else {
        return res.status(400).json({ error: 'Zip does not look like a Minecraft world (no level.dat found; expected world/level.dat or level.dat at root)' });
      }
    }

    // 3) Wipe existing world dirs so we start clean.
    for (const d of dimDirs) await rmTree(path.join(root, d));

    // 4) Extract.
    const restored = {};
    if (isWrappedLayout) {
      // Extract only world/, world_nether/, world_the_end/ entries to root.
      for (const e of entries) {
        if (e.isDirectory) continue;
        const name = e.entryName.replace(/^\/+/, '');
        const top = name.split('/')[0];
        if (!dimDirs.includes(top)) continue;
        const dest = path.join(root, name);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.getData());
        restored[top] = (restored[top] || 0) + 1;
      }
    } else {
      // Internals layout — extract into a fresh world/ dir.
      const prefix = internalsRootPrefix ? internalsRootPrefix.replace(/\/+$/, '') + '/' : '';
      for (const e of entries) {
        if (e.isDirectory) continue;
        const name = e.entryName.replace(/^\/+/, '');
        if (prefix && !name.startsWith(prefix)) continue;
        const rel = prefix ? name.slice(prefix.length) : name;
        if (!rel) continue;
        const dest = path.join(root, 'world', rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.getData());
      }
      restored.world = entries.length;
    }

    // 5) Cleanup uploaded temp + restart.
    try { await fsp.unlink(req.file.path); } catch {}
    audit(req.user.id, 'server.world_import', s.id, req.ip, { size: req.file.size, restored });
    try {
      const updated = db.prepare('SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s JOIN plans p ON s.plan_id = p.id WHERE s.id = ?').get(s.id);
      const r = await dc.startServer(updated);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
      if (r?.containerId && r.containerId !== s.container_id) {
        db.prepare('UPDATE servers SET container_id = ? WHERE id = ?').run(r.containerId, s.id);
      }
    } catch (err) {
      console.warn('[import-world] restart failed:', err.message);
    }
    res.json({ ok: true, restored, size: req.file.size });
  } catch (err) {
    try { await fsp.unlink(req.file.path); } catch {}
    res.status(500).json({ error: err.message || 'World import failed' });
  }
});

// POST /api/servers/:id/icon (multipart: field "icon", a PNG)
// Saves it as server-icon.png in the server data dir. MC reads this file
// automatically on join and displays it in the player's server list.
// Validates: PNG magic bytes, max 256KB. Doesn't enforce 64x64 — Paper handles
// resizing, and we'd need a native image lib to check dimensions.
router.post('/:id/icon', iconUpload.single('icon'), async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  if (!req.file) return res.status(400).json({ error: 'No "icon" file in upload' });
  const fsp = require('fs/promises');
  const path = require('path');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  try {
    const buf = await fsp.readFile(req.file.path);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIG)) {
      try { await fsp.unlink(req.file.path); } catch {}
      return res.status(400).json({ error: 'File is not a PNG' });
    }
    const dest = path.join(DATA_DIR, s.id, 'server-icon.png');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    try { await fsp.unlink(req.file.path); } catch {}
    audit(req.user.id, 'server.icon_set', s.id, req.ip, { size: buf.length });
    res.json({ ok: true, size: buf.length });
  } catch (err) {
    try { await fsp.unlink(req.file.path); } catch {}
    res.status(500).json({ error: err.message || 'Icon upload failed' });
  }
});

// DELETE /api/servers/:id/icon — remove the server-icon.png
router.delete('/:id/icon', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const fsp = require('fs/promises');
  const path = require('path');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  const dest = path.join(DATA_DIR, s.id, 'server-icon.png');
  try {
    await fsp.unlink(dest);
    audit(req.user.id, 'server.icon_clear', s.id, req.ip);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ ok: true, note: 'no icon was set' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:id/icon — fetch the icon. Public-cache for 1 minute (changes
// rarely). Returns 404 if not set, so the dashboard can fall back to a default.
router.get('/:id/icon', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const fsp = require('fs/promises');
  const path = require('path');
  const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
  const src = path.join(DATA_DIR, s.id, 'server-icon.png');
  try {
    const buf = await fsp.readFile(src);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(buf);
  } catch {
    res.status(404).json({ error: 'No icon set' });
  }
});

// GET /api/servers/backend — which runtime is active
router.get('/_/backend', async (req, res) => {
  const name = await dc.backendName();
  res.json({ backend: name });
});

router.post('/:id/console', async (req, res) => {
  const s = getOwnedServer(req, res); if (!s) return;
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'Missing command' });
  const resp = await dc.sendRcon(s, command);
  audit(req.user.id, 'server.rcon', s.id, req.ip, { command });
  res.json({ response: resp });
});

function audit(user_id, action, resource_id, ip, metadata) {
  // Audit failures must NEVER tank a request — wrap in try/catch. The audit
  // log is for forensic logging, not user-visible state. Under load (SQLite
  // locked), the insert can throw and we don't want that to surface as a 500.
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user_id, action, 'server', resource_id, ip || null, metadata ? JSON.stringify(metadata) : null);
  } catch (err) {
    console.warn(`[audit] ${action} ${resource_id}: ${err.message}`);
  }
}

module.exports = router;
module.exports.createServerForUser = createServerForUser;
