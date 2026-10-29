#!/usr/bin/env node
// Auth hardening checks: bad input gets a 400 (not a 500), a password change
// revokes older sessions, and forged tokens are rejected.
//
//   BASE=http://localhost:4099 node scripts/test-auth-security.mjs

import crypto from 'node:crypto';
const BASE = process.env.BASE || 'http://localhost:4099';

async function api(p, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json; try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json, setCookie: r.headers.getSetCookie?.() || [] };
}
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ${G('✓')} ${msg}`); pass++; }
  else      { console.log(`  ${R('✗')} ${msg}`); fail++; }
}

console.log(`\nAuth security test against ${BASE}\n`);

console.log(`${Y('▶')} Non-string input is a 400, not a crash`);
for (const [path, body] of [
  ['/api/auth/login', { email: { $ne: 1 }, password: ['x'] }],
  ['/api/auth/login', { email: 'a@b.co' }],
  ['/api/auth/register', { username: ['abc'], email: 'x@y.zz', password: 'longenough1' }],
  ['/api/auth/forgot', { email: 42 }],
  ['/api/auth/reset', { token: { a: 1 }, password: 'longenough1' }],
]) {
  const r = await api(path, { method: 'POST', body });
  check(r.status === 400, `POST ${path} ${JSON.stringify(body)} → 400 (got ${r.status})`);
}

console.log(`${Y('▶')} Forged token is rejected`);
{
  const forged = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from('{"id":1,"role":"admin"}').toString('base64url'),
    'invalidsignature',
  ].join('.');
  const r = await api('/api/auth/me', { token: forged });
  check(r.status === 401, `GET /api/auth/me with forged token → 401 (got ${r.status})`);
}

console.log(`${Y('▶')} Register throwaway user`);
const suffix = crypto.randomBytes(4).toString('hex');
const password = 'Pw_' + crypto.randomBytes(8).toString('hex');
const reg = await api('/api/auth/register', {
  method: 'POST',
  body: { username: `as_${suffix}`, email: `as+${suffix}@test.io`, password },
});
check(reg.status === 200 && reg.body?.token, `register → ${reg.status}`);
if (!reg.body?.token) process.exit(1);
const oldToken = reg.body.token;

console.log(`${Y('▶')} Profile updates are validated`);
{
  const bad = await api('/api/auth/me', { method: 'PATCH', token: oldToken, body: { email: 'not-an-email', current_password: password } });
  check(bad.status === 400, `PATCH /me invalid email → 400 (got ${bad.status})`);
  const long = await api('/api/auth/me', { method: 'PATCH', token: oldToken, body: { username: 'x'.repeat(40), current_password: password } });
  check(long.status === 400, `PATCH /me 40-char username → 400 (got ${long.status})`);
}

console.log(`${Y('▶')} Password change revokes older sessions`);
const newPassword = 'Pw_' + crypto.randomBytes(8).toString('hex');
let newToken = null;
{
  const r = await api('/api/auth/change-password', {
    method: 'POST', token: oldToken, body: { current_password: password, new_password: newPassword },
  });
  check(r.status === 200, `change-password → ${r.status}`);
  newToken = r.setCookie.map(c => c.match(/^token=([^;]+)/)?.[1]).find(Boolean);
  check(!!newToken, 'response re-issues a session cookie');
  const old = await api('/api/auth/me', { token: oldToken });
  check(old.status === 401, `old token → 401 (got ${old.status})`);
  const cur = await api('/api/auth/me', { token: newToken });
  check(cur.status === 200, `new token → 200 (got ${cur.status})`);
}

console.log(`${Y('▶')} Cleanup`);
{
  const r = await api('/api/auth/me', { method: 'DELETE', token: newToken, body: { password: newPassword, confirm: 'DELETE' } });
  check(r.status === 200, `delete account → ${r.status}`);
  const gone = await api('/api/auth/me', { token: newToken });
  check(gone.status === 401, `token of deleted user → 401 (got ${gone.status})`);
}

console.log(`\n─── Summary ───\nChecks: ${pass} pass / ${fail} fail · ${fail ? R('FAIL') : G('PASS')}`);
process.exit(fail ? 1 : 0);
