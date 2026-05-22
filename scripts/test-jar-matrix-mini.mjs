#!/usr/bin/env node
// Mini matrix — only the failed combos from the previous run, with a longer
// post-heal wait so we can confirm the auto-heal swap completes booting.
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

// Only the previously-failed combos. Test that auto-heal now works for all.
const MATRIX = [
  { type: 'vanilla',  version: '1.20.1' },
  { type: 'fabric',   version: '1.20.1' },
  { type: 'paper',    version: '1.21.1' },
];
const TIMEOUT_MS = 6 * 60 * 1000; // 6 min — give heal time

const suffix = crypto.randomBytes(4).toString('hex');
await api('/api/auth/register', { method: 'POST', body: { username: `mxm_${suffix}`, email: `mxm+${suffix}@t.io`, password: 'Pw_' + crypto.randomBytes(8).toString('hex') } });
console.log(G(`registered mxm_${suffix}`));

const results = [];
for (const combo of MATRIX) {
  console.log(`\n${Y('▶')} ${combo.type} ${combo.version}`);
  // clean
  const list = await api('/api/servers');
  for (const s of list.body?.servers || []) await api(`/api/servers/${s.id}`, { method: 'DELETE' });
  await sleep(1500);

  const t0 = Date.now();
  const c = await api('/api/servers', { method: 'POST', body: { name: `m-${combo.type}`, type: combo.type, version: combo.version, plan: 'free' } });
  const sid = c.body?.id;
  console.log(`  ${D('created')} ${sid}`);

  let outcome = 'timeout', healedTo = null, oomSeen = false;
  while (Date.now() - t0 < TIMEOUT_MS) {
    const p = await api(`/api/servers/${sid}/progress`);
    const d = p.body || {};
    if (d.ready) {
      const sList = await api('/api/servers');
      const fresh = sList.body?.servers?.find(s => s.id === sid);
      if (fresh && (fresh.type !== combo.type || fresh.version !== combo.version)) {
        outcome = 'auto-healed';
        healedTo = `${fresh.type} ${fresh.version}`;
      } else {
        outcome = 'ready';
      }
      break;
    }
    if (d.oom && !oomSeen) {
      oomSeen = true;
      console.log(`  ${Y('⚠')} OOM detected — waiting for auto-heal`);
    }
    await sleep(5000);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const color = outcome === 'ready' ? G : outcome === 'auto-healed' ? B : R;
  console.log(`  ${color('●')} ${color(outcome.toUpperCase())} after ${elapsed}s${healedTo ? ` (→ ${healedTo})` : ''}`);
  results.push({ ...combo, outcome, elapsed, healedTo });
  await api(`/api/servers/${sid}`, { method: 'DELETE' });
}

console.log(`\n─── Mini Matrix ───`);
for (const r of results) {
  const color = r.outcome === 'ready' ? G : r.outcome === 'auto-healed' ? B : R;
  console.log(`  ${r.type.padEnd(10)} ${r.version.padEnd(10)} ${color(r.outcome.padEnd(14))} ${r.elapsed}s ${r.healedTo || ''}`);
}
const ok = results.filter(r => ['ready','auto-healed'].includes(r.outcome)).length;
console.log(`\n  ${ok}/${results.length} resolved (ready or auto-healed)`);
process.exit(ok === results.length ? 0 : 1);
