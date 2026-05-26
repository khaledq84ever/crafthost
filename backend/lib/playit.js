// Per-server playit.gg agent. Companion to lib/tunnel.js (bore). Adds the UDP
// support that bore lacks, so Geyser + Floodgate can serve Bedrock players
// (mobile / Xbox / Switch / PS) on the same Minecraft server that Java
// clients connect to via bore.pub.
//
// Two-phase setup (matches the playit.gg CLI design):
//
//   1. CLAIM PHASE — one-time per server, automated:
//      - claimStart(serverId)  → spawns `playit-cli claim generate`,
//                                returns { code, url } for the user to visit.
//                                Kicks off a background `claim exchange` that
//                                waits up to 5 minutes for approval, then
//                                stores the resulting secret in servers.playit_secret.
//      - claimStatus(serverId) → poll endpoint: returns 'pending' / 'connected' / 'expired'
//
//   2. RUN PHASE — every JVM start:
//      - start(serverId, localPort, secret) → spawns `playit-agent --secret <s>
//        --platform-docker -l <log>` alongside the JVM. Parses log file for the
//        assigned tunnel address, persists to DB.
//      - stop(serverId) → SIGTERMs the agent, clears tunnel from DB.

const { spawn, spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../db');

const PLAYIT_CLI = process.env.PLAYIT_CLI || 'playit-cli';
const PLAYIT_AGENT = process.env.PLAYIT_AGENT || 'playit-agent';
const STARTUP_TIMEOUT_MS = 30_000;

// playit REST API — used to CREATE the Bedrock tunnel and read its assigned
// public address. A freshly-claimed self-managed agent has zero tunnels, so the
// agent emits no address to scrape; we must provision one ourselves.
// Auth header is `Agent-Key <secret>`. Response envelope:
//   { status: 'success', data } | { status: 'fail', data } | { status: 'error', data }
const PLAYIT_API_BASE = process.env.PLAYIT_API_BASE || 'https://api.playit.gg';
// Geyser's default Bedrock UDP listen port. CraftHost doesn't override Geyser's
// config, so it binds 19132 inside the container; the tunnel forwards here.
const GEYSER_UDP_PORT = parseInt(process.env.GEYSER_PORT || '19132', 10);

async function apiCall(secret, apiPath, body = {}) {
  const r = await fetch(PLAYIT_API_BASE + apiPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Agent-Key ${String(secret).trim()}`,
    },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!j) throw new Error(`playit ${apiPath}: HTTP ${r.status} (non-JSON body)`);
  if (j.status === 'success') return j.data;
  const detail = typeof j.data === 'string' ? j.data : JSON.stringify(j.data);
  throw new Error(`playit ${apiPath} ${j.status}: ${detail}`);
}

// Ensure exactly one enabled Minecraft-Bedrock UDP tunnel exists for this agent,
// forwarding to the local Geyser UDP port. Reuses (and re-points) an existing
// tunnel rather than piling up duplicates — matches the one-shared-agent model.
// Returns { host, port } = the public Bedrock address, or throws.
async function ensureBedrockTunnel(secret, localPort = GEYSER_UDP_PORT) {
  const data = await apiCall(secret, '/agents/rundata', {});
  const agentId = data.agent_id;
  const status = data.account_status;
  if (['banned', 'account-delete-scheduled', 'agent-disabled'].includes(status)) {
    throw new Error(`playit account not usable (status=${status})`);
  }

  const addrOf = (t) => ({ host: t.assigned_domain, port: t.port && t.port.from });
  // This agent is dedicated to CraftHost Bedrock — any UDP tunnel on it is ours.
  let tun = (data.tunnels || []).find((t) => t.proto === 'udp');

  if (tun) {
    const needsFix = tun.local_port !== localPort
      || String(tun.local_ip) !== '127.0.0.1'
      || !!tun.disabled;
    if (needsFix) {
      await apiCall(secret, '/tunnels/update', {
        tunnel_id: tun.id, local_ip: '127.0.0.1', local_port: localPort,
        agent_id: agentId, enabled: true,
      });
      const fresh = await apiCall(secret, '/agents/rundata', {});
      tun = (fresh.tunnels || []).find((t) => t.id === tun.id) || tun;
    }
    return addrOf(tun);
  }

  // None yet — create it. alloc:null = the free shared/global allocation.
  await apiCall(secret, '/tunnels/create', {
    name: 'CraftHost Bedrock',
    tunnel_type: 'minecraft-bedrock',
    port_type: 'udp',
    port_count: 1,
    origin: { type: 'agent', data: { agent_id: agentId, local_ip: '127.0.0.1', local_port: localPort } },
    enabled: true,
    alloc: null,
    firewall_id: null,
    proxy_protocol: null,
  });

  // Allocation is usually instant, but poll a few times to be safe.
  for (let i = 0; i < 10; i++) {
    const fresh = await apiCall(secret, '/agents/rundata', {});
    const t = (fresh.tunnels || []).find((x) => x.proto === 'udp');
    if (t && t.assigned_domain && t.port && t.port.from) return addrOf(t);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('bedrock tunnel created but no address assigned yet');
}

// serverId → { proc, host, port, logPath, secret }
const agents = new Map();
// serverId → { code, url, started, exchangeProc }
const claims = new Map();

function isAvailable() {
  if (process.env.DISABLE_PLAYIT === '1') return false;
  try {
    execFileSync(PLAYIT_CLI, ['version'], { stdio: 'ignore', timeout: 4000 });
    execFileSync(PLAYIT_AGENT, ['--help'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch { return false; }
}

// ── CLAIM PHASE ──────────────────────────────────────────────────────────────

// Generate a claim code + URL for serverId. Spawns a background process that
// polls for the user's approval (up to 5 min) and stores the secret in DB on
// success. Returns immediately with { code, url } for the UI to display.
function claimStart(serverId, agentName) {
  // Wipe any previous in-flight claim
  const prev = claims.get(serverId);
  if (prev?.exchangeProc && !prev.exchangeProc.killed) {
    try { prev.exchangeProc.kill('SIGTERM'); } catch {}
  }
  // 1) generate
  const gen = spawnSync(PLAYIT_CLI, ['claim', 'generate'], { timeout: 5000 });
  if (gen.status !== 0) throw new Error(`claim generate failed: ${String(gen.stderr || gen.stdout).slice(0,200)}`);
  const code = String(gen.stdout).trim();
  if (!/^[a-z0-9]{6,32}$/i.test(code)) throw new Error(`unexpected claim code: ${code}`);

  // 2) build URL with a friendly agent name (visible in playit.gg dashboard)
  const name = (agentName || `CraftHost-${serverId.slice(0,8)}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const urlR = spawnSync(PLAYIT_CLI, ['claim', 'url', code, '--name', name], { timeout: 5000 });
  if (urlR.status !== 0) throw new Error(`claim url failed: ${String(urlR.stderr).slice(0,200)}`);
  const url = String(urlR.stdout).trim();

  // 3) background exchange — waits for user to visit the URL + approve
  const exchangeProc = spawn(PLAYIT_CLI, ['claim', 'exchange', code, '--wait', '300'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { code, url, started: Date.now(), exchangeProc, secret: null, error: null };
  claims.set(serverId, state);

  let buf = '';
  exchangeProc.stdout.on('data', (b) => { buf += String(b); });
  exchangeProc.on('exit', (exitCode) => {
    if (exitCode === 0) {
      // Last non-empty line is the secret
      const lines = buf.split('\n').map(s => s.trim()).filter(Boolean);
      const secret = lines[lines.length - 1];
      if (secret && secret.length >= 16) {
        state.secret = secret;
        try {
          db.prepare('UPDATE servers SET playit_secret = ? WHERE id = ?').run(secret, serverId);
          console.log(`[playit] ${serverId}: claim approved, secret stored (agent="${name}")`);
        } catch (err) {
          console.warn(`[playit] ${serverId}: db update failed:`, err.message);
          state.error = 'db update failed';
        }
      } else {
        state.error = 'exchange returned no secret';
      }
    } else {
      state.error = `exchange exited code=${exitCode}`;
      console.warn(`[playit] ${serverId}: claim exchange failed (${state.error})`);
    }
  });
  exchangeProc.on('error', (err) => {
    state.error = err.message;
    console.warn(`[playit] ${serverId}: exchange spawn err:`, err.message);
  });

  return { code, url };
}

function claimStatus(serverId) {
  const state = claims.get(serverId);
  if (!state) {
    // Check DB — maybe the claim completed in an earlier process and we're a fresh container
    const row = db.prepare('SELECT playit_secret FROM servers WHERE id = ?').get(serverId);
    if (row?.playit_secret) return { status: 'connected', secret_set: true };
    return { status: 'none', secret_set: false };
  }
  if (state.secret) return { status: 'connected', secret_set: true, claim_url: state.url, code: state.code };
  if (state.error) return { status: 'failed', error: state.error, claim_url: state.url, code: state.code };
  const elapsed = Date.now() - state.started;
  if (elapsed > 5 * 60 * 1000) return { status: 'expired', claim_url: state.url, code: state.code };
  return { status: 'pending', claim_url: state.url, code: state.code, elapsed_sec: Math.round(elapsed / 1000) };
}

function claimCancel(serverId) {
  const state = claims.get(serverId);
  if (state?.exchangeProc && !state.exchangeProc.killed) {
    try { state.exchangeProc.kill('SIGTERM'); } catch {}
  }
  claims.delete(serverId);
  return true;
}

// ── RUN PHASE ────────────────────────────────────────────────────────────────

async function start(serverId, localPort, secret) {
  if (!isAvailable()) return null;
  if (!secret) return null;

  const existing = agents.get(serverId);
  if (existing && !existing.proc.killed && existing.port) {
    return { host: existing.host, port: existing.port };
  }
  if (existing) agents.delete(serverId);

  // Agent log → /tmp (kept for debugging; the address comes from the API now).
  const logDir = path.join('/tmp', `playit-${serverId}`);
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logPath = path.join(logDir, 'agent.log');
  try { fs.writeFileSync(logPath, ''); } catch {}

  // Spawn the agent (data plane — it connects out to playit's relay and forwards
  // UDP to the local Geyser port). The PUBLIC address is provisioned + read via
  // the REST API below, not scraped from this log.
  const args = ['--secret', secret, '--platform-docker', '-l', logPath];
  const proc = spawn(PLAYIT_AGENT, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { proc, host: null, port: null, logPath, secret };
  agents.set(serverId, state);
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  proc.on('exit', (code, sig) => {
    const hadAddr = !!state.port;
    agents.delete(serverId);
    // Don't clear playit_host/port here: the tunnel persists on the playit
    // account and its address is stable across agent restarts. Only stop()
    // (explicit disable / server stop) clears it.
    console.warn(`[playit] ${serverId}: agent exited (code=${code} sig=${sig} hadAddr=${hadAddr})`);
    try {
      const srv = db.prepare('SELECT status, playit_secret FROM servers WHERE id = ?').get(serverId);
      if (srv?.playit_secret && ['online', 'running', 'starting'].includes(srv.status)) {
        setTimeout(() => {
          start(serverId, localPort, srv.playit_secret).catch(err => console.warn(`[playit] ${serverId}: respawn:`, err.message));
        }, 4000);
      }
    } catch {}
  });
  proc.on('error', (err) => { console.warn(`[playit] ${serverId}: spawn err:`, err.message); });

  // Provision the Bedrock tunnel + read its assigned address via the REST API.
  // Deterministic and fast — no 30s log-scrape timeout.
  try {
    const addr = await ensureBedrockTunnel(secret, GEYSER_UDP_PORT);
    if (addr && addr.host && addr.port) {
      state.host = addr.host; state.port = addr.port;
      try {
        db.prepare('UPDATE servers SET playit_host = ?, playit_port = ? WHERE id = ?')
          .run(addr.host, addr.port, serverId);
      } catch (err) { console.warn('[playit] db update:', err.message); }
      console.log(`[playit] ${serverId}: Bedrock @ ${addr.host}:${addr.port} → 127.0.0.1:${GEYSER_UDP_PORT}`);
      return addr;
    }
  } catch (err) {
    console.warn(`[playit] ${serverId}: ensureBedrockTunnel failed:`, err.message);
  }
  return null;
}

function stop(serverId) {
  const a = agents.get(serverId);
  if (!a) return false;
  try { a.proc.kill('SIGTERM'); } catch {}
  agents.delete(serverId);
  try { db.prepare('UPDATE servers SET playit_host = NULL, playit_port = NULL WHERE id = ?').run(serverId); } catch {}
  return true;
}

function info(serverId) {
  const a = agents.get(serverId);
  if (!a || !a.port) return null;
  return { host: a.host, port: a.port, running: !a.proc.killed };
}

function list() {
  return [...agents.entries()].map(([id, a]) => ({
    server_id: id, host: a.host, port: a.port, running: !a.proc.killed,
  }));
}

module.exports = {
  isAvailable,
  start, stop, info, list,
  claimStart, claimStatus, claimCancel,
  ensureBedrockTunnel, apiCall, GEYSER_UDP_PORT,
};
