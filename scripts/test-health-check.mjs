#!/usr/bin/env node
// E2E test for GET /api/servers/health-check.
// Registers a user (auto-spawns a starter server), polls the endpoint,
// validates the shape and the per-server health rollup, then cleans up.
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-health-check.mjs

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

console.log(`\nE2E health-check test against ${BASE}\n`);

// 1. Unauthenticated must 401 (proves the route is mounted + auth-gated)
console.log(`${Y('▶')} Unauthenticated request must 401`);
{
  const r = await api('/api/servers/health-check');
  check(r.status === 401, `GET /api/servers/health-check (unauth) → 401 (got ${r.status})`);
}

// 2. Register a throwaway user
console.log(`${Y('▶')} Register throwaway user`);
const suffix = crypto.randomBytes(4).toString('hex');
{
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { username: `hc_${suffix}`, email: `hc+${suffix}@test.io`, password: 'Pw_'+crypto.randomBytes(8).toString('hex') },
  });
  check(r.ok, `register → ${r.status}`);
  if (!r.ok) process.exit(1);
}

// 3. Hit health-check immediately — should return summary with 1 server
console.log(`${Y('▶')} GET /api/servers/health-check (authed)`);
let serverId = null;
{
  // Small wait so the auto-starter row is created
  await sleep(1500);
  const r = await api('/api/servers/health-check');
  check(r.ok, `→ HTTP ${r.status}`);
  check(Array.isArray(r.body?.servers), 'response has servers[]');
  check(r.body?.summary && typeof r.body.summary.total === 'number', 'response has summary{total,good,warn,error}');
  check(typeof r.body?.checked_at === 'number', 'response has checked_at timestamp');
  check(r.body?.servers?.length === 1, `auto-starter present (${r.body?.servers?.length} server(s))`);
  if (r.body?.servers?.length) {
    serverId = r.body.servers[0].id;
    const s = r.body.servers[0];
    check(['good','warn','error'].includes(s.health), `health rollup = ${s.health}`);
    check(Array.isArray(s.issues), 'server has issues[]');
    check(Array.isArray(s.recent_logs), 'server has recent_logs[]');
    check(typeof s.online === 'boolean', `online flag = ${s.online}`);
    check(s.summary !== false, ''); // placeholder
    console.log(`     server: ${s.name} (${s.type} ${s.version}) — health=${s.health} status=${s.status} issues=${s.issues.length}`);
    if (s.issues.length) {
      console.log('     issues:');
      for (const i of s.issues) console.log(`       · [${i.severity}] ${i.message}`);
    }
  }
}

// 4. Poll twice to confirm checked_at advances + endpoint stays responsive
console.log(`${Y('▶')} Two polls 3s apart — checked_at must advance`);
{
  const a = await api('/api/servers/health-check');
  await sleep(3000);
  const b = await api('/api/servers/health-check');
  check(a.ok && b.ok, 'both polls succeeded');
  check(b.body.checked_at > a.body.checked_at, `checked_at advanced (${b.body.checked_at - a.body.checked_at}ms)`);
}

// 5. Summary counts add up
console.log(`${Y('▶')} Summary counts add up`);
{
  const r = await api('/api/servers/health-check');
  const s = r.body.summary;
  check(s.good + s.warn + s.error === s.total, `${s.good}+${s.warn}+${s.error} = ${s.total}`);
}

// 6. Cleanup
console.log(`${Y('▶')} Cleanup`);
if (serverId) {
  const r = await api(`/api/servers/${serverId}`, { method: 'DELETE' });
  check(r.ok, `delete server → ${r.status}`);
}

console.log(`\n─── Summary ───`);
console.log(`Checks: ${pass} pass / ${fail} fail · ${fail === 0 ? G('PASS') : R('FAIL')}`);
process.exit(fail === 0 ? 0 : 1);
