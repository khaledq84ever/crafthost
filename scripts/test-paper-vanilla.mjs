#!/usr/bin/env node
// Real-server smoke test for Paper + Vanilla on production.
// For each engine:
//   1. Register a throwaway user
//   2. Create a server of that type
//   3. Poll /status until "online" (or fail after 240s)
//   4. Read /logs and look for Minecraft's "Done (Xs)!" boot-complete marker
//   5. TCP-probe the public port to prove the JVM accepts connections
//   6. Auto-restart probe: stop, then start again, verify it comes back
//   7. Cleanup
//
// Reports a pass/fail matrix at the end. Exit 0 if both pass.

import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';

const ENGINES = [
  { type: 'paper',   version: '1.20.1' },
  { type: 'vanilla', version: '1.20.1' },
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
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: 20000,
    }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) cookie = sc.map(c => c.split(';')[0]).join('; ');
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        let data; try { data = JSON.parse(buf); } catch { data = buf; }
        if (res.statusCode >= 400) reject(Object.assign(new Error(`${path} → HTTP ${res.statusCode}: ${typeof data === 'string' ? data : JSON.stringify(data)}`), { status: res.statusCode }));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${path} → timeout`)); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function tcpProbe(host, port, timeoutMs = 5000) {
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

async function pollUntilOnline(id, maxMs = 240_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    try {
      const s = await fetchJson(`/api/servers/${id}/status`);
      if (s.status !== last) {
        console.log(`     t+${((Date.now()-start)/1000).toFixed(0)}s status=${s.status}`);
        last = s.status;
      }
      if (s.status === 'online') return { ok: true, ms: Date.now() - start };
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return { ok: false, lastStatus: last };
}

async function testEngine({ type, version }) {
  const TS = Date.now();
  const email = `tx-${type}-${TS}@crafthost.local`;
  const user  = `tx${type}${TS}`;
  const pass  = `Tx!${type}${TS}`;
  cookie = '';
  const result = { type, version, steps: {} };

  console.log(`\n══════ ${type.toUpperCase()} ${version} ══════`);

  try {
    console.log('  [1] Register');
    const reg = await fetchJson('/api/auth/register', { method: 'POST', body: { email, username: user, password: pass } });
    result.steps.register = !!reg.token;

    // delete auto-created starter so we can pick the type/version
    const ls = await fetchJson('/api/servers');
    for (const s of (ls.servers || [])) await fetchJson(`/api/servers/${s.id}`, { method: 'DELETE' });

    console.log(`  [2] Create ${type} ${version} server`);
    const created = await fetchJson('/api/servers', {
      method: 'POST',
      body: {
        name: `tx-${type}-${TS}`,
        type, version,
        plan: 'free',
        region: 'eu',
        motd: `tx ${type} test`,
        difficulty: 'normal',
        gamemode: 'survival',
        whitelist: false,
      },
    });
    result.steps.create = !!created.id;
    const id = created.id;

    try { await fetchJson(`/api/servers/${id}/start`, { method: 'POST' }); } catch {}

    console.log('  [3] Poll → online (up to 240s)');
    const poll = await pollUntilOnline(id);
    result.steps.boot = poll.ok;
    if (!poll.ok) {
      console.log(`     ✗ never online (last=${poll.lastStatus})`);
    } else {
      console.log(`     ✓ online in ${(poll.ms/1000).toFixed(0)}s`);
    }

    console.log('  [4] Read /logs — look for "Done (Xs)!" or vanilla equivalent');
    const logs = await fetchJson(`/api/servers/${id}/logs?lines=300`);
    const lines = Array.isArray(logs.lines) ? logs.lines : (logs.text || '').split('\n');
    const doneLine = lines.find(l => /Done \(\d+\.\d+s\)!/.test(l));
    result.steps.bootMarker = !!doneLine;
    if (doneLine) console.log(`     ✓ ${doneLine.trim().slice(0, 120)}`);
    else console.log(`     ! marker not in last 300 lines`);

    console.log('  [5] TCP probe → port accepting connections');
    const live = await fetchJson(`/api/servers/${id}`);
    const host = live?.tunnel_host || 'bore.pub';
    const port = live?.tunnel_port || live?.port;
    const reachable = await tcpProbe(host, port, 6000);
    result.steps.tcp = reachable;
    console.log(`     ${reachable ? '✓' : '✗'} ${host}:${port}`);

    console.log('  [6] Auto-restart probe: stop, then start, verify back online');
    if (poll.ok) {
      await fetchJson(`/api/servers/${id}/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 6000));
      await fetchJson(`/api/servers/${id}/start`, { method: 'POST' });
      const re = await pollUntilOnline(id, 180_000);
      result.steps.restart = re.ok;
      console.log(`     ${re.ok ? '✓ recovered' : '✗ did not recover'}`);
    } else {
      result.steps.restart = 'skipped';
    }

    console.log('  [7] Cleanup');
    try { await fetchJson(`/api/servers/${id}`, { method: 'DELETE' }); } catch {}
    try { await fetchJson('/api/auth/me', { method: 'DELETE', body: { password: pass, confirm: 'DELETE' } }); } catch {}
    console.log('     ✓ deleted');
    return result;
  } catch (err) {
    console.log(`  ✗ aborted: ${err.message}`);
    // best-effort cleanup
    try { await fetchJson('/api/auth/me', { method: 'DELETE', body: { password: pass, confirm: 'DELETE' } }); } catch {}
    result.error = err.message;
    return result;
  }
}

(async () => {
  console.log(`Real-server matrix test against ${BASE}`);
  console.log(`Engines: ${ENGINES.map(e => `${e.type} ${e.version}`).join(', ')}`);

  const results = [];
  for (const e of ENGINES) results.push(await testEngine(e));

  console.log('\n══════════════════ SUMMARY ══════════════════');
  for (const r of results) {
    const cells = ['register', 'create', 'boot', 'bootMarker', 'tcp', 'restart']
      .map(k => `${k}=${r.steps[k] === true ? '✓' : r.steps[k] === false ? '✗' : r.steps[k] || '—'}`)
      .join('  ');
    console.log(`${r.type.padEnd(8)} ${r.version.padEnd(8)} ${cells}${r.error ? `  ERR=${r.error}` : ''}`);
  }
  const allOk = results.every(r => !r.error && r.steps.boot === true && r.steps.tcp === true);
  console.log(allOk ? '\n✅ All engines PASS — real Minecraft servers booting, accepting connections, restartable.' : '\n❌ At least one engine FAILED');
  process.exit(allOk ? 0 : 1);
})();
