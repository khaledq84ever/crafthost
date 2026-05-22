#!/usr/bin/env node
// E2E test for two related features:
//   1. World seed at creation — pre-written to server.properties before first boot
//   2. World import (POST /api/servers/:id/import-world) — uploads a .zip,
//      replaces the world dir, restarts.
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-seed-world.mjs
//
// Cleans up the throwaway account's server on success OR failure.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

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

console.log(`\nE2E seed + world.zip import test against ${BASE}\n`);

// 1. Register
console.log(`${Y('▶')} Register throwaway user`);
const suffix = crypto.randomBytes(4).toString('hex');
const TEST_SEED = '-1565555510-test-' + suffix;
const reg = await api('/api/auth/register', {
  method: 'POST',
  body: { username: `sw_${suffix}`, email: `sw+${suffix}@test.io`, password: 'Pw_'+crypto.randomBytes(8).toString('hex') },
});
check(reg.ok, `register → ${reg.status}`);
if (!reg.ok) process.exit(1);

// 2. Auto-starter server (no seed)
console.log(`${Y('▶')} Find auto-starter & delete it (we want a fresh server WITH seed)`);
let sid0 = null;
for (let i = 0; i < 10; i++) {
  const r = await api('/api/servers');
  if (r.body?.servers?.length) { sid0 = r.body.servers[0].id; break; }
  await sleep(1500);
}
if (sid0) {
  const d = await api(`/api/servers/${sid0}`, { method: 'DELETE' });
  check(d.ok, `delete auto-starter → ${d.status}`);
}

// 3. Create a server WITH a seed
console.log(`${Y('▶')} POST /api/servers with seed`);
let sid = null;
{
  const r = await api('/api/servers', {
    method: 'POST',
    body: { name: `Seeded-${suffix}`, type: 'paper', version: '1.20.1', plan: 'free', seed: TEST_SEED },
  });
  check(r.ok, `→ ${r.status}`);
  sid = r.body?.id;
  check(!!sid, `new server id = ${sid}`);
}
if (!sid) { process.exit(1); }

// 4. Verify server.properties contains the seed
console.log(`${Y('▶')} Verify seed landed in server.properties`);
let propsOk = false;
for (let i = 0; i < 20; i++) {
  const r = await api(`/api/servers/${sid}/files/read?path=/server.properties`);
  if (r.ok && r.body?.content) {
    const match = r.body.content.match(/^level-seed=(.*)$/m);
    if (match && match[1] === TEST_SEED) { propsOk = true; break; }
    if (match) { console.log(`  ${R('✗')} seed mismatch — got "${match[1]}", expected "${TEST_SEED}"`); fail++; break; }
  }
  await sleep(1500);
}
check(propsOk, `level-seed=${TEST_SEED} present in server.properties`);

// 5. Build a fake world.zip in memory
//    Contains: world/level.dat (4 bytes), world/region/r.0.0.mca (empty file)
console.log(`${Y('▶')} Build a fake world.zip in memory`);
// Use python3 to build a real ZIP (no zip lib in stdlib node).
// Outputs the zip bytes to stdout.
const zipBytes = await new Promise((resolve, reject) => {
  const py = spawn('python3', ['-c', `
import zipfile, io, sys
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('world/level.dat', b'TEST')
    z.writestr('world/region/r.0.0.mca', b'')
    z.writestr('world/playerdata/.keep', b'')
sys.stdout.buffer.write(buf.getvalue())
`]);
  const chunks = [];
  py.stdout.on('data', c => chunks.push(c));
  py.on('exit', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`python exit ${code}`)));
  py.on('error', reject);
});
check(zipBytes.length > 0, `built zip (${zipBytes.length} bytes, 3 entries)`);

// 6. Upload via multipart
console.log(`${Y('▶')} POST /api/servers/:id/import-world (multipart)`);
{
  const fd = new FormData();
  fd.append('world', new Blob([zipBytes], { type: 'application/zip' }), 'world.zip');
  const r = await fetch(`${BASE}/api/servers/${sid}/import-world`, {
    method: 'POST',
    body: fd,
    headers: cookie ? { Cookie: cookie } : {},
  });
  const body = await r.json().catch(() => null);
  check(r.ok, `→ ${r.status}`);
  check(body?.ok === true, `body.ok = ${body?.ok}`);
  check(body?.restored && typeof body.restored === 'object', `restored field present`);
  check(typeof body?.size === 'number' && body.size === zipBytes.length, `size echoed (${body?.size})`);
}

// 7. Verify the uploaded level.dat is present in the server's files
console.log(`${Y('▶')} Verify uploaded world/level.dat is on disk`);
{
  // Wait briefly for the restart so the file listing reflects the new world
  await sleep(2500);
  const r = await api(`/api/servers/${sid}/files?path=/world`);
  check(r.ok, `list /world → ${r.status}`);
  const hasLevel = !!r.body?.items?.find(i => i.name === 'level.dat');
  check(hasLevel, `world/level.dat present after import`);
}

// 8. Cleanup
console.log(`${Y('▶')} Cleanup`);
const d = await api(`/api/servers/${sid}`, { method: 'DELETE' });
check(d.ok, `delete server → ${d.status}`);

console.log(`\n─── Summary ───`);
console.log(`Checks: ${pass} pass / ${fail} fail · ${fail === 0 ? G('PASS') : R('FAIL')}`);
process.exit(fail === 0 ? 0 : 1);
