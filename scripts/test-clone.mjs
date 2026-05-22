#!/usr/bin/env node
// E2E test for POST /api/servers/clone.
// Registers a user (auto-spawns a starter server), waits for server.properties,
// writes a marker into it, clones the server, verifies the marker is present
// in the clone's server.properties, then cleans up.
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-clone.mjs

import crypto from 'node:crypto';
const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';
let cookie = '';
async function api(p, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } };
  if (cookie) init.headers.Cookie = cookie;
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(BASE + p, init);
  const set = r.headers.getSetCookie?.() || [];
  for (const c of set) { const first = c.split(';')[0]; if (first) cookie = cookie ? cookie + '; ' + first : first; }
  let body; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, ok: r.ok, body };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ${G('✓')} ${msg}`); pass++; }
  else      { console.log(`  ${R('✗')} ${msg}`); fail++; }
}

console.log(`\nE2E clone test against ${BASE}\n`);

// 1. Unauthenticated must fail
console.log(`${Y('▶')} Unauth must fail`);
{
  const r = await api('/api/servers/clone', { method: 'POST', body: { source_id: 'x' } });
  check(r.status === 401, `→ ${r.status}`);
}

// 2. Register
console.log(`${Y('▶')} Register throwaway user`);
const suffix = crypto.randomBytes(4).toString('hex');
const reg = await api('/api/auth/register', {
  method: 'POST',
  body: { username: `cl_${suffix}`, email: `cl+${suffix}@test.io`, password: 'Pw_'+crypto.randomBytes(8).toString('hex') },
});
check(reg.ok, `register → ${reg.status}`);
if (!reg.ok) process.exit(1);

// 3. Find source server
console.log(`${Y('▶')} Find source server`);
await sleep(1500);
let sourceId = null;
{
  const r = await api('/api/servers');
  sourceId = r.body?.servers?.[0]?.id;
  check(!!sourceId, `source server id = ${sourceId}`);
}

// 4. Write a unique marker into a NON-JVM-touched file. We used to write to
//    /server.properties but the JVM rewrites that file during boot (auto-fills
//    missing keys), which raced with our marker write under load. Using a
//    custom .txt file the JVM never touches makes the test deterministic.
const MARKER = `CLONE-TEST-MARKER-${suffix}\n`;
const MARKER_PATH = `/clone-marker.txt`;
console.log(`${Y('▶')} Write marker file ${MARKER_PATH} into source`);
{
  const w = await api(`/api/servers/${sourceId}/files/write`, { method: 'PUT', body: { path: MARKER_PATH, content: MARKER } });
  check(w.ok, `write → ${w.status}`);
}

// 5. Clone
console.log(`${Y('▶')} POST /api/servers/clone`);
let cloneId = null;
{
  const r = await api('/api/servers/clone', { method: 'POST', body: { source_id: sourceId, name: `Clone-${suffix}` } });
  check(r.ok, `→ ${r.status}`);
  check(r.body?.id, `new id = ${r.body?.id}`);
  check(r.body?.cloned_from === sourceId, `cloned_from matches source`);
  check(typeof r.body?.copy_stats?.files === 'number', `copy_stats.files = ${r.body?.copy_stats?.files}`);
  check(typeof r.body?.copy_stats?.bytes === 'number', `copy_stats.bytes = ${r.body?.copy_stats?.bytes}`);
  cloneId = r.body?.id;
}
if (!cloneId) { console.log(R('✗ no clone id, cannot verify')); process.exit(1); }

// 6. Wait briefly + verify the marker landed in the clone's data dir
console.log(`${Y('▶')} Verify marker survived the clone`);
await sleep(2000);
{
  const r = await api(`/api/servers/${cloneId}/files/read?path=${encodeURIComponent(MARKER_PATH)}`);
  check(r.ok, `read clone ${MARKER_PATH} → ${r.status}`);
  check(r.body?.content === MARKER, `clone-marker.txt content matches in clone`);
}

// 7. Verify the clone appears in /api/servers
console.log(`${Y('▶')} Clone listed`);
{
  const r = await api('/api/servers');
  const found = r.body?.servers?.find(s => s.id === cloneId);
  check(!!found, `clone in /api/servers list`);
  check(found?.name === `Clone-${suffix}`, `name matches (${found?.name})`);
}

// 8. Cleanup
console.log(`${Y('▶')} Cleanup`);
const d1 = await api(`/api/servers/${cloneId}`, { method: 'DELETE' });
check(d1.ok, `delete clone → ${d1.status}`);
const d2 = await api(`/api/servers/${sourceId}`, { method: 'DELETE' });
check(d2.ok, `delete source → ${d2.status}`);

console.log(`\n─── Summary ───`);
console.log(`Checks: ${pass} pass / ${fail} fail · ${fail === 0 ? G('PASS') : R('FAIL')}`);
process.exit(fail === 0 ? 0 : 1);
