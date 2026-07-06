#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CFG = join(homedir(), ".crafthost-cli.json");
const BASE = process.env.CRAFTHOST_API || "http://localhost:4000";

function load() {
  if (!existsSync(CFG)) return {};
  return JSON.parse(readFileSync(CFG, "utf-8"));
}
function save(data) {
  writeFileSync(CFG, JSON.stringify(data, null, 2));
}

async function api(method, path, body) {
  const cfg = load();
  const headers = { "Content-Type": "application/json" };
  if (cfg.token) headers["Cookie"] = `token=${cfg.token}`;
  const res = await fetch(`${BASE}/api${path}`, {
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
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    const text = await res.text();
    throw new Error(text || "Login failed");
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

async function serverCmd(id, action) {
  const data = await api("POST", `/servers/${id}/${action}`);
  console.log(data.status || data.message || "OK");
}

async function serverStatus(id) {
  const list = await api("GET", "/servers");
  const s = list.servers.find((x) => x.id.startsWith(id));
  if (!s) throw new Error("Server not found");
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
  const list = await api("GET", "/servers");
  const s = list.servers.find((x) => x.id.startsWith(id));
  if (!s) throw new Error("Server not found");
  const wsUrl = BASE.replace(/^http/, "ws") + `/ws/servers/${s.id}/logs`;
  const cfg = load();
  const ws = new WebSocket(
    wsUrl + "?token=" + encodeURIComponent(cfg.token || "")
  );
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "log") console.log(msg.line);
    else if (msg.type === "stats")
      console.log(
        `[stats] ${msg.stats.players} players · ${msg.stats.tps?.toFixed(1)} tps · ${Math.round(msg.stats.ram_used / 1024)}GB RAM`
      );
  });
  ws.on("close", () => process.exit(0));
  ws.on("error", (e) => {
    console.error("WS error:", e.message);
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
  const data = await api("DELETE", `/servers/${id}`);
  console.log("Deleted:", data.message || "OK");
}

const HELP = `
Usage: ch-cli <command> [options]

Commands:
  login <email> <password>        Log in and save session
  servers list                    List all servers
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
  CRAFTHOST_API  API base URL (default: http://localhost:4000)
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
    case "servers":
      if (positional[1] === "list") await listServers();
      else console.log("Usage: ch-cli servers list");
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
