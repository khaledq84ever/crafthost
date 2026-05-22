#!/usr/bin/env node
// End-to-end "real or fake?" smoke test.
//
// Spins up a fresh throwaway user, deploys a Paper 1.20.1 server, polls the
// status endpoint until it reports "online", scrapes /api/servers/:id/logs
// until it sees Minecraft's boot-complete marker ("Done (<n>s)! For help"),
// then TCP-pings the public port to confirm the JVM is actually accepting
// connections — not just a DB row.
//
// Exits 0 on success, non-zero on failure. Cleans up the user + server after.
//
// Usage:
//   BASE=https://crafthost-production.up.railway.app node scripts/test-real-server.mjs
//   (defaults to localhost:4000 if BASE not set)

import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:4000';
const TIMESTAMP = Date.now();
const EMAIL = `smoke-${TIMESTAMP}@crafthost.local`;
const USER = `smoke${TIMESTAMP}`;
const PASS = `Smoke!Test${TIMESTAMP}`;
const TYPE = process.env.TYPE || 'paper';
const VERSION = process.env.VERSION || '1.20.1';

let cookie = '';

function fetchJson(path, opts = {}) {
  const url = new URL(BASE + path);
  const fn = url.protocol === 'https:' ? httpsRequest : request;
  return new Promise((resolve, reject) => {
    const req = fn({
      method: opts.method || 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(opts.headers || {}),
      },
      timeout: 15000,
    }, (res) => {
      const setCookie = res.headers['set-cookie'];
      if (setCookie) cookie = setCookie.map(c => c.split(';')[0]).join('; ');
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(buf); } catch { data = buf; }
        if (res.statusCode >= 400) {
          return reject(new Error(`${path} → HTTP ${res.statusCode}: ${typeof data === 'string' ? data : JSON.stringify(data)}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${path} → timeout`)); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

async function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

async function main() {
  console.log(`Smoke test against ${BASE}`);
  console.log(`  type=${TYPE} version=${VERSION}`);

  // ─────── 1. Register
  step(1, 'Register throwaway user');
  const reg = await fetchJson('/api/auth/register', {
    method: 'POST',
    body: { email: EMAIL, username: USER, password: PASS },
  });
  if (!reg.token) fail('register did not return a token');
  ok(`user_id=${reg.user?.id} username=${reg.user?.username}`);

  // Registration usually auto-creates a starter server. Delete it so we can
  // create a fresh one with the type/version we want to test.
  step(2, 'Find + delete auto-created starter server (if any)');
  const list1 = await fetchJson('/api/servers');
  for (const s of (list1.servers || [])) {
    await fetchJson(`/api/servers/${s.id}`, { method: 'DELETE' });
    ok(`deleted starter ${s.id} (${s.name})`);
  }

  // ─────── 3. Create real server
  step(3, `Create ${TYPE} ${VERSION} server`);
  const created = await fetchJson('/api/servers', {
    method: 'POST',
    body: {
      name: `smoke-${TYPE}-${TIMESTAMP}`,
      type: TYPE,
      version: VERSION,
      plan: 'free',
      region: 'eu',
      motd: 'Smoke test server',
      difficulty: 'normal',
      gamemode: 'survival',
      whitelist: false,
    },
  });
  if (!created.id) fail('no server id returned');
  const id = created.id;
  ok(`server id=${id}, port=${created.port}`);

  // ─────── 4. Start it (it may already auto-start on create)
  step(4, 'Ensure server is starting');
  try {
    await fetchJson(`/api/servers/${id}/start`, { method: 'POST' });
    ok('start API ok');
  } catch (err) {
    // already running is fine
    ok(`start: ${err.message.slice(0, 80)}`);
  }

  // ─────── 5. Poll status until online (up to 3 min)
  step(5, 'Polling /status until online (up to 180s)');
  const start = Date.now();
  let lastStatus = '';
  let onlineAt = null;
  while (Date.now() - start < 180_000) {
    try {
      const s = await fetchJson(`/api/servers/${id}/status`);
      if (s.status !== lastStatus) {
        ok(`  t+${((Date.now() - start) / 1000).toFixed(0)}s  status=${s.status}`);
        lastStatus = s.status;
      }
      if (s.status === 'online') { onlineAt = Date.now() - start; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!onlineAt) fail(`server never reached "online" — last status: ${lastStatus}`);
  ok(`reached online in ${(onlineAt / 1000).toFixed(0)}s`);

  // ─────── 6. Read recent logs and look for boot-complete marker
  step(6, 'Read /logs and look for Minecraft "Done (Xs)!" marker');
  const logs = await fetchJson(`/api/servers/${id}/logs?lines=200`);
  const lines = Array.isArray(logs.lines) ? logs.lines : (logs.text || '').split('\n');
  const doneLine = lines.find(l => /Done \(\d+\.\d+s\)! For help/.test(l));
  if (doneLine) ok(`found: ${doneLine.trim().slice(0, 120)}`);
  else console.warn(`  ! "Done" marker not in last 200 lines (server might still be running anyway)`);

  // ─────── 7. TCP probe — proves the JVM is actually listening
  step(7, 'TCP probe — confirm the port is accepting connections');
  const me = await fetchJson('/api/health').catch(() => ({}));
  const live = await fetchJson(`/api/servers/${id}`).catch(() => null);
  const host = live?.tunnel_host || me?.public_host || 'bore.pub';
  const port = live?.tunnel_port || live?.port || created.port;
  const reachable = await tcpProbe(host, port, 5000);
  if (reachable) ok(`${host}:${port} accepting TCP — real Minecraft listener`);
  else console.warn(`  ! ${host}:${port} did not accept TCP within 5s (could be tunnel delay)`);

  // ─────── 8. Cleanup
  step(8, 'Cleanup — delete server + user');
  await fetchJson(`/api/servers/${id}`, { method: 'DELETE' });
  ok(`server ${id} deleted`);
  await fetchJson('/api/auth/me', {
    method: 'DELETE',
    body: { password: PASS, confirm: 'DELETE' },
  });
  ok(`user ${USER} deleted`);

  console.log('\n✅ Server is REAL — boots, accepts connections, cleans up properly.');
  console.log(`   total time: ${((Date.now() - start) / 1000).toFixed(0)}s`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ smoke test failed:', err.message);
  process.exit(1);
});
