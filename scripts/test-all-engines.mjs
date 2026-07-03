#!/usr/bin/env node
// Real-server smoke test across EVERY supported engine.
// Tests Paper, Vanilla, Purpur, Fabric, NeoForge sequentially.
// For each: register user → create server → poll until online → read /logs
// for boot marker → TCP-probe public port → cleanup.
//
// Reports a pass/fail matrix at the end. Exit 0 if all pass.
//
// Usage:
//   BASE=https://crafthost-production.up.railway.app node scripts/test-all-engines.mjs

import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';

// Each engine + a version known to be available + a regex matching the engine's
// "boot complete" marker in stdout. Most use Minecraft's standard "Done (Xs)!"
// but Fabric/NeoForge may use different phrasing.
// CURRENT latest versions per engine (MC 26.2 era). Override any of them via
// env, e.g. PAPER_V=1.21.1 for a legacy spot-check.
const V = (k, d) => process.env[k] || d;
const ENGINES = [
  { type: 'paper',    version: V('PAPER_V', '26.2'),    timeoutMs: 180_000, marker: /Done \(\d+\.\d+s\)!/ },
  { type: 'vanilla',  version: V('VANILLA_V', '26.2'),  timeoutMs: 240_000, marker: /Done \(\d+\.\d+s\)!/ },
  { type: 'purpur',   version: V('PURPUR_V', '26.2'),   timeoutMs: 180_000, marker: /Done \(\d+\.\d+s\)!/ },
  { type: 'fabric',   version: V('FABRIC_V', '26.2'),   timeoutMs: 240_000, marker: /Done \(\d+\.\d+s\)!/ },
  // NeoForge installer is heavy (~3 min on cold cache). Skip if SKIP_NEOFORGE=1.
  ...(process.env.SKIP_NEOFORGE === '1' ? [] : [
    // NeoForge tracks MC releases with its own versioning; 26.1.2 is the
    // latest with a stable (non-beta) build.
    { type: 'neoforge', version: V('NEOFORGE_V', '26.1.2'), timeoutMs: 300_000, marker: /Done \(\d+\.\d+s\)!/ },
  ]),
];

let cookie = '';
function fetchJson(path, opts = {}) {
  const url = new URL(BASE + path);
  const fn = url.protocol === 'https:' ? httpsReq : httpReq;
  return new Promise((resolve, reject) => {
    const req = fn({
      method: opts.method || 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      timeout: 30_000,
    }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) cookie = sc.map(c => c.split(';')[0]).join('; ');
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        let data; try { data = JSON.parse(buf); } catch { data = buf; }
        if (res.statusCode >= 400) reject(Object.assign(
          new Error(`${path} → HTTP ${res.statusCode}: ${typeof data === 'string' ? data.slice(0, 120) : JSON.stringify(data).slice(0, 200)}`),
          { status: res.statusCode }));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${path} → timeout`)); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}
function tcpProbe(host, port, timeoutMs = 6000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = r => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}
async function pollOnline(id, maxMs) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    try {
      const s = await fetchJson(`/api/servers/${id}/status`);
      if (s.status !== last) {
        console.log(`     t+${((Date.now() - start) / 1000).toFixed(0)}s  status=${s.status}`);
        last = s.status;
      }
      if (s.status === 'online') return { ok: true, ms: Date.now() - start };
      if (s.status === 'crashed' || s.status === 'error') return { ok: false, last: s.status, ms: Date.now() - start };
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return { ok: false, last, ms: maxMs };
}

async function testOne(engine) {
  const TS = Date.now();
  const PASS = `Tx!${engine.type}${TS}`;
  const result = { ...engine, steps: {} };
  cookie = '';

  console.log(`\n━━━━━━ ${engine.type.toUpperCase()} ${engine.version} ━━━━━━`);

  try {
    console.log('  [1] Register');
    await fetchJson('/api/auth/register', {
      method: 'POST',
      body: { email: `tx-${engine.type}-${TS}@crafthost.local`, username: `tx${engine.type}${TS}`, password: PASS },
    });
    result.steps.register = true;

    // Delete the auto-created starter
    const ls = await fetchJson('/api/servers');
    for (const s of (ls.servers || [])) await fetchJson(`/api/servers/${s.id}`, { method: 'DELETE' });

    console.log(`  [2] Create ${engine.type} ${engine.version}`);
    const created = await fetchJson('/api/servers', {
      method: 'POST',
      body: {
        name: `tx-${engine.type}-${TS}`,
        type: engine.type,
        version: engine.version,
        plan: 'free',
        region: 'eu',
        motd: `tx ${engine.type}`,
        difficulty: 'normal',
        gamemode: 'survival',
        whitelist: false,
      },
    });
    result.steps.create = true;
    const id = created.id;

    console.log(`  [3] Polling (max ${engine.timeoutMs / 1000}s)`);
    const poll = await pollOnline(id, engine.timeoutMs);
    result.steps.boot = poll.ok;
    result.bootMs = poll.ms;
    if (poll.ok) console.log(`     ✓ online in ${(poll.ms / 1000).toFixed(0)}s`);
    else { console.log(`     ✗ stuck at ${poll.last}`); }

    if (poll.ok) {
      console.log('  [4] Read /logs — Done marker');
      const logs = await fetchJson(`/api/servers/${id}/logs?lines=300`);
      const lines = Array.isArray(logs.logs) ? logs.logs : Array.isArray(logs.lines) ? logs.lines : (logs.text || '').split('\n');
      const done = lines.find(l => engine.marker.test(l));
      result.steps.bootMarker = !!done;
      if (done) console.log(`     ✓ ${String(done).trim().slice(0, 130)}`);
      else      console.log(`     ! marker not in last 300 lines`);

      console.log('  [5] TCP probe public port (retries up to 45s — tunnel can lag the boot)');
      let ok = false, host = null, port = null;
      const tEnd = Date.now() + 45_000;
      while (!ok && Date.now() < tEnd) {
        // Re-read each attempt: the tunnel address can appear/change after boot.
        const live = (await fetchJson(`/api/servers`)).servers?.find(s => s.id === id);
        host = live?.tunnel_host || 'bore.pub';
        port = live?.tunnel_port || live?.port;
        if (port) ok = await tcpProbe(host, port, 6000);
        if (!ok) await new Promise(r => setTimeout(r, 5000));
      }
      result.steps.tcp = ok;
      console.log(`     ${ok ? '✓' : '✗'} ${host}:${port}`);
    }

    console.log('  [6] Cleanup');
    try { await fetchJson(`/api/servers/${id}`, { method: 'DELETE' }); } catch {}
    try { await fetchJson('/api/auth/me', { method: 'DELETE', body: { password: PASS, confirm: 'DELETE' } }); } catch {}
    console.log('     ✓ deleted');
    return result;
  } catch (err) {
    console.log(`  ✗ aborted: ${err.message}`);
    try { await fetchJson('/api/auth/me', { method: 'DELETE', body: { password: PASS, confirm: 'DELETE' } }); } catch {}
    result.error = err.message;
    return result;
  }
}

(async () => {
  console.log(`Smoke test: ${ENGINES.length} engines against ${BASE}`);
  const results = [];
  const overallStart = Date.now();
  for (const e of ENGINES) {
    results.push(await testOne(e));
    // Give the platform 5s breathing room between tests so the previous JVM
    // fully unwinds + bore tunnel slot is freed.
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SUMMARY MATRIX');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const cell = (v) => v === true ? '✓' : v === false ? '✗' : v || '—';
  console.log(`  engine     ver        register  create  boot   marker  tcp    boot-time   error`);
  for (const r of results) {
    const t  = (r.bootMs ? (r.bootMs / 1000).toFixed(0) + 's' : '—').padEnd(10);
    const er = r.error ? (' ' + r.error.slice(0, 50)) : '';
    console.log(`  ${r.type.padEnd(10)} ${r.version.padEnd(10)} ${cell(r.steps.register).padEnd(9)} ${cell(r.steps.create).padEnd(7)} ${cell(r.steps.boot).padEnd(6)} ${cell(r.steps.bootMarker).padEnd(7)} ${cell(r.steps.tcp).padEnd(6)} ${t} ${er}`);
  }

  const all = results.every(r => r.steps.boot && r.steps.tcp);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Total: ${((Date.now() - overallStart) / 1000).toFixed(0)}s`);
  console.log(all ? '  ✅ ALL ENGINES PASS — platform is real across the board.' : '  ❌ at least one engine FAILED');
  process.exit(all ? 0 : 1);
})();
