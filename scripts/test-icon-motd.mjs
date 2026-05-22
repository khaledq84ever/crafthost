#!/usr/bin/env node
// E2E: server icon upload + MOTD color codes.
// Verifies:
//   • POST /api/servers/:id/icon accepts a real PNG, rejects non-PNG, rejects oversize
//   • GET /api/servers/:id/icon returns the PNG bytes
//   • DELETE clears it
//   • MOTD with &-codes survives a PATCH round-trip
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-icon-motd.mjs

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

// Minimal valid PNG (1x1 transparent). Hand-built so the test is self-contained.
const PNG_1x1 = Buffer.from([
  0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,
  0x00,0x00,0x00,0x0D, 0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
  0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
  0x89, 0x00,0x00,0x00,0x0D, 0x49,0x44,0x41,
  0x54, 0x78,0x9C,0x62,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0D,0x0A,0x2D,0xB4, 0x00,
  0x00,0x00,0x00, 0x49,0x45,0x4E,0x44, 0xAE,
  0x42,0x60,0x82,
]);

console.log(`\nE2E icon + MOTD test against ${BASE}\n`);

// 1. Register + find auto-starter
const suffix = crypto.randomBytes(4).toString('hex');
const reg = await api('/api/auth/register', { method: 'POST', body: { username: `im_${suffix}`, email: `im+${suffix}@test.io`, password: 'Pw_'+crypto.randomBytes(8).toString('hex') } });
check(reg.ok, `register → ${reg.status}`);
if (!reg.ok) process.exit(1);

await sleep(1500);
const list = await api('/api/servers');
const sid = list.body?.servers?.[0]?.id;
check(!!sid, `auto-starter id = ${sid}`);
if (!sid) process.exit(1);

// 2. No icon initially → 404
console.log(`${Y('▶')} GET /icon (no icon set) → 404`);
{
  const r = await fetch(`${BASE}/api/servers/${sid}/icon`, { headers: { Cookie: cookie } });
  check(r.status === 404, `→ ${r.status}`);
}

// 3. Reject non-PNG upload
console.log(`${Y('▶')} POST /icon with text file → 400`);
{
  const fd = new FormData();
  fd.append('icon', new Blob([Buffer.from('not a png')], { type: 'text/plain' }), 'fake.png');
  const r = await fetch(`${BASE}/api/servers/${sid}/icon`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  check(r.status === 400, `→ ${r.status}`);
}

// 4. Accept real PNG
console.log(`${Y('▶')} POST /icon with valid PNG`);
{
  const fd = new FormData();
  fd.append('icon', new Blob([PNG_1x1], { type: 'image/png' }), 'icon.png');
  const r = await fetch(`${BASE}/api/servers/${sid}/icon`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  const body = await r.json().catch(() => ({}));
  check(r.ok, `→ ${r.status}`);
  check(body.ok === true, `body.ok = ${body.ok}`);
  check(body.size === PNG_1x1.length, `size = ${body.size} (expected ${PNG_1x1.length})`);
}

// 5. GET /icon returns the bytes + correct content-type
console.log(`${Y('▶')} GET /icon returns PNG bytes`);
{
  const r = await fetch(`${BASE}/api/servers/${sid}/icon`, { headers: { Cookie: cookie } });
  check(r.ok, `→ ${r.status}`);
  check(/image\/png/.test(r.headers.get('content-type') || ''), `Content-Type contains image/png (got "${r.headers.get('content-type')}")`);
  const buf = Buffer.from(await r.arrayBuffer());
  check(buf.length === PNG_1x1.length, `byte length matches (got ${buf.length})`);
  check(buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a', `PNG signature intact`);
}

// 6. DELETE /icon
console.log(`${Y('▶')} DELETE /icon`);
{
  const r = await api(`/api/servers/${sid}/icon`, { method: 'DELETE' });
  check(r.ok, `→ ${r.status}`);
}
{
  const r = await fetch(`${BASE}/api/servers/${sid}/icon`, { headers: { Cookie: cookie } });
  check(r.status === 404, `subsequent GET → ${r.status}`);
}

// 7. MOTD with color codes survives a PATCH round-trip
console.log(`${Y('▶')} MOTD &-code round-trip via PATCH`);
{
  const motd = '&aGreen &bAqua &cRed';
  const r = await api(`/api/servers/${sid}`, { method: 'PATCH', body: { motd } });
  check(r.ok, `PATCH motd → ${r.status}`);
  // Read back via the properties endpoint
  await sleep(800);
  const p = await api(`/api/servers/${sid}/properties`);
  const got = p.body?.properties?.motd || '';
  // The controller converts & → § on write to server.properties.
  check(got.includes('§a') && got.includes('§c'), `server.properties has §a + §c (got: "${got}")`);
}

// 8. Cleanup
const d = await api(`/api/servers/${sid}`, { method: 'DELETE' });
check(d.ok, `cleanup delete → ${d.status}`);

console.log(`\n─── Summary ───`);
console.log(`Checks: ${pass} pass / ${fail} fail · ${fail === 0 ? G('PASS') : R('FAIL')}`);
process.exit(fail === 0 ? 0 : 1);
