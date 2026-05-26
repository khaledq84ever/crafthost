#!/usr/bin/env node
// Verify Paper 26.1.2 boots via the v3 API path on the live container.
//   1. Register a throwaway user
//   2. Delete auto-created starter
//   3. POST /api/servers { type: paper, version: 26.1.2 }
//   4. Poll status until 'online' or 5 min timeout
//   5. Pull the last 20 log lines for proof-of-life ("Done (Xs)!", MOTD, etc)
//   6. Cleanup
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(jar, p, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (jar.cookie) init.headers.Cookie = jar.cookie;
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(BASE + p, init);
  const sc = r.headers.getSetCookie?.() || [];
  for (const c of sc) { const f = c.split(';')[0]; if (f) jar.cookie = jar.cookie ? jar.cookie + '; ' + f : f; }
  let body; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, ok: r.ok, body };
}

(async () => {
  const t0 = Date.now();
  const jar = { cookie: '' };
  const suffix = crypto.randomBytes(3).toString('hex');
  console.log(`Paper 26.1.2 boot test vs ${BASE}\n`);

  const reg = await api(jar, '/api/auth/register', {
    method: 'POST',
    body: { username: `p26_${suffix}`, email: `p26_${suffix}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') },
  });
  if (!reg.ok) { console.error('register failed:', reg.body); process.exit(2); }
  console.log(`✓ registered p26_${suffix}`);

  const ls = await api(jar, '/api/servers');
  for (const s of ls.body?.servers || []) await api(jar, `/api/servers/${s.id}`, { method: 'DELETE' });
  await sleep(1000);

  const create = await api(jar, '/api/servers', {
    method: 'POST',
    body: { name: `paper-26-${suffix}`, type: 'paper', version: '26.1.2', plan: 'free' },
  });
  if (!create.ok) { console.error('create failed:', create.status, create.body); process.exit(2); }
  const sid = create.body.id;
  const createdAt = Date.now();
  console.log(`✓ created id=${sid}\n`);

  // Poll until online
  const deadline = Date.now() + 5 * 60 * 1000;
  let last = '', online = false;
  while (Date.now() < deadline) {
    const s = await api(jar, `/api/servers/${sid}/status`);
    const st = s.body?.status || '?';
    if (st !== last) {
      console.log(`  [+${Math.round((Date.now() - t0) / 1000)}s] status=${st}`);
      last = st;
    }
    if (st === 'online') { online = true; break; }
    if (st === 'crashed' || st === 'oom') break;
    await sleep(2000);
  }

  let result = { online, last };
  if (online) {
    result.bootTime = Math.round((Date.now() - createdAt) / 1000);
    // Tail logs for proof
    const logs = await api(jar, `/api/servers/${sid}/logs?lines=30`);
    const lines = logs.body?.logs || logs.body?.lines || [];
    result.logLines = lines.length;
    const doneLine = lines.find(l => /Done \(\d+\.\d+s\)!/.test(String(l)));
    const versionLine = lines.find(l => /Paper version|Starting minecraft server/.test(String(l)));
    result.versionLine = versionLine;
    result.doneLine = doneLine;
    // Status with stats
    const status = await api(jar, `/api/servers/${sid}/status`);
    result.players = status.body?.players?.length || 0;
    result.ram_used = status.body?.stats?.ram_used;
    result.tunnel = status.body?.tunnel_host && status.body?.tunnel_port ? `${status.body.tunnel_host}:${status.body.tunnel_port}` : null;
  }

  // Cleanup
  try { await api(jar, `/api/servers/${sid}`, { method: 'DELETE' }); } catch {}
  try { await api(jar, '/api/auth/me', { method: 'DELETE', body: { password: 'irrelevant', confirm: 'DELETE' } }); } catch {}

  console.log();
  if (online) {
    console.log(`\x1b[32m● READY\x1b[0m  Paper 26.1.2 booted in ${result.bootTime}s`);
    console.log(`  log lines: ${result.logLines}`);
    if (result.versionLine) console.log(`  version: ${result.versionLine}`);
    if (result.doneLine) console.log(`  done:    ${result.doneLine}`);
    if (result.tunnel) console.log(`  tunnel:  ${result.tunnel}`);
    if (result.ram_used) console.log(`  RAM:     ${result.ram_used} MB`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m● FAILED\x1b[0m  final status=${result.last}`);
    process.exit(1);
  }
})();
