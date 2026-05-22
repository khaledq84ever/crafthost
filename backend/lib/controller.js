// Unified server controller. Picks the best runtime:
//   1. docker  — if Docker socket reachable (best isolation, per-server containers)
//   2. jvm     — direct child-process `java -jar` (Railway default)
//   3. stub    — synthetic responses (dev / demo)
//
// All routes go through this; legacy callers can still `require('./docker-controller')`.

const docker = require('./docker-controller');
const jvm = require('./jvm-controller');
const crypto = require('crypto');

let _backendCache = null;
let _cacheTs = 0;
const CACHE_TTL = 30_000;

async function pickBackend() {
  if (_backendCache && Date.now() - _cacheTs < CACHE_TTL) return _backendCache;
  let pick = 'stub';
  if (await docker.isDockerAvailable()) pick = 'docker';
  else if (jvm.isAvailable()) pick = 'jvm';
  _backendCache = pick;
  _cacheTs = Date.now();
  return pick;
}

function isJvmId(containerId) {
  return String(containerId || '').startsWith('jvm-');
}
function isStubId(containerId) {
  return String(containerId || '').startsWith('stub-');
}

function makeRconPassword() {
  return crypto.randomBytes(16).toString('hex');
}

async function createServer(server) {
  const backend = await pickBackend();
  if (backend === 'docker') return docker.createServer(server);
  if (backend === 'jvm') return jvm.createServer(server);
  return { containerId: 'stub-' + server.id, status: 'created' };
}

async function startServer(server) {
  const cid = server.container_id;
  if (isJvmId(cid)) return jvm.startServer(cid, server);
  if (isStubId(cid)) return { status: 'starting' };
  if (await docker.isDockerAvailable()) return docker.startServer(cid);
  // Fallback: container was created in stub mode but JVM is now available — upgrade it
  if (jvm.isAvailable()) return jvm.startServer('jvm-' + server.id, server);
  return { status: 'starting' };
}

async function stopServer(server) {
  const cid = server.container_id;
  if (isJvmId(cid)) return jvm.stopServer(cid, server);
  if (isStubId(cid)) return { status: 'offline' };
  if (await docker.isDockerAvailable()) return docker.stopServer(cid);
  return { status: 'offline' };
}

async function restartServer(server) {
  const cid = server.container_id;
  if (isJvmId(cid)) return jvm.restartServer(cid, server);
  if (isStubId(cid)) return { status: 'starting' };
  if (await docker.isDockerAvailable()) return docker.restartServer(cid);
  return { status: 'starting' };
}

async function removeServer(server) {
  const cid = server.container_id;
  if (isJvmId(cid)) return jvm.removeServer(cid, server);
  if (isStubId(cid)) return { status: 'removed' };
  if (await docker.isDockerAvailable()) return docker.removeServer(cid);
  return { status: 'removed' };
}

async function getStats(server) {
  const cid = server.container_id;
  if (isJvmId(cid)) return jvm.getStats(cid, server);
  if (isStubId(cid)) {
    // Synthetic stats so the UI still moves
    return {
      cpu: Math.floor(Math.random() * 60) + 10,
      ram_used: Math.floor(Math.random() * 2000) + 500,
      ram_max: server.ram_mb || 4096,
      tps: 19.8 + Math.random() * 0.2,
      uptime: Math.floor(Math.random() * 100000),
      players: Math.floor(Math.random() * 20),
      online: true,
    };
  }
  if (await docker.isDockerAvailable()) return docker.getStats(cid);
  return { cpu: 0, ram_used: 0, ram_max: server.ram_mb || 0, tps: 0, uptime: 0, players: 0, online: false };
}

async function attachLogStream(server, onLine) {
  const cid = server.container_id;
  if (isJvmId(cid)) return jvm.attachLogStream(cid, onLine);
  if (isStubId(cid)) {
    const t = setInterval(() => onLine(`[stub] ${new Date().toISOString()} Server tick`), 4000);
    return { stop: () => clearInterval(t) };
  }
  if (await docker.isDockerAvailable()) return docker.attachLogStream(cid, onLine);
  return { stop: () => {} };
}

async function sendRcon(server, command) {
  const cid = server.container_id;
  if (isJvmId(cid)) return jvm.sendRcon(server, command);
  if (isStubId(cid)) return `[stub] executed: ${command}`;
  if (await docker.isDockerAvailable()) return docker.sendRcon(server, command);
  return `[stub] executed: ${command}`;
}

async function backendName() { return pickBackend(); }

// Pass-throughs for the auto-restart loop — only meaningful in JVM backend.
function getCrashes() { return jvm.getCrashes ? jvm.getCrashes() : []; }
function clearCrash(id) { return jvm.clearCrash && jvm.clearCrash(id); }

module.exports = {
  pickBackend,
  backendName,
  makeRconPassword,
  createServer,
  startServer,
  stopServer,
  restartServer,
  removeServer,
  getStats,
  attachLogStream,
  sendRcon,
  getCrashes,
  clearCrash,
};
