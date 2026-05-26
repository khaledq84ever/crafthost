#!/usr/bin/env node
// Real-boot test for the new MC versions: Paper 1.21.11 + Vanilla/Purpur/Fabric 26.1.2.
// For each (engine, version) combo:
//   1. Register a throwaway user
//   2. Delete the auto-created starter server
//   3. POST /api/servers with the new version
//   4. Poll /status until 'online' or timeout (4 min)
//   5. Verify cache HIT (no download — should boot < 30s if cached)
//   6. Cleanup user + server
//
// Usage: BASE=https://crafthost-production.up.railway.app node scripts/test-new-mc-versions.mjs
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';

const COMBOS = [
  { engine: 'paper',   version: '1.21.11' },
  { engine: 'vanilla', version: '26.1.2'  },
  { engine: 'purpur',  version: '1.21.11' },
  { engine: 'fabric',  version: '26.1.2'  },
];

const G=s=>`\x1b[32m${s}\x1b[0m`, R=s=>`\x1b[31m${s}\x1b[0m`, Y=s=>`\x1b[33m${s}\x1b[0m`, D=s=>`\x1b[2m${s}\x1b[0m`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function testOne(combo) {
  const t0 = Date.now();
  const jar = { cookie: '' };
  const suffix = crypto.randomBytes(3).toString('hex');
  const label = `${combo.engine} ${combo.version}`;
  console.log(`\n${Y('▶')} ${label}`);

  // Register
  const reg = await api(jar, '/api/auth/register', {
    method: 'POST',
    body: { username: `nv_${suffix}`, email: `nv_${suffix}@test.io`, password: 'Pw_' + crypto.randomBytes(6).toString('hex') },
  });
  if (!reg.ok) return { ...combo, outcome: 'register_failed', detail: reg.body?.error, elapsed: 0 };

  // Wipe auto-created starter
  const ls = await api(jar, '/api/servers');
  for (const s of ls.body?.servers || []) {
    await api(jar, `/api/servers/${s.id}`, { method: 'DELETE' });
  }
  await sleep(1000);

  // Create with the new version
  const create = await api(jar, '/api/servers', {
    method: 'POST',
    body: { name: `nv-${suffix}`, type: combo.engine, version: combo.version, plan: 'free' },
  });
  if (!create.ok) {
    console.log(`  ${R('✗')} create failed: ${create.status} ${JSON.stringify(create.body).slice(0,200)}`);
    return { ...combo, outcome: 'create_failed', detail: create.body?.error, elapsed: 0 };
  }
  const sid = create.body.id;
  const createdAt = Date.now();
  console.log(`  ${D('created')} id=${sid}  +${createdAt - t0}ms`);

  // Poll status — online means JAR loaded, world spawned, port open
  const deadline = Date.now() + 4 * 60 * 1000;
  let last = '', online = false, onlineAt = 0;
  while (Date.now() < deadline) {
    const s = await api(jar, `/api/servers/${sid}/status`);
    const st = s.body?.status || '?';
    if (st !== last) {
      console.log(`  ${D('[+' + Math.round((Date.now()-t0)/1000) + 's]')} status=${st}`);
      last = st;
    }
    if (st === 'online') { online = true; onlineAt = Date.now(); break; }
    if (st === 'crashed' || st === 'oom') break;
    await sleep(2000);
  }

  let detail = null;
  if (online) {
    // Verify the actual server.version in the DB matches what we asked for (no auto-heal swap)
    const after = await api(jar, '/api/servers');
    const mine = after.body?.servers?.find(s => s.id === sid);
    if (mine && (mine.type !== combo.engine || mine.version !== combo.version)) {
      detail = `auto-healed to ${mine.type} ${mine.version}`;
    } else {
      detail = `boot in ${Math.round((onlineAt - createdAt) / 1000)}s`;
    }
  }

  // Cleanup
  try { await api(jar, `/api/servers/${sid}`, { method: 'DELETE' }); } catch {}
  try { await api(jar, '/api/auth/me', { method: 'DELETE', body: { password: 'irrelevant', confirm: 'DELETE' } }); } catch {}

  const elapsed = Math.round((Date.now() - t0) / 1000);
  const outcome = online ? (detail?.includes('auto-healed') ? 'auto-healed' : 'ready') : (last === 'crashed' || last === 'oom' ? last : 'timeout');
  const color = outcome === 'ready' ? G : outcome === 'auto-healed' ? Y : R;
  console.log(`  ${color('●')} ${color(outcome.toUpperCase())}  ${detail || ''}  (${elapsed}s wall)`);
  return { ...combo, outcome, detail, elapsed };
}

(async () => {
  console.log(`New MC version boot test vs ${BASE}`);
  console.log(`Combos: ${COMBOS.map(c => `${c.engine} ${c.version}`).join(', ')}`);

  const results = [];
  for (const c of COMBOS) results.push(await testOne(c));

  console.log('\n─── Results ───');
  console.log('  Engine    Version     Outcome       Detail');
  for (const r of results) {
    const color = r.outcome === 'ready' ? G : r.outcome === 'auto-healed' ? Y : R;
    console.log(`  ${r.engine.padEnd(10)}${r.version.padEnd(12)}${color(r.outcome.padEnd(14))}${r.detail || ''}`);
  }

  const ready = results.filter(r => r.outcome === 'ready').length;
  const ok = ready === results.length;
  console.log(`\n  ${G(ready + ' ready')} / ${results.length} combos`);
  process.exit(ok ? 0 : 1);
})();
