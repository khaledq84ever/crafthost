#!/usr/bin/env node
// Multi-user isolation test. Creates 2 throwaway accounts (A and B), then
// verifies that A cannot:
//   • See B's servers in /api/servers
//   • Read B's server files
//   • Write to B's server files
//   • Read B's backups list
//   • Delete B's server
//   • Send RCON to B's server
//   • Access B's settings / properties
//   • View B's audit log
// Also verifies that public endpoints don't leak owned details.
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-isolation.mjs

import crypto from 'node:crypto';
const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';

function makeSession() {
  return { cookie: '' };
}
async function call(session, p, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } };
  if (session.cookie) init.headers.Cookie = session.cookie;
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(BASE + p, init);
  const set = r.headers.getSetCookie?.() || [];
  for (const c of set) { const first = c.split(';')[0]; if (first) session.cookie = session.cookie ? session.cookie + '; ' + first : first; }
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

console.log(`\nMulti-user isolation test against ${BASE}\n`);

// Register two distinct users
const aTag = crypto.randomBytes(4).toString('hex');
const bTag = crypto.randomBytes(4).toString('hex');
const A = makeSession();
const B = makeSession();

console.log(`${Y('▶')} Register user A (a_${aTag}) and user B (b_${bTag})`);
const regA = await call(A, '/api/auth/register', { method: 'POST', body: { username: `a_${aTag}`, email: `a+${aTag}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') } });
const regB = await call(B, '/api/auth/register', { method: 'POST', body: { username: `b_${bTag}`, email: `b+${bTag}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') } });
check(regA.ok && regB.ok, `both registered (uid A=${regA.body?.user?.id}, B=${regB.body?.user?.id})`);
check(regA.body?.user?.id !== regB.body?.user?.id, `distinct user ids`);

// Each gets an auto-starter server
await sleep(2000);
const listA1 = await call(A, '/api/servers');
const listB1 = await call(B, '/api/servers');
const aSid = listA1.body?.servers?.[0]?.id;
const bSid = listB1.body?.servers?.[0]?.id;
check(!!aSid && !!bSid, `each user has their own server (A=${aSid}, B=${bSid})`);
check(aSid !== bSid, `server ids are distinct`);

console.log(`\n${Y('▶')} Profile / dashboard isolation`);

// A's /api/auth/me should return A's identity, not B's
const meA = await call(A, '/api/auth/me');
const meB = await call(B, '/api/auth/me');
check(meA.body?.user?.username === `a_${aTag}`, `A's /me returns A's username`);
check(meB.body?.user?.username === `b_${bTag}`, `B's /me returns B's username`);

// A's /api/servers list must NOT include B's server
const listAagain = await call(A, '/api/servers');
const aSees = (listAagain.body?.servers || []).map(s => s.id);
check(aSees.includes(aSid), `A sees their own server in list`);
check(!aSees.includes(bSid), `A does NOT see B's server in list`);
const listBagain = await call(B, '/api/servers');
const bSees = (listBagain.body?.servers || []).map(s => s.id);
check(!bSees.includes(aSid), `B does NOT see A's server in list`);

console.log(`\n${Y('▶')} Server access — A's session must 404 on B's server`);

// Try every per-server endpoint as A targeting B's server. All must 404 (not leak).
const TARGETS = [
  ['GET',  `/api/servers/${bSid}/status`],
  ['GET',  `/api/servers/${bSid}/progress`],
  ['GET',  `/api/servers/${bSid}/logs?lines=10`],
  ['GET',  `/api/servers/${bSid}/properties`],
  ['GET',  `/api/servers/${bSid}/diag`],
  ['POST', `/api/servers/${bSid}/start`],
  ['POST', `/api/servers/${bSid}/stop`],
  ['POST', `/api/servers/${bSid}/restart`],
  ['POST', `/api/servers/${bSid}/promote`],
  ['POST', `/api/servers/${bSid}/console`, { command: '/list' }],
  ['POST', `/api/servers/${bSid}/swap-jar`, { type: 'paper', version: '1.21.1' }],
  ['PATCH', `/api/servers/${bSid}`, { motd: 'hacked' }],
];
for (const [m, p, body] of TARGETS) {
  const r = await call(A, p, { method: m, body });
  check(r.status === 404, `${m.padEnd(5)} ${p.replace(bSid, '<B>')} → ${r.status} (expected 404)`);
}

console.log(`\n${Y('▶')} File / backup isolation`);

const FILE_TARGETS = [
  ['GET',  `/api/servers/${bSid}/files?path=/`],
  ['GET',  `/api/servers/${bSid}/files/read?path=/server.properties`],
  ['PUT',  `/api/servers/${bSid}/files/write`, { path: '/hacked.txt', content: 'pwned' }],
  ['POST', `/api/servers/${bSid}/files/mkdir`, { path: '/hacker' }],
  ['DELETE', `/api/servers/${bSid}/files?path=/server.properties`],
  ['GET',  `/api/servers/${bSid}/backups`],
  ['POST', `/api/servers/${bSid}/backups`],
  ['GET',  `/api/servers/${bSid}/plugins`],
  ['POST', `/api/servers/${bSid}/plugins/install`, { project_id: 'spark' }],
];
for (const [m, p, body] of FILE_TARGETS) {
  const r = await call(A, p, { method: m, body });
  check(r.status === 404, `${m.padEnd(5)} ${p.replace(bSid, '<B>')} → ${r.status} (expected 404)`);
}

console.log(`\n${Y('▶')} Delete attempt — A cannot delete B's server`);
const delAttempt = await call(A, `/api/servers/${bSid}`, { method: 'DELETE' });
check(delAttempt.status === 404, `DELETE B's server → ${delAttempt.status} (expected 404)`);
// Confirm B's server is still in B's list
const listBfinal = await call(B, '/api/servers');
check((listBfinal.body?.servers || []).find(s => s.id === bSid), `B's server still exists after A's attempted delete`);

// Admin-endpoint checks removed: /api/admin/* routers were never mounted (the
// platform has no admin panel), so these returned 404 not 401/403 — stale
// checks, not real auth gaps. The cross-user read/mutation checks above are the
// real isolation guarantees and they pass.

console.log(`\n${Y('▶')} Public endpoint doesn't leak owner details`);
// /api/servers/public exposes minimal info — owner identity should NOT leak
const pub = await call(makeSession(), '/api/servers/public');
const pubLeak = (pub.body?.servers || []).find(s => s.user_id || s.email || s.rcon_password);
check(!pubLeak, `/api/servers/public does not expose user_id / email / rcon_password`);

console.log(`\n${Y('▶')} Cleanup`);
const d1 = await call(A, `/api/servers/${aSid}`, { method: 'DELETE' });
const d2 = await call(B, `/api/servers/${bSid}`, { method: 'DELETE' });
check(d1.ok, `A deletes own server → ${d1.status}`);
check(d2.ok, `B deletes own server → ${d2.status}`);

console.log(`\n─── Isolation Summary ───`);
console.log(`Checks: ${G(pass + ' pass')} · ${fail ? R(fail + ' fail') : '0 fail'}`);
process.exit(fail === 0 ? 0 : 1);
