#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CFG = join(homedir(), ".crafthost-cli.json");
const BASE = process.env.CRAFTHOST_API || "http://localhost:4000";
const TIMEOUT_MS = Number(process.env.CRAFTHOST_TIMEOUT_MS) || 20000;

/** fetch that gives up after TIMEOUT_MS instead of hanging on an unresponsive API. */
async function request(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (err.name === "TimeoutError") throw new Error(`No response from ${BASE} within ${TIMEOUT_MS / 1000}s`);
    throw new Error(`Cannot reach ${BASE}: ${err.cause?.code || err.cause?.message || err.message}`);
  }
}

function load() {
  if (!existsSync(CFG)) return {};
  try {
    return JSON.parse(readFileSync(CFG, "utf-8"));
  } catch {
    throw new Error(`${CFG} is corrupt; delete it and run 'ch-cli login' again`);
  }
}

/** Reads a password without echoing it (TTY), or one line from piped stdin. */
function readPassword(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (data += c));
      stdin.on("end", () => resolve(data.split(/\r?\n/)[0]));
      stdin.on("error", reject);
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let pw = "";
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(pw);
      } else if (ch === "\u0003") {
        stdin.setRawMode(false);
        reject(new Error("Cancelled"));
      } else if (ch === "\u007f" || ch === "\b") {
        pw = pw.slice(0, -1);
      } else {
        pw += ch;
      }
    };
    stdin.on("data", onData);
  });
}
function save(data) {
  // The session token grants full account access: keep it private to this user.
  writeFileSync(CFG, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(CFG, 0o600); } catch {} // tighten a file created by an older version
}

async function api(method, path, body) {
  const cfg = load();
  const headers = { "Content-Type": "application/json" };
  if (cfg.token) headers["Cookie"] = `token=${cfg.token}`;
  const res = await request(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok && !data.ok)
    throw new Error(data.error || data.raw || res.statusText);
  return data;
}

async function login(email, password) {
  if (!email) throw new Error("Usage: ch-cli login <email>   (you'll be asked for the password)");
  // A password on the command line lands in shell history and `ps`; prefer the prompt or env var.
  password ||= process.env.CRAFTHOST_PASSWORD || (await readPassword("Password: "));
  if (!password) throw new Error("No password given");
  const res = await request(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    const text = await res.text();
    let message = text;
    try { message = JSON.parse(text).error || text; } catch {}
    throw new Error(message || `Login failed (HTTP ${res.status})`);
  }
  const m = setCookie.match(/token=([^;]+)/);
  if (!m) throw new Error("No token in response");
  save({ token: m[1], email });
  console.log("Logged in as", email);
}

async function listServers() {
  const data = await api("GET", "/servers");
  if (!data.servers?.length) {
    console.log("No servers.");
    return;
  }
  for (const s of data.servers) {
    const line = [
      s.id.slice(0, 8) + "…",
      s.name.padEnd(24),
      (s.type + " " + (s.version || "")).padEnd(18),
      s.status.padEnd(10),
      `plan: ${s.plan_name}`,
    ];
    console.log(line.join("  "));
  }
}

/** Finds a server by full id or by the id prefix `list` prints. */
async function findServer(id) {
  if (!id) throw new Error("Missing server id (see: ch-cli list)");
  const list = await api("GET", "/servers");
  const matches = (list.servers || []).filter((x) => x.id.startsWith(id));
  if (!matches.length) throw new Error("Server not found");
  if (matches.length > 1) throw new Error(`Id prefix '${id}' matches ${matches.length} servers; use more characters`);
  return matches[0];
}

async function serverCmd(id, action) {
  const s = await findServer(id);
  const data = await api("POST", `/servers/${s.id}/${action}`);
  console.log(data.status || data.message || "OK");
}

async function serverStatus(id) {
  const s = await findServer(id);
  console.log(`Name:     ${s.name}`);
  console.log(`ID:       ${s.id}`);
  console.log(`Type:     ${s.type} ${s.version || ""}`);
  console.log(`Status:   ${s.status}`);
  console.log(`Plan:     ${s.plan_name} (${s.ram_mb}MB)`);
  console.log(`Port:     ${s.port}`);
  console.log(`Players:  ${s.max_players}`);
  console.log(`Motd:     ${s.motd || "(none)"}`);
  console.log(`Public:   ${s.is_public ? "yes" : "no"}`);
}

async function tailLogs(id) {
  const s = await findServer(id);
  const wsUrl = BASE.replace(/^http/, "ws") + `/ws/servers/${s.id}/logs`;
  const cfg = load();
  const ws = new WebSocket(
    wsUrl + "?token=" + encodeURIComponent(cfg.token || "")
  );
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.type === "log") console.log(msg.line);
    else if (msg.type === "stats")
      console.log(
        `[stats] ${msg.stats.players ?? "?"} players · ${msg.stats.tps?.toFixed(1) ?? "?"} tps · ${msg.stats.ram_used != null ? Math.round(msg.stats.ram_used / 1024) : "?"}GB RAM`
      );
  });
  ws.addEventListener("close", () => process.exit(0));
  ws.addEventListener("error", (e) => {
    console.error("WS error:", e.message || "connection failed");
    process.exit(1);
  });
}

async function createServer(args) {
  const name = args._[1] || "cli-server";
  const data = await api("POST", "/servers", {
    name,
    type: args.type || "paper",
    version: args.version || "latest",
    plan: args.plan || "free",
    region: args.region || "eu",
  });
  console.log("Created server:", data.server?.name || data.server?.id);
  if (data.server) {
    const s = data.server;
    console.log(`ID: ${s.id} · Status: ${s.status} · Port: ${s.port}`);
  }
}

async function deleteServer(id) {
  const s = await findServer(id);
  const data = await api("DELETE", `/servers/${s.id}`);
  console.log("Deleted:", data.message || "OK");
}

const HELP = `
Usage: ch-cli <command> [options]

Commands:
  login <email>                   Log in (prompts for the password) and save session
  list  (or: servers list)        List all servers
  status <id>                     Show server details
  start <id>                      Start server
  stop <id>                       Stop server
  restart <id>                    Restart server
  logs <id>                       Tail live logs + stats
  create <name>                   Create a new server
    --type <type>                   Server type (paper, vanilla, fabric, purpur)
    --version <version>             MC version (default: latest)
    --plan <plan>                   Plan (free, basic, premium)
    --region <region>               Region (eu, us)
  delete <id>                     Delete a server
  help                            Show this help

Environment:
  CRAFTHOST_API         API base URL (default: http://localhost:4000)
  CRAFTHOST_PASSWORD     Password for login, instead of the prompt (e.g. in scripts)
  CRAFTHOST_TIMEOUT_MS  Give up on an unresponsive API after this many ms (default: 20000)
`;

const args = {};
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq !== -1) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) {
      args[a.slice(2)] = process.argv[++i];
    } else {
      args[a.slice(2)] = true;
    }
  } else {
    positional.push(a);
  }
}
args._ = positional;

const cmd = positional[0] || "help";

try {
  switch (cmd) {
    case "login":
      await login(positional[1], positional[2]);
      break;
    case "list":
      await listServers();
      break;
    case "servers":
      if (positional[1] === "list") await listServers();
      else console.log("Usage: ch-cli list");
      break;
    case "status":
      await serverStatus(positional[1]);
      break;
    case "start":
      await serverCmd(positional[1], "start");
      break;
    case "stop":
      await serverCmd(positional[1], "stop");
      break;
    case "restart":
      await serverCmd(positional[1], "restart");
      break;
    case "logs":
      await tailLogs(positional[1]);
      break;
    case "create":
      await createServer(args);
      break;
    case "delete":
      await deleteServer(positional[1]);
      break;
    default:
      console.log(HELP);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
