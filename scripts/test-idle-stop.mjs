#!/usr/bin/env node
// E2E test for the idle-stop world-save flow.
// We can't easily wait 30 minutes for the real idle-stop, so instead:
//   1. Register + wait for auto-starter to come online
//   2. Write a marker file into the data dir (so we can prove it survives stop+start)
//   3. Send the same `save-all flush` + `stop` sequence the idle-stop loop uses,
//      via the existing POST /:id/stop endpoint (which calls dc.stopServer)
//   4. Restart via POST /:id/start
//   5. Verify the marker file is still there
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-idle-stop.mjs

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

console.log(`\nE2E idle-stop save test against ${BASE}\n`);

// 1. Register
const suffix = crypto.randomBytes(4).toString('hex');
const reg = await api('/api/auth/register', { method: 'POST', body: { username: `is_${suffix}`, email: `is+${suffix}@test.io`, password: 'Pw_'+crypto.randomBytes(8).toString('hex') } });
check(reg.ok, `register → ${reg.status}`);
if (!reg.ok) process.exit(1);

await sleep(1500);
const list = await api('/api/servers');
const sid = list.body?.servers?.[0]?.id;
check(!!sid, `auto-starter id = ${sid}`);

// 2. Wait for server to be ready (so JVM is fully booted before we stop it)
console.log(`${Y('▶')} Wait for server ready`);
let ready = false;
for (let i = 0; i < 60; i++) {
  const r = await api(`/api/servers/${sid}/progress`);
  if (r.body?.ready) { ready = true; break; }
  await sleep(2000);
}
check(ready, `server ready`);

// 3. Write a marker file at root so we can verify it survives
const MARKER = `IDLE-STOP-MARKER-${suffix}\n`;
const MARKER_PATH = `/idle-marker.txt`;
console.log(`${Y('▶')} Write marker into data dir`);
{
  const w = await api(`/api/servers/${sid}/files/write`, { method: 'PUT', body: { path: MARKER_PATH, content: MARKER } });
  check(w.ok, `write → ${w.status}`);
}

// 4. Trigger graceful stop (same sequence the idle-stop loop uses: save then stop)
console.log(`${Y('▶')} POST /:id/stop (graceful — same path the idle-stop loop hits)`);
{
  const r = await api(`/api/servers/${sid}/stop`, { method: 'POST' });
  check(r.ok, `→ ${r.status}`);
}
// Wait for the JVM exit + status update
await sleep(4000);
{
  const r = await api('/api/servers');
  const s = r.body?.servers?.find(x => x.id === sid);
  check(s?.status === 'offline' || s?.status === 'stopped', `status now ${s?.status}`);
}

// 5. Verify the marker is still on disk (proves stop didn't wipe data)
console.log(`${Y('▶')} Marker survives stop`);
{
  const r = await api(`/api/servers/${sid}/files/read?path=${encodeURIComponent(MARKER_PATH)}`);
  check(r.ok && r.body?.content === MARKER, `marker still readable after stop`);
}

// 6. Restart
console.log(`${Y('▶')} POST /:id/start (resume)`);
{
  const r = await api(`/api/servers/${sid}/start`, { method: 'POST' });
  check(r.ok, `→ ${r.status}`);
}
// Wait briefly + verify marker is STILL there after the restart (proves no data loss on warm boot)
await sleep(3000);
{
  const r = await api(`/api/servers/${sid}/files/read?path=${encodeURIComponent(MARKER_PATH)}`);
  check(r.ok && r.body?.content === MARKER, `marker still intact after restart — world data persists`);
}

// 7. Also verify the world dir was preserved (not wiped) — world/level.dat should exist
//    once the JVM finished the first boot. Wait briefly so we don't race the restart.
console.log(`${Y('▶')} Verify world/level.dat preserved across stop/start cycle`);
{
  let found = false;
  for (let i = 0; i < 20; i++) {
    const r = await api(`/api/servers/${sid}/files?path=/world`);
    if (r.ok && r.body?.items?.find(i => i.name === 'level.dat')) { found = true; break; }
    await sleep(1500);
  }
  check(found, `world/level.dat present after stop+start`);
}

// 8. Cleanup
console.log(`${Y('▶')} Cleanup`);
const d = await api(`/api/servers/${sid}`, { method: 'DELETE' });
check(d.ok, `delete → ${d.status}`);

console.log(`\n─── Summary ───`);
console.log(`Checks: ${pass} pass / ${fail} fail · ${fail === 0 ? G('PASS') : R('FAIL')}`);
process.exit(fail === 0 ? 0 : 1);
