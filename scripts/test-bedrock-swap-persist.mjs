#!/usr/bin/env node
// Bedrock must SURVIVE engine swaps. The two serving paths are different —
// spigot-family uses the Geyser+Floodgate plugins, vanilla/fabric uses the
// standalone sidecar — so each cross-family swap re-wires Bedrock:
//   1. register (starter Paper server auto-boots), auto-enable Bedrock,
//      restart, RakNet-ping the public address       → plugin path works
//   2. swap-jar → vanilla, wait online, ping again   → sidecar path works
//   3. swap-jar → back to paper, wait online, ping   → plugins re-seeded by
//      the swap (regression test for the silent-death bug)
//   4. cleanup
//
// Live-only (needs the playit agent + tunnel): node scripts/test-bedrock-swap-persist.mjs [baseUrl]
import dgram from 'node:dgram';

const BASE = process.argv[2] || 'https://crafthost-production.up.railway.app';
const rnd = Math.random().toString(36).slice(2, 9);
const USER = { username: `bswap_${rnd}`, email: `bswap_${rnd}@example.com`, password: 'bedrock-swap-123' };
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
        try {
          const len = msg.readUInt16BE(33);
          finish(msg.slice(35, 35 + len).toString('utf8'));
        } catch { finish('(pong, unparsed)'); }
      }
    });
    sock.on('error', () => finish(null));
    sock.send(ping, port, host, (err) => { if (err) finish(null); });
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function waitOnline(label, maxS = 240) {
  for (let i = 0; i < maxS / 5; i++) {
    await sleep(5000);
    const p = await j('GET', `/api/servers/${serverId}/status`);
    const st = p.data?.status;
    if (i % 4 === 3) log(`  [${(i + 1) * 5}s] ${label}: status=${st}`);
    if (st === 'online') return true;
    if (st === 'crashed' || st === 'oom') return false;
  }
  return false;
}

async function bedrockAddress(maxS = 120) {
  for (let i = 0; i < maxS / 5; i++) {
    const list = await j('GET', '/api/servers');
    const me = (list.data?.servers || []).find(x => x.id === serverId);
    if (me?.playit_host && me?.playit_port) return { host: me.playit_host, port: me.playit_port };
    await sleep(5000);
  }
  return null;
}

async function pingUntil(label, host, port, maxS = 150) {
  log(`📡 ${label}: RakNet ping → ${host}:${port} (up to ${maxS}s)…`);
  for (let i = 0; i < maxS / 5; i++) {
    const motd = await raknetPing(host, port, 4000);
    if (motd) { log(`  ✓ pong: ${motd.split(';').slice(0, 2).join(';')}`); return true; }
    await sleep(1000);
    if (i % 6 === 5) log(`  …still trying (${(i + 1) * 5}s)`);
  }
  return false;
}

async function cleanup() {
  if (serverId) { const d = await j('DELETE', `/api/servers/${serverId}`); log(`🧹 cleanup: DELETE ${serverId} → ${d.status}`); }
}

async function main() {
  log(`▶ Bedrock SWAP-PERSISTENCE E2E against ${BASE}`);

  const reg = await j('POST', '/api/auth/register', USER);
  if (reg.status !== 200) throw new Error(`register ${reg.status}: ${JSON.stringify(reg.data)}`);
  TOKEN = reg.data.token; serverId = reg.data.starter?.id;
  if (!serverId) throw new Error('no starter server');
  log(`✓ registered ${USER.username}, server ${serverId}`);

  await j('POST', `/api/servers/${serverId}/start`);
  if (!await waitOnline('boot')) throw new Error('never came online');
  const me0 = (await j('GET', '/api/servers')).data?.servers?.find(x => x.id === serverId);
  const ver = me0?.version || '1.21.1';
  log(`✓ online (paper ${ver})`);

  // ── Phase 1: plugin path (paper) ─────────────────────────────────────────
  const ae = await j('POST', `/api/servers/${serverId}/playit/auto-enable`);
  if (ae.status !== 200) throw new Error(`auto-enable: ${ae.status} ${JSON.stringify(ae.data)}`);
  log(`✓ Bedrock enabled (mode=${ae.data?.mode})`);
  await j('POST', `/api/servers/${serverId}/restart`);
  await sleep(8000);
  if (!await waitOnline('restart')) throw new Error('did not come back after restart');
  const addr = await bedrockAddress();
  if (!addr) throw new Error('no bedrock address');
  log(`✓ Bedrock address: ${addr.host}:${addr.port}`);
  if (!await pingUntil('paper/plugin path', addr.host, addr.port)) throw new Error('paper: no pong');

  // ── Phase 2: sidecar path (swap → vanilla) ───────────────────────────────
  const sw1 = await j('POST', `/api/servers/${serverId}/swap-jar`, { type: 'vanilla', version: ver });
  if (sw1.status !== 200) throw new Error(`swap→vanilla: ${sw1.status} ${JSON.stringify(sw1.data)}`);
  if (!await waitOnline('vanilla')) throw new Error('vanilla never came online');
  const addr2 = await bedrockAddress();
  if (!addr2) throw new Error('no bedrock address after vanilla swap');
  log(`✓ vanilla online, address: ${addr2.host}:${addr2.port}`);
  if (!await pingUntil('vanilla/sidecar path', addr2.host, addr2.port)) throw new Error('vanilla: no pong — sidecar path broken');

  // ── Phase 3: back to paper (plugins must be re-seeded by the swap) ───────
  const sw2 = await j('POST', `/api/servers/${serverId}/swap-jar`, { type: 'paper', version: ver });
  if (sw2.status !== 200) throw new Error(`swap→paper: ${sw2.status} ${JSON.stringify(sw2.data)}`);
  if (!await waitOnline('paper again')) throw new Error('paper never came back online');
  const addr3 = await bedrockAddress();
  if (!addr3) throw new Error('no bedrock address after paper swap');
  log(`✓ paper online again, address: ${addr3.host}:${addr3.port}`);
  if (!await pingUntil('paper again/plugin re-seed', addr3.host, addr3.port)) throw new Error('paper-after-vanilla: no pong — Geyser plugins were not re-seeded');

  log('\n✅ PASS — Bedrock survived paper → vanilla → paper (plugin ⇄ sidecar re-wiring).');
}

main().then(cleanup).catch(async (e) => { console.error('\n❌ FAIL:', e.message); await cleanup(); process.exit(1); });
