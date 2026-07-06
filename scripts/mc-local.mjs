#!/usr/bin/env node
import { spawn, execSync } from "child_process";
import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const CWD = process.cwd();
const HELP = `
Usage: mc-local <command> [options]

Commands:
  init [dir]              Create server directory with default files
  start [dir]             Start Minecraft server
  stop                    Stop running server (graceful)
  restart                 Restart server
  status                  Show server status & stats
  console                 Attach interactive console
  command <cmd>           Send one command to server
  backup                  Create a world backup zip
  install <type> <ver>    Download server JAR (paper, vanilla, fabric, purpur)

Options:
  --java  <path>          Java executable (default: java)
  --ram   <MB>            Max heap MB (default: 1024)
  --port  <port>          Server port (default: 25565)

Files:
  mc-local.json           Server config (auto-created on init)
  server.jar              Server JAR
  world/                  World data directory
`;

const RUN_DIR = resolve(process.env.MC_LOCAL_DIR || CWD);

function loadConfig(dir) {
  const p = join(dir, "mc-local.json");
  if (!existsSync(p)) {
    return {
      java: "java",
      ram_mb: 1024,
      port: 25565,
      type: "paper",
      version: "1.21.1",
    };
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

function saveConfig(dir, cfg) {
  writeFileSync(join(dir, "mc-local.json"), JSON.stringify(cfg, null, 2));
}

function serverPidFile(dir) {
  return join(dir, ".mc-local.pid");
}

function isRunning(dir) {
  const pidFile = serverPidFile(dir);
  if (!existsSync(pidFile)) return false;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readEula(dir) {
  const p = join(dir, "eula.txt");
  if (!existsSync(p)) return false;
  return readFileSync(p, "utf-8").includes("eula=true");
}

async function init(dir) {
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig(dir);
  saveConfig(dir, cfg);
  const eulaPath = join(dir, "eula.txt");
  if (!existsSync(eulaPath)) {
    writeFileSync(eulaPath, "eula=true\n");
    console.log("Created eula.txt (accepted)");
  }
  if (!existsSync(join(dir, "server.properties"))) {
    const props = [
      `server-port=${cfg.port}`,
      "online-mode=true",
      "motd=A CraftHost local server",
      "max-players=20",
      "difficulty=normal",
      "gamemode=survival",
      "spawn-protection=0",
      "enable-query=false",
      "enable-rcon=false",
      "broadcast-console-to-ops=true",
    ].join("\n");
    writeFileSync(join(dir, "server.properties"), props + "\n");
    console.log("Created server.properties");
  }
  if (!existsSync(join(dir, "server.jar"))) {
    console.log("No server.jar found. Run: mc-local install " + cfg.type + " " + cfg.version);
  }
  console.log("Initialized server at", dir);
}

async function startServer(dir) {
  if (isRunning(dir)) {
    console.log("Server is already running.");
    return;
  }
  const cfg = loadConfig(dir);
  const jarPath = join(dir, "server.jar");
  if (!existsSync(jarPath)) {
    console.error("No server.jar found. Run install first.");
    process.exit(1);
  }
  if (!readEula(dir)) {
    writeFileSync(join(dir, "eula.txt"), "eula=true\n");
  }
  const javaArgs = [
    `-Xmx${cfg.ram_mb}M`,
    `-Xms${cfg.ram_mb}M`,
    "-XX:+UseG1GC",
    "-XX:+ParallelReflectionEnabled",
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:G1HeapRegionSize=4M",
    "-XX:+AlwaysPreTouch",
    "-jar",
    "server.jar",
    "nogui",
  ];
  console.log(`Starting Minecraft server (${cfg.type} ${cfg.version})…`);
  const proc = spawn(cfg.java, javaArgs, {
    cwd: dir,
    stdio: ["pipe", "inherit", "inherit"],
    detached: false,
  });
  writeFileSync(serverPidFile(dir), String(proc.pid));
  proc.on("exit", () => {
    try { require("fs").unlinkSync(serverPidFile(dir)); } catch {}
  });
  // Auto-save every 5 min
  const saveTimer = setInterval(() => {
    if (!proc.killed) proc.stdin.write("save-all\n");
  }, 300_000);
  proc.on("exit", () => clearInterval(saveTimer));
  process.on("SIGINT", () => {
    proc.stdin.write("stop\n");
    setTimeout(() => process.exit(0), 5000);
  });
  process.on("SIGTERM", () => {
    proc.stdin.write("stop\n");
  });
}

function stopServer(dir) {
  const pidFile = serverPidFile(dir);
  if (!existsSync(pidFile)) {
    console.log("No PID file found. Server not running.");
    return;
  }
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log("Sent SIGTERM to server process", pid);
  } catch (err) {
    console.log("Server not running.");
    try { require("fs").unlinkSync(pidFile); } catch {}
  }
}

function serverStatus(dir) {
  const running = isRunning(dir);
  const cfg = loadConfig(dir);
  const jarSize = existsSync(join(dir, "server.jar"))
    ? (require("fs").statSync(join(dir, "server.jar")).size / 1024 / 1024).toFixed(1) + " MB"
    : "N/A";
  console.log(`Directory: ${dir}`);
  console.log(`Running:   ${running ? "yes" : "no"}`);
  console.log(`Type:      ${cfg.type} ${cfg.version}`);
  console.log(`RAM:       ${cfg.ram_mb}MB`);
  console.log(`Port:      ${cfg.port}`);
  console.log(`Java:      ${cfg.java}`);
  console.log(`JAR:       ${jarSize}`);
  console.log(`PID file:  ${existsSync(serverPidFile(dir)) ? readFileSync(serverPidFile(dir), "utf-8").trim() : "N/A"}`);
}

async function attachConsole(dir) {
  if (!isRunning(dir)) {
    console.error("Server not running.");
    return;
  }
  const cfg = loadConfig(dir);
  const javaArgs = [
    `-Xmx${cfg.ram_mb}M`,
    "-Xms128M",
    "-jar",
    "server.jar",
    "nogui",
  ];
  const proc = spawn(cfg.java, javaArgs, {
    cwd: dir,
    stdio: ["pipe", "inherit", "inherit"],
    detached: false,
  });
  writeFileSync(serverPidFile(dir), String(proc.pid));
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.on("line", (line) => {
    proc.stdin.write(line + "\n");
  });
  proc.on("exit", () => {
    console.log("\nServer stopped.");
    rl.close();
    try { require("fs").unlinkSync(serverPidFile(dir)); } catch {}
    process.exit(0);
  });
  rl.prompt();
}

function sendCommand(dir, cmd) {
  if (!isRunning(dir)) {
    console.error("Server not running.");
    return;
  }
  // We can't easily send to an existing detached JVM without rcon
  // So offer rcon-based approach or just print instructions
  console.log("To send a command to a running server, attach console:");
  console.log("  mc-local console");
  console.log("Or enable rcon in server.properties and use:");
  console.log("  echo '" + cmd + "' | mcrcon -p <password>");
}

async function install(dir, type, version) {
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig(dir);
  if (type) cfg.type = type;
  if (version) cfg.version = version;
  saveConfig(dir, cfg);
  const jarPath = join(dir, "server.jar");
  console.log(`Downloading ${cfg.type} ${cfg.version} server JAR…`);
  let url;
  try {
    switch (cfg.type) {
      case "paper": {
        // Get latest build for version
        const proj = await (await fetch(`https://api.papermc.io/v2/projects/paper/versions/${cfg.version}/builds`)).json();
        const build = proj.builds[proj.builds.length - 1];
        url = `https://api.papermc.io/v2/projects/paper/versions/${cfg.version}/builds/${build.build}/downloads/${build.downloads.application.name}`;
        break;
      }
      case "vanilla": {
        const manifest = await (await fetch("https://launchermeta.mojang.com/mc/game/version_manifest.json")).json();
        const ver = manifest.versions.find(v => v.id === cfg.version) || manifest.latest.release;
        const pkg = ver === manifest.latest.release
          ? manifest.versions.find(v => v.id === manifest.latest.release)
          : ver;
        const pkgData = await (await fetch(pkg.url)).json();
        url = pkgData.downloads.server.url;
        break;
      }
      case "fabric": {
        const loader = await (await fetch("https://meta.fabricmc.net/v2/versions/loader")).json();
        const installer = await (await fetch("https://meta.fabricmc.net/v2/versions/installer")).json();
        url = `https://meta.fabricmc.net/v2/versions/loader/${cfg.version}/${loader[0].loader.version}/${installer[0].version}/server/jar`;
        break;
      }
      case "purpur": {
        url = `https://api.purpurmc.org/v2/purpur/${cfg.version}/latest/download`;
        break;
      }
      default:
        throw new Error(`Unknown type: ${cfg.type}`);
    }
  } catch (err) {
    console.error("Failed to resolve download URL:", err.message);
    process.exit(1);
  }
  console.log("Downloading from:", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(jarPath, buf);
  console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB to ${jarPath}`);
}

async function backup(dir) {
  const worldDir = join(dir, "world");
  if (!existsSync(worldDir)) {
    console.error("No world/ directory found.");
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = join(dir, `backup-${ts}.zip`);
  const { execSync } = await import("child_process");
  try {
    execSync(`cd "${dir}" && zip -r "${backupPath}" world/`, { stdio: "inherit" });
    const size = require("fs").statSync(backupPath).size;
    console.log(`Backup saved: ${backupPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    console.error("Backup failed:", err.message);
  }
}

// --- main ---
const positional = process.argv.slice(2);
const cmd = positional[0] || "help";
const dir = resolve(positional[1] || CWD);

try {
  switch (cmd) {
    case "init":
      await init(dir);
      break;
    case "start":
      await startServer(dir);
      break;
    case "stop":
      stopServer(dir);
      break;
    case "restart":
      stopServer(dir);
      await new Promise(r => setTimeout(r, 2000));
      await startServer(dir);
      break;
    case "status":
      serverStatus(dir);
      break;
    case "console":
      await attachConsole(dir);
      break;
    case "command":
      sendCommand(dir, positional.slice(2).join(" "));
      break;
    case "install":
      await install(dir, positional[2], positional[3]);
      break;
    case "backup":
      await backup(dir);
      break;
    default:
      console.log(HELP);
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
