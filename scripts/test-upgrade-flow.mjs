#!/usr/bin/env node
// In-place JAR version upgrade test:
//   1. Boot Paper 1.20.1 server, wait online
//   2. Write a marker file inside world/ to prove world dir survives the swap
//   3. POST /swap-jar { type: 'paper', version: '26.1.2' }
//   4. Poll until status=online (5 min max)
//   5. Verify:
//      - marker file content unchanged
//      - DB row shows type=paper version=26.1.2
//      - server.properties is valid
//      - logs show Paper 26.1.2 booting (not the old version)
//   6. Bonus: cross-engine swap paper → vanilla, marker must STILL survive
//   7. Cleanup
//
// Usage: BASE=https://crafthost-production.up.railway.app node scripts/test-upgrade-flow.mjs
// Local (Java 17 can only boot MC ≤1.20.x):
//   BASE=http://localhost:4123 UP_FROM=1.19.4 UP_TO=1.20.1 DOWNGRADE_TO=1.16.5 node scripts/test-upgrade-flow.mjs
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';
const UP_FROM = process.env.UP_FROM || '1.20.1';       // initial boot version
const UP_TO = process.env.UP_TO || '26.1.2';           // swap target (must be > UP_FROM)
const DOWNGRADE_TO = process.env.DOWNGRADE_TO || '1.19.4'; // must be < UP_FROM
const UP_TO_RE = new RegExp(UP_TO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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

async function pollOnline(jar, sid, maxMs = 5 * 60 * 1000, t0) {
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    const s = await api(jar, `/api/servers/${sid}/status`);
    const st = s.body?.status || '?';
    if (st !== last) {
      console.log(`    ${D('[+' + Math.round((Date.now() - t0) / 1000) + 's]')} status=${st}`);
      last = st;
    }
    if (st === 'online') return { online: true, ms: Date.now() - t0 };
    if (st === 'crashed' || st === 'oom') return { online: false, last: st };
    await sleep(2000);
  }
  return { online: false, last: 'timeout' };
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
  console.log(`In-place upgrade test vs ${BASE}\n`);

  // ── Setup ─────────────────────────────────────────────────────────────────
  const reg = await api(jar, '/api/auth/register', {
    method: 'POST',
    body: { username: `up_${suffix}`, email: `up_${suffix}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') },
  });
  if (!reg.ok) { console.error(R('register failed:'), reg.body); process.exit(2); }
  console.log(`${G('✓')} registered up_${suffix}`);

  // Wipe auto-starter so we control the version explicitly
  const ls0 = await api(jar, '/api/servers');
  for (const s of ls0.body?.servers || []) await api(jar, `/api/servers/${s.id}`, { method: 'DELETE' });
  await sleep(1000);

  // ── Create Paper UP_FROM ──────────────────────────────────────────────────
  console.log(`\n${Y('▶')} Step 1: deploy Paper ${UP_FROM}`);
  const create = await api(jar, '/api/servers', {
    method: 'POST',
    body: { name: `up-${suffix}`, type: 'paper', version: UP_FROM, plan: 'free' },
  });
  if (!create.ok) { console.error(R('create failed:'), create.body); process.exit(2); }
  const sid = create.body.id;
  console.log(`  created id=${sid}`);
  const boot1 = await pollOnline(jar, sid, 5*60*1000, t0);
  expect(`Paper ${UP_FROM} reaches online`, boot1.online, boot1.online ? `${Math.round(boot1.ms/1000)}s` : `last=${boot1.last}`);
  if (!boot1.online) { await api(jar, `/api/servers/${sid}`, { method: 'DELETE' }); process.exit(1); }

  // ── Input validation (no extra boot needed) ───────────────────────────────
  console.log(`\n${Y('▶')} Step 1b: swap-jar input validation`);
  const vMissing = await api(jar, `/api/servers/${sid}/swap-jar`, { method: 'POST', body: {} });
  expect('missing type → 400', vMissing.status === 400, `got ${vMissing.status}: ${vMissing.body?.error}`);

  const vBad = await api(jar, `/api/servers/${sid}/swap-jar`, { method: 'POST', body: { type: 'hacked', version: '1.0' } });
  expect('unsupported type → 400', vBad.status === 400, `got ${vBad.status}: ${vBad.body?.error}`);

  const vVer = await api(jar, `/api/servers/${sid}/swap-jar`, { method: 'POST', body: { type: 'paper', version: '../../evil' } });
  expect('malformed version → 400 bad_version', vVer.status === 400 && vVer.body?.code === 'bad_version', `got ${vVer.status} ${vVer.body?.code || ''}`);

  const vDown = await api(jar, `/api/servers/${sid}/swap-jar`, { method: 'POST', body: { type: 'paper', version: DOWNGRADE_TO } });
  expect('downgrade without force → 409 unsafe_downgrade', vDown.status === 409 && vDown.body?.code === 'unsafe_downgrade', `got ${vDown.status} ${vDown.body?.code || ''}`);

  // ── Quota guard: swapping a STOPPED server while another runs must 409 ────
  console.log(`\n${Y('▶')} Step 1b2: quota guard on swap of a stopped server`);
  const c2 = await api(jar, '/api/servers', {
    method: 'POST',
    body: { name: `upq-${suffix}`, type: 'paper', version: UP_FROM, plan: 'free', skipAutoStart: true },
  });
  if (c2.ok) {
    const sid2 = c2.body.id;
    const q = await api(jar, `/api/servers/${sid2}/swap-jar`, { method: 'POST', body: { type: 'paper', version: UP_FROM } });
    expect('swap stopped server while another runs → 409 running_quota', q.status === 409 && q.body?.code === 'running_quota', `got ${q.status} ${q.body?.code || ''}`);
    await api(jar, `/api/servers/${sid2}`, { method: 'DELETE' }).catch(() => {});
  } else {
    console.log(`  ${Y('~')} skipped quota guard (second create failed: ${c2.body?.error})`);
  }

  // ── Auth isolation: second user cannot swap first user's server ───────────
  console.log(`\n${Y('▶')} Step 1c: auth isolation`);
  const jar2 = { cookie: '' };
  const suffix2 = crypto.randomBytes(3).toString('hex');
  const reg2 = await api(jar2, '/api/auth/register', {
    method: 'POST',
    body: { username: `up2_${suffix2}`, email: `up2_${suffix2}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') },
  });
  if (reg2.ok) {
    const steal = await api(jar2, `/api/servers/${sid}/swap-jar`, { method: 'POST', body: { type: 'paper', version: UP_FROM } });
    expect('other user swap-jar → 403 or 404', steal.status === 403 || steal.status === 404, `got ${steal.status}`);
    await api(jar2, '/api/auth/me', { method: 'DELETE', body: { password: 'irrelevant', confirm: 'DELETE' } }).catch(() => {});
  } else {
    console.log(`  ${Y('~')} skipped auth isolation (second register failed)`);
  }

  // ── Write marker INSIDE world/ ────────────────────────────────────────────
  console.log(`\n${Y('▶')} Step 2: write marker into world/`);
  const markerToken = `UPGRADE_TEST_${crypto.randomBytes(8).toString('hex')}`;
  const markerPath = 'world/upgrade-marker.txt';
  const w = await api(jar, `/api/servers/${sid}/files/write`, {
    method: 'PUT',
    body: { path: markerPath, content: markerToken },
  });
  expect('marker written to world/', w.ok, w.body?.error);
  // Read it back to confirm the write actually landed
  const r0 = await api(jar, `/api/servers/${sid}/files/read?path=${encodeURIComponent(markerPath)}`);
  expect('marker reads back identical (pre-swap)', r0.ok && r0.body?.content === markerToken, `got ${r0.body?.content?.slice(0,16) || '—'}`);

  // ── SWAP to Paper UP_TO ───────────────────────────────────────────────────
  console.log(`\n${Y('▶')} Step 3: swap-jar → Paper ${UP_TO} (in-place version upgrade)`);
  const swapStart = Date.now();
  // Fire the real swap, then hit the same server with a second swap and a
  // start while it's in flight — both must 409 with code=busy.
  const swapP = api(jar, `/api/servers/${sid}/swap-jar`, {
    method: 'POST',
    body: { type: 'paper', version: UP_TO },
  });
  await sleep(400);
  const dup = await api(jar, `/api/servers/${sid}/swap-jar`, { method: 'POST', body: { type: 'paper', version: UP_TO } });
  expect('concurrent swap → 409 busy', dup.status === 409 && dup.body?.code === 'busy', `got ${dup.status} ${dup.body?.code || ''}`);
  const stDuring = await api(jar, `/api/servers/${sid}/start`, { method: 'POST' });
  expect('start during swap → 409 busy', stDuring.status === 409 && stDuring.body?.code === 'busy', `got ${stDuring.status} ${stDuring.body?.code || ''}`);
  const swap = await swapP;
  expect('swap-jar accepted', swap.ok, swap.body?.error);
  if (!swap.ok) { await api(jar, `/api/servers/${sid}`, { method: 'DELETE' }); process.exit(1); }
  const boot2 = await pollOnline(jar, sid, 5*60*1000, swapStart);
  expect(`Paper ${UP_TO} reaches online after swap`, boot2.online, boot2.online ? `${Math.round(boot2.ms/1000)}s` : `last=${boot2.last}`);

  // ── Verify: marker survived + version reflects new ────────────────────────
  console.log(`\n${Y('▶')} Step 4: verify world data + version state`);
  const r1 = await api(jar, `/api/servers/${sid}/files/read?path=${encodeURIComponent(markerPath)}`);
  expect('marker still in world/ after swap', r1.ok && r1.body?.content === markerToken, `got ${r1.body?.content?.slice(0,16) || '—'}`);

  const ls1 = await api(jar, '/api/servers');
  const fresh = ls1.body?.servers?.find(s => s.id === sid);
  expect('DB row updated: type=paper', fresh?.type === 'paper', `got ${fresh?.type}`);
  expect(`DB row updated: version=${UP_TO}`, fresh?.version === UP_TO, `got ${fresh?.version}`);

  // Pull recent logs — proof the new JAR actually launched
  const logs1 = await api(jar, `/api/servers/${sid}/logs?lines=80`);
  const lines1 = logs1.body?.logs || logs1.body?.lines || [];
  const sawNewBoot = lines1.some(l => UP_TO_RE.test(String(l)));
  const sawDone = lines1.some(l => /Done \(\d+\.\d+s\)!/.test(String(l)));
  expect(`logs reference ${UP_TO}`, sawNewBoot, sawNewBoot ? '' : `no ${UP_TO} line in last 80 logs`);
  expect('logs show "Done (Xs)!" after swap', sawDone);

  // server.properties: must be readable AND retain key values that survive the swap.
  // The swap wipes Paper-specific ymls but server.properties is explicitly kept.
  const props = await api(jar, `/api/servers/${sid}/files/read?path=server.properties`);
  expect('server.properties readable after swap', props.ok && typeof props.body?.content === 'string');
  if (props.ok) {
    const propsText = props.body.content;
    // level-name is set on first boot and must persist — it controls which world dir is loaded.
    expect('server.properties retains level-name key', /^level-name=/m.test(propsText), 'level-name line missing');
    // online-mode line must be present (controls auth); its value is irrelevant here.
    expect('server.properties retains online-mode key', /^online-mode=/m.test(propsText), 'online-mode line missing');
  }

  // ── Bonus: cross-engine swap paper → vanilla UP_TO ────────────────────────
  console.log(`\n${Y('▶')} Step 5 (bonus): cross-engine swap paper → vanilla ${UP_TO}`);
  const cs = Date.now();
  const swap2 = await api(jar, `/api/servers/${sid}/swap-jar`, {
    method: 'POST',
    body: { type: 'vanilla', version: UP_TO },
  });
  expect('cross-engine swap accepted', swap2.ok, swap2.body?.error);
  if (swap2.ok) {
    const boot3 = await pollOnline(jar, sid, 5*60*1000, cs);
    expect(`vanilla ${UP_TO} reaches online after cross-engine swap`, boot3.online, boot3.online ? `${Math.round(boot3.ms/1000)}s` : `last=${boot3.last}`);
    const r2 = await api(jar, `/api/servers/${sid}/files/read?path=${encodeURIComponent(markerPath)}`);
    expect('marker still in world/ after cross-engine swap', r2.ok && r2.body?.content === markerToken, `got ${r2.body?.content?.slice(0,16) || '—'}`);
    const ls2 = await api(jar, '/api/servers');
    const fr2 = ls2.body?.servers?.find(s => s.id === sid);
    expect(`DB shows vanilla ${UP_TO}`, fr2?.type === 'vanilla' && fr2?.version === UP_TO, `${fr2?.type} ${fr2?.version}`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await api(jar, `/api/servers/${sid}`, { method: 'DELETE' }).catch(() => {});
  await api(jar, '/api/auth/me', { method: 'DELETE', body: { password: 'irrelevant', confirm: 'DELETE' } }).catch(() => {});

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = pass + fail;
  console.log('\n─── Upgrade flow results ───');
  console.log(`  ${G(pass + ' pass')} · ${fail ? R(fail + ' fail') : '0 fail'} · ${total} total`);
  console.log(`  Wall time: ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(fail === 0 ? G('  ✅ in-place upgrade preserves world + boots new JAR') : R('  ❌ upgrade flow has gaps'));
  process.exit(fail === 0 ? 0 : 1);
})();
