#!/usr/bin/env node
// Admin ops API test:
//   1. anon GET /api/admin/ops → 401
//   2. normal user → 403
//   3. (local only, ADMIN_DB set) promote user to admin via sqlite →
//      200 with fleet/config; trigger a real swap_rollback (swap to a
//      version that doesn't exist) and see it in the events feed + filter.
//
// Usage:
//   local: BASE=http://localhost:4123 ADMIN_DB=/path/test.db UP_FROM=1.19.4 node scripts/test-admin-ops.mjs
//   live:  BASE=https://crafthost-production.up.railway.app node scripts/test-admin-ops.mjs   (gate checks only)
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:4123';
const ADMIN_DB = process.env.ADMIN_DB || '';
const UP_FROM = process.env.UP_FROM || '1.20.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const G=s=>`\x1b[32m${s}\x1b[0m`, R=s=>`\x1b[31m${s}\x1b[0m`, Y=s=>`\x1b[33m${s}\x1b[0m`;

let TOKEN = null;
async function j(method, path, body, useToken = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useToken && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let pass = 0, fail = 0;
const expect = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ${G('✓')} ${name}${detail ? ' — ' + detail : ''}`); }
  else    { fail++; console.log(`  ${R('✗')} ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  console.log(`Admin ops test vs ${BASE}\n`);

  console.log(`${Y('▶')} Gate checks`);
  const anon = await j('GET', '/api/admin/ops', null, false);
  expect('anonymous → 401', anon.status === 401, `got ${anon.status}`);

  const suffix = crypto.randomBytes(3).toString('hex');
  const reg = await j('POST', '/api/auth/register', {
    username: `smokeadm${suffix}`, email: `smokeadm${suffix}@test.io`,
    password: 'Pw_' + crypto.randomBytes(6).toString('hex'),
  }, false);
  if (reg.status !== 200) { console.error(R('register failed')); process.exit(2); }
  TOKEN = reg.data.token;
  const nonAdmin = await j('GET', '/api/admin/ops');
  expect('non-admin user → 403', nonAdmin.status === 403, `got ${nonAdmin.status}`);

  if (!ADMIN_DB) {
    console.log(`\n${Y('~')} ADMIN_DB not set — skipping admin-side checks (live mode: gate only)`);
  } else {
    console.log(`\n${Y('▶')} Admin-side checks (sqlite promote)`);
    execFileSync('sqlite3', [ADMIN_DB, `UPDATE users SET role='admin' WHERE username='smokeadm${suffix}';`]);
    // The existing token keeps working: authMiddleware re-selects the user
    // (incl. role) from the DB on every request.
    const ops = await j('GET', '/api/admin/ops');
    expect('admin → 200', ops.status === 200, `got ${ops.status}`);
    expect('fleet summary present', typeof ops.data?.fleet?.total === 'number' && typeof ops.data?.fleet?.users === 'number', JSON.stringify(ops.data?.fleet || {}).slice(0, 80));
    expect('config present', typeof ops.data?.config?.idle_stop_minutes === 'number');

    // Trigger a real swap_rollback: version format is valid but doesn't exist,
    // so the jar download fails and the swap rolls back + records the event.
    const create = await j('POST', '/api/servers', {
      name: `adm-${suffix}`, type: 'paper', version: UP_FROM, plan: 'free', skipAutoStart: true,
    });
    const sid = create.data?.id;
    expect('server created', create.status === 200, `got ${create.status}`);
    if (sid) {
      const bad = await j('POST', `/api/servers/${sid}/swap-jar`, { type: 'paper', version: '1.20.99' });
      expect('swap to nonexistent version → 500 swap_failed + rolled back', bad.status === 500 && bad.data?.code === 'swap_failed' && bad.data?.rolled_back === true, `got ${bad.status} ${bad.data?.code || ''}`);

      await sleep(500);
      const ops2 = await j('GET', '/api/admin/ops?kind=swap_rollback');
      const ev = (ops2.data?.events || []).find(e => e.server_id === sid);
      expect('swap_rollback event recorded + filterable', !!ev && ev.kind === 'swap_rollback', ev ? `attempted=${ev.metadata?.attempted}` : 'not found');
      expect('event metadata shows restore target', ev?.metadata?.restored?.includes(UP_FROM) === true, ev?.metadata?.restored);

      await j('DELETE', `/api/servers/${sid}`);
    }
  }

  // Cleanup starter server(s)
  const ls = await j('GET', '/api/servers');
  for (const s of ls.data?.servers || []) await j('DELETE', `/api/servers/${s.id}`);

  console.log(`\n─── Admin ops results: ${G(pass + ' pass')} · ${fail ? R(fail + ' fail') : '0 fail'} ───`);
  process.exit(fail === 0 ? 0 : 1);
})();
