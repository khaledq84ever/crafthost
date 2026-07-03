#!/usr/bin/env node
// PROVE Bedrock is actually reachable end-to-end (data plane, not just control).
//   1. register throwaway user (auto-creates a Paper server)
//   2. start it, wait for JVM up
//   3. auto-enable Bedrock (installs Geyser + Floodgate)
//   4. RESTART so Geyser loads + binds UDP 19132 and the playit agent connects
//   5. read the public Bedrock address (playit_host:playit_port)
//   6. send a real RakNet "unconnected ping" to that public address and confirm
//      Geyser answers with an "unconnected pong" (proves relay→agent→Geyser→back)
//   7. delete the test server
//
// Usage: node scripts/test-bedrock-reachable.mjs [baseUrl]
import dgram from 'node:dgram';

const BASE = process.argv[2] || 'https://crafthost-production.up.railway.app';
const rnd = Math.random().toString(36).slice(2, 9);
const USER = { username: `breach_${rnd}`, email: `breach_${rnd}@example.com`, password: 'bedrock-reach-123' };
const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

let TOKEN = null, serverId = null;
const H = () => ({ 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
async function j(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function cleanup() {
  if (serverId) { const d = await j('DELETE', `/api/servers/${serverId}`); log(`🧹 cleanup: DELETE ${serverId} → ${d.status}`); }
}

// Send one RakNet unconnected ping; resolve with the decoded MOTD string or null.
function raknetPing(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (val) => { if (!done) { done = true; try { sock.close(); } catch {} resolve(val); } };
    const ping = Buffer.concat([
      Buffer.from([0x01]),
      (() => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(Date.now())); return b; })(),
      RAKNET_MAGIC,
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(Math.random() * 1e15))); return b; })(),
    ]);
    sock.on('message', (msg) => {
      if (msg[0] === 0x1c) {
        // 0x1C pong: id(1)+time(8)+serverGUID(8)+magic(16)+strLen(2)+str
        try {
          const len = msg.readUInt16BE(33);
          resolve(msg.slice(35, 35 + len).toString('utf8'));
        } catch { resolve('(pong, unparsed)'); }
        finish(undefined);
      }
    });
    sock.on('error', () => finish(null));
    sock.send(ping, port, host, (err) => { if (err) finish(null); });
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function waitJvm(label, maxS = 200) {
  for (let i = 0; i < maxS / 5; i++) {
    await sleep(5000);
    const p = await j('GET', `/api/servers/${serverId}/progress`);
    const jvm = p.data?.phases?.find(x => x.id === 'jvm')?.done;
    log(`  [${(i + 1) * 5}s] ${label}: status=${p.data?.status} jvm=${jvm}${p.data?.oom ? ' OOM' : ''}`);
    if (jvm) return true;
  }
  return false;
}

async function main() {
  log(`▶ Bedrock REACHABILITY E2E against ${BASE}`);

  const reg = await j('POST', '/api/auth/register', USER);
  if (reg.status !== 200) throw new Error(`register ${reg.status}: ${JSON.stringify(reg.data)}`);
  TOKEN = reg.data.token; serverId = reg.data.starter?.id;
  if (!serverId) throw new Error('no starter server');
  log(`✓ registered ${USER.username}, server ${serverId}`);

  await j('POST', `/api/servers/${serverId}/start`);
  if (!await waitJvm('boot')) throw new Error('JVM never came up');
  log('✓ JVM up');

  const ae = await j('POST', `/api/servers/${serverId}/playit/auto-enable`);
  if (ae.status !== 200) throw new Error(`auto-enable failed: ${ae.status} ${JSON.stringify(ae.data)}`);
  log(`✓ auto-enable mode=${ae.data?.mode} (restart_required=${ae.data.restart_required})`);

  log('↻ restarting so Geyser loads + agent connects…');
  await j('POST', `/api/servers/${serverId}/restart`);
  await sleep(8000);
  if (!await waitJvm('reboot')) throw new Error('JVM did not come back after restart');

  // Read the public Bedrock address.
  let host = null, port = null;
  for (let i = 0; i < 24; i++) {
    const list = await j('GET', '/api/servers');
    const me = (list.data?.servers || []).find(x => x.id === serverId);
    if (me?.playit_host && me?.playit_port) { host = me.playit_host; port = me.playit_port; break; }
    await sleep(5000);
  }
  if (!host) throw new Error('no playit address after restart');
  log(`✓ Bedrock address: ${host}:${port}`);

  // Confirm Geyser actually loaded (helps diagnose a ping failure).
  const lg = await j('GET', `/api/servers/${serverId}/logs?lines=400`);
  const geyserUp = (lg.data?.logs || []).some(l => /Geyser.*(started|listening|enabled)|Done \(/i.test(l));
  log(`  Geyser in logs: ${geyserUp ? 'yes' : 'not clearly — pinging anyway'}`);

  // RakNet ping with retries (Geyser bind + agent connect can lag).
  log(`📡 RakNet unconnected-ping → ${host}:${port} (retrying up to ~120s)…`);
  let motd = null;
  for (let i = 0; i < 30; i++) {
    motd = await raknetPing(host, port, 4000);
    if (motd) break;
    await sleep(4000);
    if (i % 3 === 2) log(`  …still trying (${(i + 1) * 4}s)`);
  }

  if (motd) {
    log(`\n✅ REACHABLE — Geyser answered through the playit tunnel.`);
    log(`   Pong MOTD: ${motd}`);
  } else {
    log(`\n❌ NOT REACHABLE — no RakNet pong from ${host}:${port} within ~120s.`);
    log(`   Last 12 log lines:`);
    (lg.data?.logs || []).slice(-12).forEach(l => log(`     ${l}`));
    throw new Error('Bedrock data-plane ping failed');
  }
}

main().then(cleanup).catch(async (e) => { console.error('\n❌ FAIL:', e.message); await cleanup(); process.exit(1); });
