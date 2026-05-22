// Docker controller — spawns + manages Minecraft server containers via itzg/minecraft-server
// Falls back to a stub mode if Docker is unavailable, so the API still works for demos.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let Docker = null;
let docker = null;
try {
  Docker = require('dockerode');
  docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
} catch (err) {
  console.warn('[docker-controller] dockerode unavailable — running in stub mode');
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data/servers');
fs.mkdirSync(DATA_DIR, { recursive: true });

async function isDockerAvailable() {
  if (!docker) return false;
  try { await docker.ping(); return true; } catch { return false; }
}

function makeRconPassword() {
  return crypto.randomBytes(16).toString('hex');
}

function buildEnvFor(server) {
  const typeMap = {
    vanilla: 'VANILLA',
    paper: 'PAPER',
    spigot: 'SPIGOT',
    purpur: 'PURPUR',
    forge: 'FORGE',
    neoforge: 'NEOFORGE',
    fabric: 'FABRIC',
    bedrock: 'BEDROCK',
    custom: 'CUSTOM'
  };
  const env = [
    'EULA=TRUE',
    `TYPE=${typeMap[server.type] || 'VANILLA'}`,
    `VERSION=${server.version || 'LATEST'}`,
    `MEMORY=${Math.floor(server.ram_mb)}M`,
    `MOTD=${server.motd || 'A CraftHost server'}`,
    `MAX_PLAYERS=${server.max_players}`,
    `DIFFICULTY=${server.difficulty || 'normal'}`,
    `MODE=${server.gamemode || 'survival'}`,
    `ENABLE_RCON=true`,
    `RCON_PASSWORD=${server.rcon_password}`,
    `RCON_PORT=25575`,
  ];
  if (server.whitelist) env.push('WHITELIST=true', 'ENFORCE_WHITELIST=true');
  if (server.custom_jar_path) env.push(`CUSTOM_SERVER=${server.custom_jar_path}`);
  return env;
}

async function createServer(server) {
  if (!await isDockerAvailable()) {
    // Stub: just write a placeholder marker
    fs.mkdirSync(path.join(DATA_DIR, server.id), { recursive: true });
    return { containerId: 'stub-' + server.id, status: 'created' };
  }

  const serverDir = path.join(DATA_DIR, server.id);
  fs.mkdirSync(serverDir, { recursive: true });

  const container = await docker.createContainer({
    Image: 'itzg/minecraft-server:latest',
    name: `crafthost-${server.id}`,
    Env: buildEnvFor(server),
    HostConfig: {
      Memory: server.ram_mb * 1024 * 1024,
      NanoCpus: Math.floor(server.cpu_cores * 1e9),
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: {
        '25565/tcp': [{ HostPort: String(server.port) }],
        '25575/tcp': [{ HostPort: String(server.port + 1000) }],
      },
      Binds: [`${serverDir}:/data`],
    },
    ExposedPorts: { '25565/tcp': {}, '25575/tcp': {} },
  });

  return { containerId: container.id, status: 'created' };
}

async function startServer(containerId) {
  if (!await isDockerAvailable() || containerId.startsWith('stub-')) return { status: 'starting' };
  const c = docker.getContainer(containerId);
  await c.start();
  return { status: 'starting' };
}

async function stopServer(containerId) {
  if (!await isDockerAvailable() || containerId.startsWith('stub-')) return { status: 'offline' };
  const c = docker.getContainer(containerId);
  try { await c.stop({ t: 30 }); } catch (err) { /* already stopped */ }
  return { status: 'offline' };
}

async function restartServer(containerId) {
  if (!await isDockerAvailable() || containerId.startsWith('stub-')) return { status: 'starting' };
  const c = docker.getContainer(containerId);
  await c.restart({ t: 30 });
  return { status: 'starting' };
}

async function removeServer(containerId) {
  if (!await isDockerAvailable() || containerId.startsWith('stub-')) return { status: 'removed' };
  const c = docker.getContainer(containerId);
  try { await c.stop({ t: 10 }); } catch {}
  try { await c.remove({ force: true }); } catch {}
  return { status: 'removed' };
}

async function getStats(containerId) {
  if (!await isDockerAvailable() || containerId.startsWith('stub-')) {
    // Stub stats
    return {
      cpu: Math.floor(Math.random() * 60) + 10,
      ram_used: Math.floor(Math.random() * 2000) + 500,
      ram_max: 4096,
      tps: 19.8 + Math.random() * 0.2,
      uptime: Math.floor(Math.random() * 100000),
      players: Math.floor(Math.random() * 20),
      online: true,
    };
  }
  const c = docker.getContainer(containerId);
  const stats = await c.stats({ stream: false });
  const info = await c.inspect();
  return {
    cpu: calcCpu(stats),
    ram_used: Math.floor(stats.memory_stats.usage / (1024 * 1024)),
    ram_max: Math.floor(stats.memory_stats.limit / (1024 * 1024)),
    online: info.State.Running,
    uptime: info.State.StartedAt ? Math.floor((Date.now() - new Date(info.State.StartedAt).getTime()) / 1000) : 0,
  };
}

function calcCpu(stats) {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  if (sysDelta > 0 && cpuDelta > 0) {
    return Math.round((cpuDelta / sysDelta) * (stats.cpu_stats.online_cpus || 1) * 100);
  }
  return 0;
}

async function attachLogStream(containerId, onLine) {
  if (!await isDockerAvailable() || containerId.startsWith('stub-')) {
    // Stub: emit fake logs periodically
    const fake = setInterval(() => {
      onLine(`[${new Date().toISOString()}] [Server] Server tick rate: ${(19 + Math.random()).toFixed(2)} TPS`);
    }, 2000);
    return { stop: () => clearInterval(fake) };
  }
  const c = docker.getContainer(containerId);
  const stream = await c.logs({ stdout: true, stderr: true, follow: true, tail: 100 });
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(l => l && onLine(l));
  });
  return { stop: () => stream.destroy() };
}

async function sendRcon(server, command) {
  // RCON is best-effort. In stub mode return a canned response.
  if (!await isDockerAvailable() || (server.container_id || '').startsWith('stub-')) {
    return `[stub] executed: ${command}`;
  }
  try {
    const { Rcon } = require('rcon-client');
    const rcon = await Rcon.connect({
      host: '127.0.0.1', port: server.port + 1000,
      password: server.rcon_password, timeout: 3000
    });
    const resp = await rcon.send(command);
    rcon.end();
    return resp;
  } catch (err) {
    return `RCON error: ${err.message}`;
  }
}

module.exports = {
  isDockerAvailable,
  makeRconPassword,
  createServer,
  startServer,
  stopServer,
  restartServer,
  removeServer,
  getStats,
  attachLogStream,
  sendRcon,
};
