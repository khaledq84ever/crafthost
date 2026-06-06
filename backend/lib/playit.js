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

const { spawn, spawnSync, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const db = require("../db");

const PLAYIT_CLI = process.env.PLAYIT_CLI || "playit-cli";
const PLAYIT_AGENT = process.env.PLAYIT_AGENT || "playit-agent";
const STARTUP_TIMEOUT_MS = 30_000;

// playit REST API — used to CREATE the Bedrock tunnel and read its assigned
// public address. A freshly-claimed self-managed agent has zero tunnels, so the
// agent emits no address to scrape; we must provision one ourselves.
// Auth header is `Agent-Key <secret>`. Response envelope:
//   { status: 'success', data } | { status: 'fail', data } | { status: 'error', data }
const PLAYIT_API_BASE = process.env.PLAYIT_API_BASE || "https://api.playit.gg";
// Geyser's default Bedrock UDP listen port. CraftHost doesn't override Geyser's
// config, so it binds 19132 inside the container; the tunnel forwards here.
const GEYSER_UDP_PORT = parseInt(process.env.GEYSER_PORT || "19132", 10);

async function apiCall(secret, apiPath, body = {}) {
  const r = await fetch(PLAYIT_API_BASE + apiPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Agent-Key ${String(secret).trim()}`,
    },
    body: JSON.stringify(body),
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (!j)
    throw new Error(`playit ${apiPath}: HTTP ${r.status} (non-JSON body)`);
  if (j.status === "success") return j.data;
  const detail = typeof j.data === "string" ? j.data : JSON.stringify(j.data);
  throw new Error(`playit ${apiPath} ${j.status}: ${detail}`);
}

// Ensure exactly one enabled Minecraft-Bedrock UDP tunnel exists for this agent,
// forwarding to the local Geyser UDP port. Reuses (and re-points) an existing
// tunnel rather than piling up duplicates — matches the one-shared-agent model.
// Returns { host, port } = the public Bedrock address, or throws.
async function ensureBedrockTunnel(secret, localPort = GEYSER_UDP_PORT) {
  const data = await apiCall(secret, "/agents/rundata", {});
  const agentId = data.agent_id;
  const status = data.account_status;
  if (
    ["banned", "account-delete-scheduled", "agent-disabled"].includes(status)
  ) {
    throw new Error(`playit account not usable (status=${status})`);
  }

  const addrOf = (t) => ({
    host: t.assigned_domain,
    port: t.port && t.port.from,
  });
  // This agent is dedicated to CraftHost Bedrock — any UDP tunnel on it is ours.
  let tun = (data.tunnels || []).find((t) => t.proto === "udp");

  if (tun) {
    const needsFix =
      tun.local_port !== localPort ||
      String(tun.local_ip) !== "127.0.0.1" ||
      !!tun.disabled;
    if (needsFix) {
      await apiCall(secret, "/tunnels/update", {
        tunnel_id: tun.id,
        local_ip: "127.0.0.1",
        local_port: localPort,
        agent_id: agentId,
        enabled: true,
      });
      const fresh = await apiCall(secret, "/agents/rundata", {});
      tun = (fresh.tunnels || []).find((t) => t.id === tun.id) || tun;
    }
    return addrOf(tun);
  }

  // None yet — create it. alloc:null = the free shared/global allocation.
  await apiCall(secret, "/tunnels/create", {
    name: "CraftHost Bedrock",
    tunnel_type: "minecraft-bedrock",
    port_type: "udp",
    port_count: 1,
    origin: {
      type: "agent",
      data: { agent_id: agentId, local_ip: "127.0.0.1", local_port: localPort },
    },
    enabled: true,
    alloc: null,
    firewall_id: null,
    proxy_protocol: null,
  });

  // Allocation is usually instant, but poll a few times to be safe.
  for (let i = 0; i < 10; i++) {
    const fresh = await apiCall(secret, "/agents/rundata", {});
    const t = (fresh.tunnels || []).find((x) => x.proto === "udp");
    if (t && t.assigned_domain && t.port && t.port.from) return addrOf(t);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("bedrock tunnel created but no address assigned yet");
}

// Per-server Bedrock UDP tunnel. Like ensureJavaTunnel but UDP + bedrock type,
// named chb-<serverId> and REUSED by name (never creates a duplicate), pointing
// at THIS server's unique Geyser UDP port. Gives each server its own Bedrock
// address — requires a playit plan that allows multiple UDP allocations.
async function ensureBedrockTunnelForServer(secret, serverId, localPort) {
  const name = `chb-${serverId}`;
  const data = await apiCall(secret, "/agents/rundata", {});
  const agentId = data.agent_id;
  const addrOf = (t) => ({
    host: t.assigned_domain,
    port: t.port && t.port.from,
  });
  let tun = (data.tunnels || []).find(
    (t) => t.proto === "udp" && t.name === name,
  );

  if (tun) {
    const needsFix =
      tun.local_port !== localPort ||
      String(tun.local_ip) !== "127.0.0.1" ||
      !!tun.disabled;
    if (needsFix) {
      await apiCall(secret, "/tunnels/update", {
        tunnel_id: tun.id,
        local_ip: "127.0.0.1",
        local_port: localPort,
        agent_id: agentId,
        enabled: true,
      });
      const fresh = await apiCall(secret, "/agents/rundata", {});
      tun = (fresh.tunnels || []).find((t) => t.id === tun.id) || tun;
    }
    return addrOf(tun);
  }

  await apiCall(secret, "/tunnels/create", {
    name,
    tunnel_type: "minecraft-bedrock",
    port_type: "udp",
    port_count: 1,
    origin: {
      type: "agent",
      data: { agent_id: agentId, local_ip: "127.0.0.1", local_port: localPort },
    },
    enabled: true,
    alloc: null,
    firewall_id: null,
    proxy_protocol: null,
  });
  for (let i = 0; i < 10; i++) {
    const fresh = await apiCall(secret, "/agents/rundata", {});
    const t = (fresh.tunnels || []).find(
      (x) => x.proto === "udp" && x.name === name,
    );
    if (t && t.assigned_domain && t.port && t.port.from) return addrOf(t);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    "per-server bedrock tunnel created but no address assigned yet",
  );
}

// serverId → { code, url, started, exchangeProc }
const claims = new Map();

function isAvailable() {
  if (process.env.DISABLE_PLAYIT === "1") return false;
  try {
    execFileSync(PLAYIT_CLI, ["version"], { stdio: "ignore", timeout: 4000 });
    execFileSync(PLAYIT_AGENT, ["--help"], { stdio: "ignore", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// ── CLAIM PHASE ──────────────────────────────────────────────────────────────

// Generate a claim code + URL for serverId. Spawns a background process that
// polls for the user's approval (up to 5 min) and stores the secret in DB on
// success. Returns immediately with { code, url } for the UI to display.
function claimStart(serverId, agentName) {
  // Wipe any previous in-flight claim
  const prev = claims.get(serverId);
  if (prev?.exchangeProc && !prev.exchangeProc.killed) {
    try {
      prev.exchangeProc.kill("SIGTERM");
    } catch {}
  }
  // 1) generate
  const gen = spawnSync(PLAYIT_CLI, ["claim", "generate"], { timeout: 5000 });
  if (gen.status !== 0)
    throw new Error(
      `claim generate failed: ${String(gen.stderr || gen.stdout).slice(0, 200)}`,
    );
  const code = String(gen.stdout).trim();
  if (!/^[a-z0-9]{6,32}$/i.test(code))
    throw new Error(`unexpected claim code: ${code}`);

  // 2) build URL with a friendly agent name (visible in playit.gg dashboard)
  const name = (agentName || `CraftHost-${serverId.slice(0, 8)}`).replace(
    /[^a-zA-Z0-9_-]/g,
    "",
  );
  const urlR = spawnSync(PLAYIT_CLI, ["claim", "url", code, "--name", name], {
    timeout: 5000,
  });
  if (urlR.status !== 0)
    throw new Error(`claim url failed: ${String(urlR.stderr).slice(0, 200)}`);
  const url = String(urlR.stdout).trim();

  // 3) background exchange — waits for user to visit the URL + approve
  const exchangeProc = spawn(
    PLAYIT_CLI,
    ["claim", "exchange", code, "--wait", "300"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const state = {
    code,
    url,
    started: Date.now(),
    exchangeProc,
    secret: null,
    error: null,
  };
  claims.set(serverId, state);

  let buf = "";
  exchangeProc.stdout.on("data", (b) => {
    buf += String(b);
  });
  exchangeProc.on("exit", (exitCode) => {
    if (exitCode === 0) {
      // Last non-empty line is the secret
      const lines = buf
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const secret = lines[lines.length - 1];
      if (secret && secret.length >= 16) {
        state.secret = secret;
        try {
          db.prepare("UPDATE servers SET playit_secret = ? WHERE id = ?").run(
            secret,
            serverId,
          );
          console.log(
            `[playit] ${serverId}: claim approved, secret stored (agent="${name}")`,
          );
        } catch (err) {
          console.warn(`[playit] ${serverId}: db update failed:`, err.message);
          state.error = "db update failed";
        }
      } else {
        state.error = "exchange returned no secret";
      }
    } else {
      state.error = `exchange exited code=${exitCode}`;
      console.warn(
        `[playit] ${serverId}: claim exchange failed (${state.error})`,
      );
    }
  });
  exchangeProc.on("error", (err) => {
    state.error = err.message;
    console.warn(`[playit] ${serverId}: exchange spawn err:`, err.message);
  });

  return { code, url };
}

function claimStatus(serverId) {
  const state = claims.get(serverId);
  if (!state) {
    // Check DB — maybe the claim completed in an earlier process and we're a fresh container
    const row = db
      .prepare("SELECT playit_secret FROM servers WHERE id = ?")
      .get(serverId);
    if (row?.playit_secret) return { status: "connected", secret_set: true };
    return { status: "none", secret_set: false };
  }
  if (state.secret)
    return {
      status: "connected",
      secret_set: true,
      claim_url: state.url,
      code: state.code,
    };
  if (state.error)
    return {
      status: "failed",
      error: state.error,
      claim_url: state.url,
      code: state.code,
    };
  const elapsed = Date.now() - state.started;
  if (elapsed > 5 * 60 * 1000)
    return { status: "expired", claim_url: state.url, code: state.code };
  return {
    status: "pending",
    claim_url: state.url,
    code: state.code,
    elapsed_sec: Math.round(elapsed / 1000),
  };
}

function claimCancel(serverId) {
  const state = claims.get(serverId);
  if (state?.exchangeProc && !state.exchangeProc.killed) {
    try {
      state.exchangeProc.kill("SIGTERM");
    } catch {}
  }
  claims.delete(serverId);
  return true;
}

// ── RUN PHASE ────────────────────────────────────────────────────────────────

// ONE singleton agent process serves ALL tunnels on the shared account (every
// server's Java TCP tunnel + the single Bedrock UDP tunnel). The same secret is
// one playit identity, so running multiple agents would conflict — we run
// exactly one. It's a tiny idle process when there's no traffic; once started we
// keep it alive (respawn on crash) rather than juggle per-server lifecycles.
let agentProc = null;
let agentWanted = false;
// serverId (or `${serverId}:java`) → { host, port } — last known live address.
const addrCache = new Map();

function ensureAgent(secret) {
  if (!isAvailable() || !secret) return null;
  agentWanted = true;
  if (agentProc && !agentProc.killed) return agentProc;

  const logDir = "/tmp/playit-agent";
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {}
  const logPath = path.join(logDir, "agent.log");
  try {
    fs.writeFileSync(logPath, "");
  } catch {}

  const proc = spawn(
    PLAYIT_AGENT,
    ["--secret", secret, "--platform-docker", "-l", logPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  agentProc = proc;
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  proc.on("error", (err) =>
    console.warn("[playit agent] spawn err:", err.message),
  );
  proc.on("exit", (code, sig) => {
    console.warn(`[playit agent] exited (code=${code} sig=${sig})`);
    if (agentProc === proc) agentProc = null;
    if (agentWanted)
      setTimeout(() => {
        try {
          ensureAgent(secret);
        } catch (e) {
          console.warn("[playit agent] respawn:", e.message);
        }
      }, 4000);
  });
  console.log("[playit agent] singleton agent started");
  return proc;
}

const agentRunning = () => !!(agentProc && !agentProc.killed);

// Ensure a per-server Minecraft-Java TCP tunnel forwarding to the server's local
// port. Reuses/re-points the tunnel named `chj-<serverId>`. Returns { host, port }.
async function ensureJavaTunnel(secret, serverId, localPort) {
  const name = `chj-${serverId}`;
  const data = await apiCall(secret, "/agents/rundata", {});
  const agentId = data.agent_id;
  const addrOf = (t) => ({
    host: t.assigned_domain,
    port: t.port && t.port.from,
  });
  let tun = (data.tunnels || []).find(
    (t) => t.proto === "tcp" && t.name === name,
  );

  if (tun) {
    const needsFix =
      tun.local_port !== localPort ||
      String(tun.local_ip) !== "127.0.0.1" ||
      !!tun.disabled;
    if (needsFix) {
      await apiCall(secret, "/tunnels/update", {
        tunnel_id: tun.id,
        local_ip: "127.0.0.1",
        local_port: localPort,
        agent_id: agentId,
        enabled: true,
      });
      const fresh = await apiCall(secret, "/agents/rundata", {});
      tun = (fresh.tunnels || []).find((t) => t.id === tun.id) || tun;
    }
    return addrOf(tun);
  }

  await apiCall(secret, "/tunnels/create", {
    name,
    tunnel_type: "minecraft-java",
    port_type: "tcp",
    port_count: 1,
    origin: {
      type: "agent",
      data: { agent_id: agentId, local_ip: "127.0.0.1", local_port: localPort },
    },
    enabled: true,
    alloc: null,
    firewall_id: null,
    proxy_protocol: null,
  });
  for (let i = 0; i < 10; i++) {
    const fresh = await apiCall(secret, "/agents/rundata", {});
    const t = (fresh.tunnels || []).find(
      (x) => x.proto === "tcp" && x.name === name,
    );
    if (t && t.assigned_domain && t.port && t.port.from) return addrOf(t);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("java tunnel created but no address assigned yet");
}

// ── RUN PHASE ────────────────────────────────────────────────────────────────

// Bedrock: ensure the agent + the (single, shared) Bedrock UDP tunnel. Persists
// the address to servers.playit_host/playit_port. `start` is the historical name.
// When BEDROCK_PER_SERVER=1 and a per-server Geyser UDP port is supplied, each
// server gets its OWN Bedrock tunnel/address (chb-<serverId>). Otherwise it uses
// the single shared tunnel on GEYSER_UDP_PORT — unchanged legacy behaviour.
const PER_SERVER_BEDROCK = process.env.BEDROCK_PER_SERVER === "1";
async function startBedrock(serverId, geyserPort, secret) {
  if (!isAvailable() || !secret) return null;
  ensureAgent(secret);
  const perServer =
    PER_SERVER_BEDROCK && Number.isInteger(geyserPort) && geyserPort > 0;
  const localPort = perServer ? geyserPort : GEYSER_UDP_PORT;
  try {
    const addr = perServer
      ? await ensureBedrockTunnelForServer(secret, serverId, localPort)
      : await ensureBedrockTunnel(secret, localPort);
    if (addr && addr.host && addr.port) {
      addrCache.set(serverId, addr);
      try {
        db.prepare(
          "UPDATE servers SET playit_host = ?, playit_port = ? WHERE id = ?",
        ).run(addr.host, addr.port, serverId);
      } catch (e) {
        console.warn("[playit] db update:", e.message);
      }
      console.log(
        `[playit] ${serverId}: Bedrock @ ${addr.host}:${addr.port} → 127.0.0.1:${localPort}${perServer ? " (per-server)" : " (shared)"}`,
      );
      return addr;
    }
  } catch (err) {
    console.warn(`[playit] ${serverId}: ensureBedrock failed:`, err.message);
  }
  return null;
}
const start = startBedrock;

// Java: ensure the agent + this server's Java TCP tunnel. Returns { host, port };
// the caller (public-tunnel) writes it to servers.tunnel_host/tunnel_port.
async function startJava(serverId, localPort, secret) {
  if (!isAvailable() || !secret) return null;
  ensureAgent(secret);
  try {
    const addr = await ensureJavaTunnel(secret, serverId, localPort);
    if (addr && addr.host && addr.port) {
      addrCache.set(`${serverId}:java`, addr);
      console.log(
        `[playit] ${serverId}: Java @ ${addr.host}:${addr.port} → 127.0.0.1:${localPort}`,
      );
      return addr;
    }
  } catch (err) {
    console.warn(`[playit] ${serverId}: ensureJavaTunnel failed:`, err.message);
  }
  return null;
}

// Bedrock stop / disable: clear the live Bedrock address. The agent stays up (it
// serves other servers' Java tunnels); the Bedrock tunnel persists on the account.
function stop(serverId) {
  addrCache.delete(serverId);
  try {
    db.prepare(
      "UPDATE servers SET playit_host = NULL, playit_port = NULL WHERE id = ?",
    ).run(serverId);
  } catch {}
  return true;
}

// Java stop: forwarding just fails while the JVM is down; we keep the tunnel
// (stable address, reused on restart) and only drop the cached live address.
function stopJava(serverId) {
  addrCache.delete(`${serverId}:java`);
  return true;
}

// On server DELETE: remove that server's Java tunnel from the account so we don't
// leak tunnels. The shared Bedrock tunnel is platform-wide — never deleted here.
async function deleteServerTunnels(secret, serverId) {
  if (!secret) return;
  try {
    const data = await apiCall(secret, "/agents/rundata", {});
    const name = `chj-${serverId}`;
    for (const t of (data.tunnels || []).filter((x) => x.name === name)) {
      try {
        await apiCall(secret, "/tunnels/delete", { tunnel_id: t.id });
      } catch (e) {
        console.warn("[playit] delete tunnel:", e.message);
      }
    }
  } catch (e) {
    console.warn("[playit] deleteServerTunnels:", e.message);
  }
}

// Per-server Geyser UDP port — mirrors jvm-controller.geyserUdpPort and
// routes/servers.bedrockLocalPort. Each server's Geyser binds a distinct local
// UDP port derived from its DB port; the per-server Bedrock tunnel forwards here.
function geyserUdpPortFor(server) {
  const off = Math.max(0, parseInt(server.port, 10) - 25565);
  return 40000 + (off % 20000);
}

// Boot reconcile (per-server Bedrock mode only). Guarantees every cross-play-
// enabled server owns a UNIQUE, working Bedrock address — independent of whether
// it's online — and clears the legacy sprawl that left Bedrock broken:
//
//  • Each server with a playit_secret gets/repairs its chb-<id> UDP tunnel
//    pointed at its OWN Geyser port (40xxx), and its address is persisted to
//    servers.playit_host/playit_port. This fixes servers that were stuck on the
//    old shared "CraftHost Bedrock" address (→ 127.0.0.1:19132), which now
//    forwards to a dead port because per-server Geyser binds 40xxx instead.
//  • Dead legacy shared UDP tunnels (local_port == GEYSER_UDP_PORT/19132) are
//    deleted — nothing binds 19132 in per-server mode.
//  • Duplicate chb-/chj- tunnels for the same server are pruned to one.
//
// Runs in the background, throttled, so it never blocks boot. Idempotent: the
// ensure* helpers reuse tunnels by name, so re-running just re-confirms.
async function reconcilePerServerBedrock(secret) {
  if (process.env.BEDROCK_PER_SERVER !== "1") return;
  if (!secret || !isAvailable()) return;
  try {
    ensureAgent(secret);
    let data = await apiCall(secret, "/agents/rundata", {});
    const tunnels = data.tunnels || [];

    // 1) Delete dead legacy shared UDP tunnels (forward to unused 19132).
    for (const t of tunnels) {
      if (t.proto === "udp" && t.local_port === GEYSER_UDP_PORT) {
        try {
          await apiCall(secret, "/tunnels/delete", { tunnel_id: t.id });
          console.log(
            `[playit reconcile] removed dead shared Bedrock tunnel "${t.name}" (→127.0.0.1:${GEYSER_UDP_PORT})`,
          );
        } catch (e) {
          console.warn("[playit reconcile] delete shared:", e.message);
        }
      }
    }

    // 2) Prune duplicate per-server tunnels (same name → keep first, drop rest).
    const seen = new Set();
    for (const t of tunnels) {
      if (!t.name || !/^ch[bj]-/.test(t.name)) continue;
      if (seen.has(t.name)) {
        try {
          await apiCall(secret, "/tunnels/delete", { tunnel_id: t.id });
          console.log(
            `[playit reconcile] pruned duplicate tunnel "${t.name}" (${t.assigned_domain}:${t.port && t.port.from})`,
          );
        } catch (e) {
          console.warn("[playit reconcile] prune dup:", e.message);
        }
      } else {
        seen.add(t.name);
      }
    }

    // 2b) Sweep orphaned per-server tunnels — chj-/chb-<id> whose server was
    // deleted. ensure*/reconcile only ever CREATE these, never remove them when a
    // server is gone, so dead chj-* (Java/TCP) and chb-* (Bedrock/UDP) tunnels
    // accumulate forever and burn the account's tunnel/port quota. Match the id
    // out of the name and drop any tunnel with no matching server row.
    let validIds = null;
    try {
      validIds = new Set(
        db
          .prepare("SELECT id FROM servers")
          .all()
          .map((r) => r.id),
      );
    } catch (e) {
      console.warn("[playit reconcile] db read (orphan sweep):", e.message);
    }
    if (validIds) {
      for (const t of tunnels) {
        const m = t.name && t.name.match(/^ch[bj]-(.+)$/);
        if (!m) continue;
        if (validIds.has(m[1])) continue;
        try {
          await apiCall(secret, "/tunnels/delete", { tunnel_id: t.id });
          console.log(
            `[playit reconcile] removed orphan tunnel "${t.name}" (no such server)`,
          );
        } catch (e) {
          console.warn("[playit reconcile] orphan delete:", e.message);
        }
      }
    }

    // 3) Ensure each cross-play-enabled server has its own Bedrock address.
    let enabled = [];
    try {
      enabled = db
        .prepare(
          "SELECT id, port FROM servers WHERE playit_secret IS NOT NULL ORDER BY created_at ASC",
        )
        .all();
    } catch (e) {
      console.warn("[playit reconcile] db read:", e.message);
      return;
    }
    for (const s of enabled) {
      try {
        const addr = await startBedrock(s.id, geyserUdpPortFor(s), secret);
        if (addr) {
          console.log(
            `[playit reconcile] ${s.id}: Bedrock ready @ ${addr.host}:${addr.port}`,
          );
        }
      } catch (e) {
        console.warn(`[playit reconcile] ${s.id}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 1500)); // throttle API
    }
  } catch (e) {
    console.warn("[playit reconcile] failed:", e.message);
  }
}

function info(serverId) {
  const a = addrCache.get(serverId);
  if (!a) return null;
  return { host: a.host, port: a.port, running: agentRunning() };
}

function list() {
  return [...addrCache.entries()].map(([id, a]) => ({
    server_id: id,
    host: a.host,
    port: a.port,
    running: agentRunning(),
  }));
}

module.exports = {
  isAvailable,
  start,
  startBedrock,
  startJava,
  stop,
  stopJava,
  info,
  list,
  ensureAgent,
  ensureJavaTunnel,
  deleteServerTunnels,
  claimStart,
  claimStatus,
  claimCancel,
  ensureBedrockTunnel,
  reconcilePerServerBedrock,
  apiCall,
  GEYSER_UDP_PORT,
};
