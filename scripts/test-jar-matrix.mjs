#!/usr/bin/env node
// JAR matrix test: for each (type × version) combo, deploy a real server,
// poll until ready OR fail, record the outcome. After every combo, give the
// backend's auto-fix loop ~25s to try to recover, then re-poll.
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-jar-matrix.mjs
//
// Each iteration:
//   1. Register a throwaway user (clean DB state per row)
//   2. Auto-starter creates the user's first server (paper 1.20.1 default).
//      Delete it so we can create one with the type we actually want to test.
//   3. POST /api/servers with the test (type, version)
//   4. Poll /progress every 3s for up to 4 minutes
//   5. Final state: ready | oom | crashed | timeout | auto-fixed
//   6. Clean up: delete the server
// Final summary: matrix with pass/fail/auto-fixed per row.

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
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`, B = s => `\x1b[34m${s}\x1b[0m`, D = s => `\x1b[2m${s}\x1b[0m`;

// Matrix to test. Each row = one JAR type, with the best-known safe version
// for the 384 MB heap budget. Heavier versions (1.21+) get tested too so we
// can see if the auto-fix loop swaps them to the safe combo.
const MATRIX = [
  { type: 'paper',    version: '1.20.1', expect: 'ready',     note: 'safest combo for 384MB' },
  { type: 'vanilla',  version: '1.20.1', expect: 'ready',     note: 'official server.jar' },
  { type: 'purpur',   version: '1.20.1', expect: 'ready',     note: 'Paper fork' },
  { type: 'fabric',   version: '1.20.1', expect: 'oom-or-ready', note: 'Fabric heavier than Paper' },
  { type: 'paper',    version: '1.21.1', expect: 'oom-then-healed', note: '1.21 OOMs at 300MB heap, auto-heal kicks in' },
  { type: 'neoforge', version: '1.21.1', expect: 'oom-then-healed', note: 'NeoForge needs more RAM than we have' },
];

const READY_TIMEOUT_MS = 4 * 60 * 1000; // 4 min per combo
const AUTO_FIX_WINDOW_MS = 30 * 1000;   // wait 30s after first failure for auto-fix to attempt

const results = [];

async function deleteAllMyServers() {
  const r = await api('/api/servers');
  for (const s of r.body?.servers || []) {
    try { await api(`/api/servers/${s.id}`, { method: 'DELETE' }); } catch {}
  }
}

async function testCombo(combo) {
  const label = `${combo.type} ${combo.version}`;
  console.log(`\n${Y('▶')} ${label.padEnd(20)} ${D(combo.note)}`);
  const t0 = Date.now();

  // Free tier allows only 1 running server at a time. Make sure we're clean first.
  await deleteAllMyServers();
  await sleep(1500);

  // Create with explicit type + version (no auto-starter for these tests)
  const create = await api('/api/servers', {
    method: 'POST',
    body: {
      name: `mx-${combo.type}-${combo.version.replace(/\./g, '_')}`,
      type: combo.type,
      version: combo.version,
      plan: 'free',
    },
  });
  if (!create.ok) {
    console.log(`  ${R('✗')} create failed: HTTP ${create.status} ${JSON.stringify(create.body)}`);
    results.push({ ...combo, outcome: 'create_failed', detail: create.body?.error, elapsed: 0 });
    return;
  }
  const sid = create.body?.id;
  console.log(`  ${D('created')} id=${sid} (${Date.now() - t0}ms)`);

  // Poll /progress
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastPhase = '';
  let firstFailAt = null;
  let outcome = 'timeout';
  let detail = null;
  let healedKind = null;
  let healedVersion = null;

  while (Date.now() < deadline) {
    const p = await api(`/api/servers/${sid}/progress`);
    if (!p.ok) { await sleep(3000); continue; }
    const data = p.body || {};
    const phaseLabel = (data.phases || []).find(x => x.current)?.label || data.current_phase || '…';
    if (phaseLabel !== lastPhase) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`  ${D(`[+${elapsed}s]`)} ${phaseLabel}`);
      lastPhase = phaseLabel;
    }
    if (data.ready) {
      outcome = healedKind ? 'auto-healed' : 'ready';
      detail = `boot in ${Math.round((Date.now() - t0) / 1000)}s`;
      break;
    }
    if (data.oom || (data.exit_code != null && data.exit_code !== 0)) {
      if (!firstFailAt) {
        firstFailAt = Date.now();
        console.log(`  ${Y('⚠')} fail detected: oom=${!!data.oom} exit=${data.exit_code} — giving auto-fix ${AUTO_FIX_WINDOW_MS/1000}s`);
      }
      // After AUTO_FIX_WINDOW_MS without recovery, check if the version was swapped (auto-heal)
      if (Date.now() - firstFailAt > AUTO_FIX_WINDOW_MS) {
        // Re-fetch server row to see if auto-heal swapped the type/version
        const sList = await api('/api/servers');
        const fresh = sList.body?.servers?.find(s => s.id === sid);
        if (fresh && (fresh.type !== combo.type || fresh.version !== combo.version)) {
          healedKind = 'version-swap';
          healedVersion = `${fresh.type} ${fresh.version}`;
          console.log(`  ${B('🔧')} auto-healed: swapped to ${healedVersion} — continuing to wait for ready`);
          firstFailAt = null; // give it more time to boot with new version
        }
      }
    }
    await sleep(3000);
  }

  if (outcome === 'timeout' && firstFailAt) outcome = 'failed';
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const color = outcome === 'ready' ? G : outcome === 'auto-healed' ? B : R;
  console.log(`  ${color('●')} ${color(outcome.toUpperCase())} after ${elapsed}s${healedVersion ? ` (healed to ${healedVersion})` : ''}`);

  results.push({ ...combo, outcome, detail, healedTo: healedVersion, elapsed });

  // Cleanup
  await api(`/api/servers/${sid}`, { method: 'DELETE' });
  await sleep(500);
}

// ── Run ─────────────────────────────────────────────────────────────────────
console.log(`\nJAR Matrix test against ${BASE}`);
console.log(`Testing ${MATRIX.length} (type × version) combos, ${READY_TIMEOUT_MS/60_000}min timeout each\n`);

// Register one throwaway account to run the whole matrix under
const suffix = crypto.randomBytes(4).toString('hex');
const reg = await api('/api/auth/register', {
  method: 'POST',
  body: { username: `mx_${suffix}`, email: `mx+${suffix}@test.io`, password: 'Pw_' + crypto.randomBytes(8).toString('hex') },
});
if (!reg.ok) {
  console.error(R('Could not register test user:'), reg.status, reg.body);
  process.exit(2);
}
console.log(G(`✓ registered mx_${suffix} (uid=${reg.body?.user?.id})`));

for (const combo of MATRIX) {
  await testCombo(combo);
}

// Final cleanup
await deleteAllMyServers();

// ── Summary table ───────────────────────────────────────────────────────────
console.log(`\n─── JAR Matrix Results ───`);
console.log('  Type      Version    Outcome          Time     Healed-To');
for (const r of results) {
  const color = r.outcome === 'ready' ? G : r.outcome === 'auto-healed' ? B : R;
  console.log(`  ${r.type.padEnd(10)}${r.version.padEnd(11)}${color(r.outcome.padEnd(17))}${(r.elapsed + 's').padEnd(9)}${r.healedTo || '—'}`);
}

const ready = results.filter(r => r.outcome === 'ready').length;
const healed = results.filter(r => r.outcome === 'auto-healed').length;
const failed = results.filter(r => !['ready', 'auto-healed'].includes(r.outcome)).length;

console.log(`\n  ${G(ready + ' ready')} · ${B(healed + ' auto-healed')} · ${failed ? R(failed + ' failed') : '0 failed'}`);
console.log(`  Total: ${results.length} combos · ${results.reduce((a, b) => a + b.elapsed, 0)}s wall time`);

process.exit(failed === 0 ? 0 : 1);
