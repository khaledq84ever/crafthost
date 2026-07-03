#!/usr/bin/env node
// Backup flow test (API level):
//   1. Create server (no boot), write marker into world/, back up
//   2. Change the marker, restore, marker must revert
//   3. Restore itself must have taken an auto-pre-restore safety backup
//   4. Auth isolation: another user can't list/create/restore
//   5. Busy interplay: backup/restore during a swap → 409 busy
//   6. Running server: backup stops → snapshots → restarts (was_running:true)
//   7. Retention eviction (only when retention ≤ 5, i.e. local BACKUPS_PER_SERVER)
//
// Usage:
//   local: BASE=http://localhost:4123 UP_FROM=1.19.4 UP_TO=1.20.1 node scripts/test-backup-flow.mjs
//          (run the server with BACKUPS_PER_SERVER=3 to exercise eviction)
//   live:  BASE=https://crafthost-production.up.railway.app node scripts/test-backup-flow.mjs
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';
const UP_FROM = process.env.UP_FROM || '1.20.1';
const UP_TO = process.env.UP_TO || '26.1.2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const G=s=>`\x1b[32m${s}\x1b[0m`, R=s=>`\x1b[31m${s}\x1b[0m`, Y=s=>`\x1b[33m${s}\x1b[0m`, D=s=>`\x1b[2m${s}\x1b[0m`;

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

async function pollOnline(jar, sid, maxMs, t0) {
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    const s = await api(jar, `/api/servers/${sid}/status`);
    const st = s.body?.status || '?';
    if (st !== last) { console.log(`    ${D('[+' + Math.round((Date.now() - t0) / 1000) + 's]')} status=${st}`); last = st; }
    if (st === 'online') return true;
    if (st === 'crashed' || st === 'oom') return false;
    await sleep(2000);
  }
  return false;
}

let pass = 0, fail = 0;
const expect = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ${G('✓')} ${name}${detail ? ' — ' + D(detail) : ''}`); }
  else    { fail++; console.log(`  ${R('✗')} ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const t0 = Date.now();
  const jar = { cookie: '' };
  const suffix = crypto.randomBytes(3).toString('hex');
  console.log(`Backup flow test vs ${BASE}\n`);

  const reg = await api(jar, '/api/auth/register', {
    method: 'POST',
    body: { username: `smokebk${suffix}`, email: `smokebk${suffix}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') },
  });
  if (!reg.ok) { console.error(R('register failed:'), reg.body); process.exit(2); }
  console.log(`${G('✓')} registered smokebk${suffix}`);

  const ls0 = await api(jar, '/api/servers');
  for (const s of ls0.body?.servers || []) await api(jar, `/api/servers/${s.id}`, { method: 'DELETE' });

  let sid = null;
  try {
    // ── Setup: server without boot ────────────────────────────────────────
    console.log(`\n${Y('▶')} Step 1: create server (no boot) + marker + backup`);
    const create = await api(jar, '/api/servers', {
      method: 'POST',
      body: { name: `bk-${suffix}`, type: 'paper', version: UP_FROM, plan: 'free', skipAutoStart: true },
    });
    if (!create.ok) { console.error(R('create failed:'), create.body); process.exit(2); }
    sid = create.body.id;

    const markerPath = 'world/backup-marker.txt';
    const V1 = `BK_V1_${crypto.randomBytes(6).toString('hex')}`;
    const V2 = `BK_V2_${crypto.randomBytes(6).toString('hex')}`;
    const w1 = await api(jar, `/api/servers/${sid}/files/write`, { method: 'PUT', body: { path: markerPath, content: V1 } });
    expect('marker V1 written into world/', w1.ok, w1.body?.error);

    const bk1 = await api(jar, `/api/servers/${sid}/backups`, { method: 'POST', body: { label: 'test-manual' } });
    expect('backup created', bk1.ok, bk1.ok ? `${bk1.body.id} (${bk1.body.size}b)` : bk1.body?.error);
    expect('backup not flagged was_running (server offline)', bk1.body?.was_running === false, `was_running=${bk1.body?.was_running}`);
    expect('backup carries label', bk1.body?.label === 'test-manual', `label=${bk1.body?.label}`);
    const bid = bk1.body?.id;

    const l1 = await api(jar, `/api/servers/${sid}/backups`);
    expect('list shows 1 backup', l1.body?.backups?.length === 1, `${l1.body?.backups?.length}`);
    expect('list entry has label + auto:false', l1.body?.backups?.[0]?.label === 'test-manual' && l1.body?.backups?.[0]?.auto === false);

    // ── Restore reverts world changes ─────────────────────────────────────
    console.log(`\n${Y('▶')} Step 2: change marker → restore → marker reverts`);
    const w2 = await api(jar, `/api/servers/${sid}/files/write`, { method: 'PUT', body: { path: markerPath, content: V2 } });
    expect('marker changed to V2', w2.ok);

    const rs = await api(jar, `/api/servers/${sid}/backups/${encodeURIComponent(bid)}/restore`, { method: 'POST' });
    expect('restore accepted', rs.ok, rs.body?.error);
    const r1 = await api(jar, `/api/servers/${sid}/files/read?path=${encodeURIComponent(markerPath)}`);
    expect('marker reverted to V1 after restore', r1.body?.content === V1, `got ${String(r1.body?.content).slice(0, 20)}`);

    const l2 = await api(jar, `/api/servers/${sid}/backups`);
    const auto = (l2.body?.backups || []).find(b => b.label === 'auto-pre-restore');
    expect('restore took an auto-pre-restore safety backup', !!auto && auto.auto === true, auto?.id || 'not found');

    // ── Auth isolation ────────────────────────────────────────────────────
    console.log(`\n${Y('▶')} Step 3: auth isolation`);
    const jar2 = { cookie: '' };
    const reg2 = await api(jar2, '/api/auth/register', {
      method: 'POST',
      body: { username: `smokebk2${suffix}`, email: `smokebk2${suffix}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') },
    });
    if (reg2.ok) {
      const steal = await api(jar2, `/api/servers/${sid}/backups`);
      expect('other user list backups → 404', steal.status === 404, `got ${steal.status}`);
      const stealR = await api(jar2, `/api/servers/${sid}/backups/${encodeURIComponent(bid)}/restore`, { method: 'POST' });
      expect('other user restore → 404', stealR.status === 404, `got ${stealR.status}`);
    } else {
      console.log(`  ${Y('~')} skipped (second register failed)`);
    }

    // ── Busy interplay with swap ──────────────────────────────────────────
    // Boot first: the lock window of a swap on an OFFLINE server with a
    // cached jar is <400ms (stop is a no-op), but stopping an ONLINE server
    // gracefully takes seconds — a deterministic window for the 409 checks.
    console.log(`\n${Y('▶')} Step 4: backup/restore during swap → 409 busy`);
    const st1 = await api(jar, `/api/servers/${sid}/start`, { method: 'POST' });
    expect('server start accepted', st1.ok, st1.body?.error);
    const online0 = await pollOnline(jar, sid, 5 * 60 * 1000, t0);
    expect(`server online on ${UP_FROM}`, online0);

    const swapP = api(jar, `/api/servers/${sid}/swap-jar`, { method: 'POST', body: { type: 'paper', version: UP_TO } });
    await sleep(500);
    const bkBusy = await api(jar, `/api/servers/${sid}/backups`, { method: 'POST', body: {} });
    expect('backup during swap → 409 busy', bkBusy.status === 409 && bkBusy.body?.code === 'busy', `got ${bkBusy.status} ${bkBusy.body?.code || ''}`);
    const rsBusy = await api(jar, `/api/servers/${sid}/backups/${encodeURIComponent(bid)}/restore`, { method: 'POST' });
    expect('restore during swap → 409 busy', rsBusy.status === 409 && rsBusy.body?.code === 'busy', `got ${rsBusy.status} ${rsBusy.body?.code || ''}`);
    const swap = await swapP;
    expect('swap itself completed', swap.ok, swap.body?.error);

    // ── Backup of a RUNNING server stops + restarts it ────────────────────
    console.log(`\n${Y('▶')} Step 5: backup while running → stop, snapshot, restart`);
    const online1 = await pollOnline(jar, sid, 5 * 60 * 1000, t0);
    expect(`server online on ${UP_TO} after swap`, online1);
    if (online1) {
      const bk2 = await api(jar, `/api/servers/${sid}/backups`, { method: 'POST', body: {} });
      expect('backup of running server accepted', bk2.ok, bk2.body?.error);
      expect('was_running:true', bk2.body?.was_running === true, `was_running=${bk2.body?.was_running}`);
      const online2 = await pollOnline(jar, sid, 5 * 60 * 1000, t0);
      expect('server back online after snapshot', online2);
      // World must still be intact after the stop-snapshot-restart cycle.
      const r2 = await api(jar, `/api/servers/${sid}/files/read?path=${encodeURIComponent(markerPath)}`);
      expect('marker still V1 after running-backup cycle', r2.body?.content === V1, `got ${String(r2.body?.content).slice(0, 20)}`);
      await api(jar, `/api/servers/${sid}/stop`, { method: 'POST' });
    }

    // ── Retention eviction (local only: BACKUPS_PER_SERVER ≤ 5) ──────────
    console.log(`\n${Y('▶')} Step 6: retention eviction`);
    const lr = await api(jar, `/api/servers/${sid}/backups`);
    const retention = lr.body?.retention_effective ?? null;
    const current = lr.body?.backups?.length || 0;
    if (retention && retention <= 5) {
      for (let i = current; i <= retention; i++) {
        await api(jar, `/api/servers/${sid}/backups`, { method: 'POST', body: { label: `fill-${i}` } });
      }
      const le = await api(jar, `/api/servers/${sid}/backups`);
      expect(`list capped at retention (${retention})`, (le.body?.backups?.length || 0) <= retention, `${le.body?.backups?.length} backups`);
    } else {
      console.log(`  ${Y('~')} skipped (retention ${retention ?? 'unknown'} > 5 — live config)`);
    }

    // ── Delete a backup ───────────────────────────────────────────────────
    console.log(`\n${Y('▶')} Step 7: delete backup`);
    const ld = await api(jar, `/api/servers/${sid}/backups`);
    const delTarget = ld.body?.backups?.[0];
    if (delTarget) {
      const del = await api(jar, `/api/servers/${sid}/backups/${encodeURIComponent(delTarget.id)}`, { method: 'DELETE' });
      expect('delete backup ok', del.ok, del.body?.error);
      const lAfter = await api(jar, `/api/servers/${sid}/backups`);
      expect('list shrank by 1', (lAfter.body?.backups?.length || 0) === (ld.body.backups.length - 1), `${ld.body.backups.length} → ${lAfter.body?.backups?.length}`);
    }
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    const lsEnd = await api(jar, '/api/servers');
    for (const s of lsEnd.body?.servers || []) await api(jar, `/api/servers/${s.id}`, { method: 'DELETE' }).catch(() => {});
  }

  const total = pass + fail;
  console.log('\n─── Backup flow results ───');
  console.log(`  ${G(pass + ' pass')} · ${fail ? R(fail + ' fail') : '0 fail'} · ${total} total`);
  console.log(`  Wall time: ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(fail === 0 ? G('  ✅ backups snapshot, restore, and guard correctly') : R('  ❌ backup flow has gaps'));
  process.exit(fail === 0 ? 0 : 1);
})();
