// Per-server TCP tunnel manager. Uses `bore` (https://github.com/ekzhang/bore)
// to expose each MC server's internal port via the free bore.pub relay so users
// get a real, sharable host:port that friends can paste into Minecraft.
//
// Lifecycle: start() when the JVM starts, stop() when the JVM stops. Process
// state held in-memory per server id; assigned host:port is persisted to the
// `servers` table (tunnel_host, tunnel_port) so the UI sees it across reloads.

const { spawn, execFileSync } = require('child_process');
const db = require('../db');

const TUNNEL_HOST = process.env.TUNNEL_HOST || 'bore.pub';
const BORE_BIN = process.env.BORE_BIN || 'bore';
const STARTUP_TIMEOUT_MS = 15_000;

// serverId → { proc, assignedPort, host }
const tunnels = new Map();

function isAvailable() {
  if (process.env.DISABLE_TUNNEL === '1') return false;
  try {
    execFileSync(BORE_BIN, ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

// Spawn a bore process forwarding the given local port to TUNNEL_HOST. Resolves
// once bore prints its assigned remote port. Stores it in DB + memory.
async function start(serverId, localPort) {
  if (!isAvailable()) return null;
  // Reuse if we already have one running for this server.
  const existing = tunnels.get(serverId);
  if (existing && !existing.proc.killed && existing.assignedPort) {
    return { host: existing.host, port: existing.assignedPort };
  }
  if (existing) tunnels.delete(serverId);

  const proc = spawn(BORE_BIN, ['local', String(localPort), '--to', TUNNEL_HOST], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { proc, assignedPort: null, host: TUNNEL_HOST };
  tunnels.set(serverId, state);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    const timer = setTimeout(() => {
      console.warn(`[tunnel] ${serverId}: timeout waiting for bore.pub assignment`);
      done(null);
    }, STARTUP_TIMEOUT_MS);

    function parseLine(line) {
      // bore 0.5 logs `bore.pub:0` as a "connecting" placeholder before the
      // real assignment shows up as `bore.pub:<port>`. Skip the 0 case.
      const m = line.match(/bore\.pub:(\d+)/i) || line.match(/remote_port[^0-9]*(\d+)/i);
      if (!m) return;
      const port = parseInt(m[1], 10);
      if (!port) return;
      state.assignedPort = port;
      try {
        db.prepare('UPDATE servers SET tunnel_host = ?, tunnel_port = ? WHERE id = ?')
          .run(TUNNEL_HOST, port, serverId);
      } catch (err) { console.warn('[tunnel] db update:', err.message); }
      clearTimeout(timer);
      console.log(`[tunnel] ${serverId}: ${TUNNEL_HOST}:${port} ← localhost:${localPort}`);
      done({ host: TUNNEL_HOST, port });
    }

    proc.stdout.on('data', (b) => String(b).split('\n').forEach(parseLine));
    proc.stderr.on('data', (b) => String(b).split('\n').forEach(parseLine));

    proc.on('exit', (code, sig) => {
      const hadPort = !!state.assignedPort;
      tunnels.delete(serverId);
      try { db.prepare('UPDATE servers SET tunnel_host = NULL, tunnel_port = NULL WHERE id = ?').run(serverId); } catch {}
      console.warn(`[tunnel] ${serverId}: bore exited (code=${code} sig=${sig} hadPort=${hadPort})`);
      if (!hadPort) done(null);
      // Auto-respawn if the MC server is still meant to be running.
      try {
        const srv = db.prepare(`SELECT status FROM servers WHERE id = ?`).get(serverId);
        if (srv && ['online', 'running', 'starting'].includes(srv.status)) {
          setTimeout(() => {
            start(serverId, localPort).catch(err => console.warn(`[tunnel] ${serverId}: respawn failed:`, err.message));
          }, 3000);
        }
      } catch {}
    });
    proc.on('error', (err) => {
      console.warn(`[tunnel] ${serverId}: spawn error:`, err.message);
      done(null);
    });
  });
}

function stop(serverId) {
  const t = tunnels.get(serverId);
  if (!t) return false;
  try { t.proc.kill('SIGTERM'); } catch {}
  tunnels.delete(serverId);
  try {
    db.prepare('UPDATE servers SET tunnel_host = NULL, tunnel_port = NULL WHERE id = ?').run(serverId);
  } catch {}
  return true;
}

function info(serverId) {
  const t = tunnels.get(serverId);
  if (!t || !t.assignedPort) return null;
  return { host: t.host, port: t.assignedPort, running: !t.proc.killed };
}

function list() {
  return [...tunnels.entries()].map(([id, t]) => ({
    server_id: id,
    host: t.host,
    port: t.assignedPort,
    running: !t.proc.killed,
  }));
}

module.exports = { isAvailable, start, stop, info, list };
