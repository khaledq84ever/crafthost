#!/usr/bin/env node
// Prove Java connectivity via playit (not bore.pub). Requires PLAYIT_JAVA=1 on
// the deployment + a shared secret configured.
//   1. register throwaway user → Paper server
//   2. start it, wait for JVM + tunnel
//   3. read tunnel_host/tunnel_port — assert it's a playit address (joinmc/playit),
//      proving the chooser used playit-java rather than falling back to bore
//   4. do a real Minecraft Java Server-List-Ping over TCP and confirm a status
//      JSON comes back (MOTD/version) — proves relay → agent → JVM → back
//   5. delete the server (also removes its playit Java tunnel)
//
// Usage: node scripts/test-java-playit.mjs [baseUrl]
import net from 'node:net';

const BASE = process.argv[2] || 'https://crafthost-production.up.railway.app';
const rnd = Math.random().toString(36).slice(2, 9);
const USER = { username: `jtest_${rnd}`, email: `jtest_${rnd}@example.com`, password: 'java-playit-123' };

let TOKEN = null, serverId = null;
const H = () => ({ 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
async function j(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function cleanup() { if (serverId) { const d = await j('DELETE', `/api/servers/${serverId}`); log(`🧹 delete ${serverId} → ${d.status}`); } }

// ── Minecraft Java Server-List-Ping (handshake + status) ──
function writeVarInt(n) {
  const b = [];
  let v = n >>> 0;
  do { let t = v & 0x7f; v >>>= 7; if (v !== 0) t |= 0x80; b.push(t); } while (v !== 0);
  return Buffer.from(b);
}
function readVarInt(buf, off) {
  let num = 0, shift = 0, pos = off;
  while (true) {
    if (pos >= buf.length) return null;
    const byte = buf[pos++];
    num |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: num >>> 0, off: pos };
}
function packet(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}
function slpPing(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let chunks = Buffer.alloc(0), done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.on('error', () => finish(null));
    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const handshake = packet(0x00, Buffer.concat([
        writeVarInt(765),                                  // protocol version (any)
        writeVarInt(hostBuf.length), hostBuf,              // server address
        (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; })(),
        writeVarInt(1),                                    // next state = status
      ]));
      sock.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))])); // + status request
    });
    sock.on('data', (d) => {
      chunks = Buffer.concat([chunks, d]);
      // response: [pktLen][0x00][jsonLen][json]
      const a = readVarInt(chunks, 0); if (!a) return;
      if (chunks.length < a.off + a.value) return;          // wait for full packet
      const b = readVarInt(chunks, a.off); if (!b) return;  // packet id (0x00)
      const c = readVarInt(chunks, b.off); if (!c) return;  // json length
      if (chunks.length < c.off + c.value) return;
      try { resolve(JSON.parse(chunks.slice(c.off, c.off + c.value).toString('utf8'))); }
      catch { resolve({ raw: true }); }
      finish(undefined);
    });
  });
}

async function waitTunnel(maxS = 220) {
  for (let i = 0; i < maxS / 5; i++) {
    await sleep(5000);
    const p = await j('GET', `/api/servers/${serverId}/progress`);
    const ph = p.data?.phases || [];
    const jvm = ph.find(x => x.id === 'jvm')?.done, tun = ph.find(x => x.id === 'tunnel')?.done;
    log(`  [${(i + 1) * 5}s] jvm=${jvm} tunnel=${tun} addr=${p.data?.address || '—'}`);
    if (jvm && tun) return true;
  }
  return false;
}

async function main() {
  log(`▶ Java-via-playit E2E against ${BASE}`);
  const reg = await j('POST', '/api/auth/register', USER);
  if (reg.status !== 200) throw new Error(`register ${reg.status}: ${JSON.stringify(reg.data)}`);
  TOKEN = reg.data.token; serverId = reg.data.starter?.id;
  if (!serverId) throw new Error('no starter server');
  log(`✓ registered ${USER.username}, server ${serverId}`);

  await j('POST', `/api/servers/${serverId}/start`);
  if (!await waitTunnel()) throw new Error('JVM/tunnel never came up');

  const list = await j('GET', '/api/servers');
  const me = (list.data?.servers || []).find(x => x.id === serverId);
  const host = me?.tunnel_host, port = me?.tunnel_port;
  if (!host || !port) throw new Error('no tunnel address');
  log(`✓ Java address: ${host}:${port}`);
  const viaPlayit = /playit|joinmc/i.test(host);
  if (viaPlayit) log('  ✓ address is a playit tunnel (not bore.pub) — chooser used playit-java');
  else log(`  ⚠ address is ${host} — looks like bore fallback, NOT playit. (Is PLAYIT_JAVA=1?)`);

  log(`📡 Minecraft Java SLP → ${host}:${port} (retrying up to ~120s)…`);
  let status = null;
  for (let i = 0; i < 30; i++) {
    status = await slpPing(host, port, 6000);
    if (status) break;
    await sleep(4000);
    if (i % 3 === 2) log(`  …still trying (${(i + 1) * 4}s)`);
  }
  if (!status) throw new Error(`no SLP response from ${host}:${port}`);

  const motd = typeof status.description === 'string' ? status.description : (status.description?.text ?? JSON.stringify(status.description));
  log(`\n✅ JAVA REACHABLE — server answered the SLP through the tunnel.`);
  log(`   version: ${status.version?.name}  players: ${status.players?.online}/${status.players?.max}  motd: ${motd}`);
  if (!viaPlayit) throw new Error('reachable, but via bore fallback — playit-java did not engage');
  log('   ✓ confirmed over a playit tunnel.');
}

main().then(cleanup).catch(async (e) => { console.error('\n❌ FAIL:', e.message); await cleanup(); process.exit(1); });
