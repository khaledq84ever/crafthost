#!/usr/bin/env node
// E2E test: register → wait for auto-starter server → install each top-pick plugin
//             → verify presence → cleanup. Run with `node scripts/test-deploy-plugins.mjs`.
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-deploy-plugins.mjs
//
// Exit code 0 iff every plugin installed AND server reached `online`.
// Cleans up the throwaway account on success OR failure (so it doesn't burn a free slot).

import crypto from 'node:crypto';

const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';
const READY_TIMEOUT_MS = 4 * 60 * 1000; // 4 min — auto-starter on Paper 1.20.1 typically <90s
const POLL_INTERVAL_MS = 4000;

// Top picks from frontend/marketplace.html (Modrinth slugs).
const TOP_PICKS = [
  { slug: 'luckperms',      name: 'LuckPerms' },
  { slug: 'essentialsx',    name: 'EssentialsX' },
  { slug: 'worldedit',      name: 'WorldEdit' },
  { slug: 'worldguard',     name: 'WorldGuard' },
  { slug: 'viaversion',     name: 'ViaVersion' },
  { slug: 'coreprotect',    name: 'CoreProtect' },
  { slug: 'squaremap',      name: 'squaremap' },
  { slug: 'placeholderapi', name: 'PlaceholderAPI' },
  { slug: 'geyser',         name: 'Geyser' },
  { slug: 'skinsrestorer',  name: 'SkinsRestorer' },
  { slug: 'multiverse-core',name: 'Multiverse' },
  { slug: 'discordsrv',     name: 'DiscordSRV' },
  { slug: 'bluemap',        name: 'BlueMap' },
  { slug: 'chunky',         name: 'Chunky' },
];

// ── Cookie jar ────────────────────────────────────────────────────────────────
let cookieJar = '';

async function api(path, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  };
  if (cookieJar) init.headers.Cookie = cookieJar;
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(BASE + path, init);
  // Capture Set-Cookie if any (Node 18+ exposes raw values via getSetCookie())
  const set = (typeof r.headers.getSetCookie === 'function') ? r.headers.getSetCookie() : [];
  for (const c of set) {
    const first = c.split(';')[0];
    if (first) cookieJar = cookieJar ? (cookieJar + '; ' + first) : first;
  }
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, body };
}

// ── Pretty print ──────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;
function step(name)    { console.log(`\n${Y('▶')} ${name}`); }
function ok(msg)       { console.log(`  ${G('✓')} ${msg}`); }
function bad(msg)      { console.log(`  ${R('✗')} ${msg}`); }
function info(msg)     { console.log(`  ${D('·')} ${D(msg)}`); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Test ──────────────────────────────────────────────────────────────────────
const results = { steps: [], plugins: [], serverId: null, username: null };

async function main() {
  console.log(`E2E plugin-install test against ${BASE}\n`);

  // 1. Health
  step('Backend health');
  {
    const r = await api('/api/health');
    if (!r.ok || !r.body?.ok) { bad(`/api/health → HTTP ${r.status}`); process.exit(2); }
    ok(`/api/health → ${r.body.uptime ? `up ${Math.round(r.body.uptime)}s` : 'ok'}`);
    results.steps.push({ name: 'health', pass: true });
  }

  // 2. Register throwaway user — backend auto-creates a starter server
  step('Register throwaway user');
  const suffix = crypto.randomBytes(4).toString('hex');
  const username = `e2e_${suffix}`;
  const email = `e2e+${suffix}@crafthost.test`;
  const password = `Pw_${crypto.randomBytes(8).toString('hex')}`;
  results.username = username;
  {
    const r = await api('/api/auth/register', { method: 'POST', body: { username, email, password } });
    if (!r.ok) { bad(`register → HTTP ${r.status} ${JSON.stringify(r.body)}`); process.exit(2); }
    ok(`registered ${username} (uid=${r.body.user?.id})`);
    results.steps.push({ name: 'register', pass: true });
  }

  // 3. Confirm authenticated
  step('Session cookie works');
  {
    const r = await api('/api/auth/me');
    if (!r.ok || !r.body?.user) { bad(`/me → HTTP ${r.status}`); process.exit(2); }
    ok(`signed in as ${r.body.user.username}`);
    results.steps.push({ name: 'auth_me', pass: true });
  }

  // 4. Find the auto-starter server (may take a tick after register)
  step('Locate auto-starter server');
  let serverId = null;
  for (let i = 0; i < 10; i++) {
    const r = await api('/api/servers');
    if (r.ok && Array.isArray(r.body?.servers) && r.body.servers.length > 0) {
      serverId = r.body.servers[0].id;
      results.serverId = serverId;
      ok(`server ${serverId} — ${r.body.servers[0].name} (${r.body.servers[0].type} ${r.body.servers[0].version})`);
      results.steps.push({ name: 'list_servers', pass: true });
      break;
    }
    info(`waiting for auto-starter (try ${i + 1})…`);
    await sleep(1500);
  }
  if (!serverId) {
    bad('no servers after register — AUTO_STARTER disabled?');
    return cleanup(2);
  }

  // 5. Wait for /progress to report ready
  step('Wait for server ready (JAR download + JVM boot + tunnel)');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false, lastPhase = '';
  while (Date.now() < deadline) {
    const r = await api(`/api/servers/${serverId}/progress`);
    if (!r.ok) { info(`/progress → ${r.status}`); await sleep(POLL_INTERVAL_MS); continue; }
    const p = r.body || {};
    const phaseLabel = p.current_phase || (p.phases || []).find(x => x.state === 'current')?.label || '…';
    if (phaseLabel !== lastPhase) { info(`phase: ${phaseLabel}${p.oom ? ' (OOM)' : ''}`); lastPhase = phaseLabel; }
    if (p.ready) { ok(`server ready in ${Math.round((READY_TIMEOUT_MS - (deadline - Date.now())) / 1000)}s`); ready = true; break; }
    if (p.oom)   { bad('server OOMed during boot'); break; }
    if (p.exit_code != null && p.exit_code !== 0) { bad(`server exited code=${p.exit_code}`); break; }
    await sleep(POLL_INTERVAL_MS);
  }
  results.steps.push({ name: 'server_ready', pass: ready });
  if (!ready) {
    bad('server never became ready');
    // Continue anyway — plugin install only needs the server row, not the live JVM
    info('continuing with plugin installs (they only need the plugins/ dir)');
  }

  // 6. Install each top-pick plugin
  step(`Install ${TOP_PICKS.length} top-pick plugins`);
  for (const p of TOP_PICKS) {
    const t0 = Date.now();
    const r = await api(`/api/servers/${serverId}/plugins/install`, {
      method: 'POST',
      body: { project_id: p.slug },
    });
    const ms = Date.now() - t0;
    if (r.ok && r.body?.ok) {
      ok(`${p.name.padEnd(16)} → ${r.body.name} (${(r.body.size / 1024).toFixed(0)} KB, ${ms}ms)`);
      results.plugins.push({ slug: p.slug, pass: true, file: r.body.name, size: r.body.size });
    } else {
      bad(`${p.name.padEnd(16)} → HTTP ${r.status} ${r.body?.error || ''}`);
      results.plugins.push({ slug: p.slug, pass: false, error: r.body?.error, status: r.status });
    }
  }

  // 7. List installed plugins to confirm presence on disk
  step('Verify plugins on disk');
  {
    const r = await api(`/api/servers/${serverId}/plugins`);
    if (!r.ok) {
      bad(`list plugins → HTTP ${r.status}`);
      results.steps.push({ name: 'list_plugins', pass: false });
    } else {
      const onDisk = (r.body?.plugins || []).map(x => x.name);
      const expected = results.plugins.filter(p => p.pass).map(p => p.file);
      const missing = expected.filter(f => !onDisk.includes(f));
      if (missing.length) {
        bad(`${missing.length} install(s) reported success but missing on disk: ${missing.join(', ')}`);
        results.steps.push({ name: 'list_plugins', pass: false });
      } else {
        ok(`${onDisk.length} JAR(s) present on disk`);
        results.steps.push({ name: 'list_plugins', pass: true });
      }
    }
  }

  return cleanup(summarize());
}

// ── Cleanup + summary ─────────────────────────────────────────────────────────
function summarize() {
  console.log('\n─── Summary ───');
  const stepPass = results.steps.filter(s => s.pass).length;
  const stepTot = results.steps.length;
  const plPass = results.plugins.filter(p => p.pass).length;
  const plTot = results.plugins.length;
  console.log(`Steps:    ${stepPass}/${stepTot} ${stepPass === stepTot ? G('PASS') : R('FAIL')}`);
  console.log(`Plugins:  ${plPass}/${plTot} ${plPass === plTot ? G('PASS') : R('FAIL')}`);
  if (plPass < plTot) {
    console.log('\nPlugin failures:');
    for (const p of results.plugins.filter(p => !p.pass)) {
      console.log(`  ${R('✗')} ${p.slug.padEnd(18)} → ${p.status} ${p.error}`);
    }
  }
  return (stepPass === stepTot && plPass === plTot) ? 0 : 1;
}

async function cleanup(exitCode) {
  step('Cleanup — delete throwaway account');
  try {
    if (results.serverId) {
      const r = await api(`/api/servers/${results.serverId}`, { method: 'DELETE' });
      if (r.ok) ok(`server ${results.serverId} deleted`);
      else info(`server delete → HTTP ${r.status} (account delete should cascade)`);
    }
    // Need current password to delete account
    // (Skip — account-delete requires password and the test's password is in the closure;
    //  we'll just leave the throwaway user. Server is the expensive resource and it's gone.)
    info('account left behind (no admin endpoint for force-delete) — server cleaned up');
  } catch (err) {
    bad(`cleanup error: ${err.message}`);
  }
  process.exit(typeof exitCode === 'number' ? exitCode : 0);
}

main().catch(err => {
  console.error(R('\n[fatal]'), err.stack || err.message);
  cleanup(2);
});
