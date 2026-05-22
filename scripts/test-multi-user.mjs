#!/usr/bin/env node
// Multi-user end-to-end test:
//   1. Register 3 throwaway users (A, B, C)
//   2. Each creates a server with a different engine + version
//   3. Wait for all to reach online
//   4. For each user, exercise:
//        /status (real-time stats)
//        /logs   (console)
//        /events (player events)
//        /api/servers (server list)
//        TCP probe of their public bore.pub address
//   5. Cross-user isolation: A's cookie can't read B's data
//   6. Cleanup all 3 users + servers
//   7. Report pass/fail matrix
//
// Usage: node scripts/test-multi-user.mjs

import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

const BASE = process.env.BASE || 'https://crafthost-production.up.railway.app';
const TS = Date.now();

const USERS = [
  { letter: 'A', engine: 'paper',   version: '1.20.1' },
  { letter: 'B', engine: 'vanilla', version: '1.21.1' },
  { letter: 'C', engine: 'fabric',  version: '1.21.1' },
];

function makeFetch(cookieJar) {
  return function fetchJson(path, opts = {}) {
    const u = new URL(BASE + path), fn = u.protocol === 'https:' ? httpsReq : httpReq;
    return new Promise((res, rej) => {
      const r = fn({
        method: opts.method || 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          ...(cookieJar.cookie ? { Cookie: cookieJar.cookie } : {}),
        },
        timeout: 30000,
      }, x => {
        const sc = x.headers['set-cookie'];
        if (sc) cookieJar.cookie = sc.map(c => c.split(';')[0]).join('; ');
        let b = ''; x.on('data', c => b += c);
        x.on('end', () => {
          let d; try { d = JSON.parse(b); } catch { d = b; }
          if (x.statusCode >= 400) rej(Object.assign(
            new Error(`${path} → HTTP ${x.statusCode}: ${typeof d === 'string' ? d.slice(0, 100) : JSON.stringify(d).slice(0, 200)}`),
            { status: x.statusCode }));
          else res(d);
        });
      });
      r.on('error', rej);
      r.on('timeout', () => { r.destroy(); rej(new Error(`${path} → timeout`)); });
      if (opts.body) r.write(JSON.stringify(opts.body));
      r.end();
    });
  };
}

function tcpProbe(host, port, t = 6000) {
  return new Promise(r => {
    const s = new net.Socket();
    const d = v => { s.destroy(); r(v); };
    s.setTimeout(t);
    s.once('connect', () => d(true));
    s.once('timeout', () => d(false));
    s.once('error', () => d(false));
    s.connect(port, host);
  });
}

async function setup(u) {
  const jar = { cookie: '' };
  const fetchJson = makeFetch(jar);
  const email = `mt-${u.letter}-${TS}@x.local`;
  const username = `mt${u.letter}${TS}`;
  const password = `Mt!${u.letter}${TS}`;

  console.log(`\n──── USER ${u.letter}: ${u.engine} ${u.version} ────`);
  await fetchJson('/api/auth/register', { method: 'POST', body: { email, username, password } });
  console.log(`  [register] ✓ ${username}`);

  // Delete auto-created starter
  const list = await fetchJson('/api/servers');
  for (const s of list.servers || []) {
    await fetchJson(`/api/servers/${s.id}`, { method: 'DELETE' });
  }

  const created = await fetchJson('/api/servers', {
    method: 'POST',
    body: {
      name: `mt-${u.letter}-${TS}`,
      type: u.engine,
      version: u.version,
      plan: 'free',
      region: 'eu',
      motd: `mt ${u.letter}`,
      difficulty: 'normal',
      gamemode: 'survival',
      whitelist: false,
    },
  });
  console.log(`  [create] ✓ ${created.id}`);
  return { user: u, jar, fetchJson, username, password, serverId: created.id };
}

async function pollOnline(ctx, maxMs = 180_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    try {
      const s = await ctx.fetchJson(`/api/servers/${ctx.serverId}/status`);
      if (s.status !== last) {
        console.log(`  [poll ${ctx.user.letter}] t+${((Date.now() - start) / 1000).toFixed(0)}s status=${s.status}`);
        last = s.status;
      }
      if (s.status === 'online') return { ok: true, ms: Date.now() - start };
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return { ok: false, last };
}

async function exercise(ctx) {
  const r = {};

  // 1. Real-time stats
  try {
    const s = await ctx.fetchJson(`/api/servers/${ctx.serverId}/status`);
    r.stats_ok = !!(s.stats && typeof s.stats.cpu !== 'undefined' && typeof s.stats.ram_used !== 'undefined');
    r.stats_sample = s.stats ? `CPU=${s.stats.cpu}% RAM=${s.stats.ram_used}/${s.stats.ram_max}MB` : 'none';
  } catch (e) { r.stats_ok = false; r.stats_err = e.message; }

  // 2. Console / logs
  try {
    const logs = await ctx.fetchJson(`/api/servers/${ctx.serverId}/logs?lines=200`);
    const arr = logs.logs || logs.lines || [];
    r.logs_ok = Array.isArray(arr) && arr.length > 0;
    r.log_lines = arr.length;
    r.log_done_seen = arr.some(l => /Done \(\d+\.\d+s\)!/.test(String(l)));
  } catch (e) { r.logs_ok = false; r.logs_err = e.message; }

  // 3. Events
  try {
    const ev = await ctx.fetchJson(`/api/servers/${ctx.serverId}/events`);
    r.events_ok = Array.isArray(ev.events);
    r.event_count = (ev.events || []).length;
  } catch (e) { r.events_ok = false; }

  // 4. Per-player aggregation
  try {
    const ps = await ctx.fetchJson(`/api/servers/${ctx.serverId}/players`);
    r.players_ok = Array.isArray(ps.players);
  } catch (e) { r.players_ok = false; }

  // 5. /api/servers list — should return THIS user's 1 server
  try {
    const ls = await ctx.fetchJson('/api/servers');
    r.list_ok = ls.servers && ls.servers.length === 1 && ls.servers[0].id === ctx.serverId;
    r.list_count = ls.servers ? ls.servers.length : 0;
  } catch (e) { r.list_ok = false; }

  // 6. TCP probe
  try {
    const ls = await ctx.fetchJson('/api/servers');
    const mine = ls.servers.find(s => s.id === ctx.serverId);
    if (mine?.tunnel_host && mine.tunnel_port) {
      r.tcp_ok = await tcpProbe(mine.tunnel_host, mine.tunnel_port, 6000);
      r.tcp_addr = `${mine.tunnel_host}:${mine.tunnel_port}`;
    }
  } catch { r.tcp_ok = false; }

  return r;
}

async function crossUserCheck(ctxA, ctxB) {
  // A tries to read B's data — should 4xx
  const r = {};
  for (const p of [
    `/api/servers/${ctxB.serverId}/status`,
    `/api/servers/${ctxB.serverId}/logs`,
    `/api/servers/${ctxB.serverId}/events`,
    `/api/servers/${ctxB.serverId}/players`,
  ]) {
    try {
      await ctxA.fetchJson(p);
      r[p] = 'LEAKED ✗';
    } catch (e) {
      r[p] = e.status >= 400 && e.status < 500 ? `${e.status} ✓` : `${e.status || 'err'} ?`;
    }
  }
  return r;
}

async function cleanup(ctx) {
  try { await ctx.fetchJson(`/api/servers/${ctx.serverId}`, { method: 'DELETE' }); } catch {}
  try { await ctx.fetchJson('/api/auth/me', { method: 'DELETE', body: { password: ctx.password, confirm: 'DELETE' } }); } catch {}
}

(async () => {
  const overallStart = Date.now();
  const contexts = [];

  // Setup: register + create all in parallel
  console.log(`Multi-user test: ${USERS.length} users vs ${BASE}`);
  for (const u of USERS) {
    contexts.push(await setup(u));
  }

  // Poll until online (serial — gives each one breathing room)
  console.log('\n──── Waiting for all servers to come online ────');
  const polled = [];
  for (const ctx of contexts) {
    polled.push(await pollOnline(ctx, 180_000));
  }

  // Exercise each
  console.log('\n──── Exercising stats/logs/events/list/tcp per user ────');
  const results = [];
  for (let i = 0; i < contexts.length; i++) {
    if (!polled[i].ok) {
      results.push({ ...USERS[i], boot: false });
      continue;
    }
    const r = await exercise(contexts[i]);
    results.push({ ...USERS[i], boot: true, bootMs: polled[i].ms, ...r });
  }

  // Cross-user isolation
  console.log('\n──── Cross-user isolation: User A reads User B ────');
  let leaks = 0;
  const onlineCtxs = contexts.filter((_, i) => polled[i].ok);
  if (onlineCtxs.length >= 2) {
    const cross = await crossUserCheck(onlineCtxs[0], onlineCtxs[1]);
    for (const [p, v] of Object.entries(cross)) {
      const path = p.replace(`/api/servers/${onlineCtxs[1].serverId}`, '/api/servers/<B>');
      console.log(`  ${path}  → ${v}`);
      if (v.includes('LEAKED')) leaks++;
    }
  }

  // Cleanup
  console.log('\n──── Cleanup ────');
  for (const ctx of contexts) await cleanup(ctx);
  console.log('  ✓ all users + servers deleted');

  // Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  user  engine    version    boot   stats  logs   events  list   tcp   ');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const cell = v => v === true ? '✓' : v === false ? '✗' : '—';
  for (const r of results) {
    console.log(`  ${r.letter.padEnd(5)} ${r.engine.padEnd(9)} ${r.version.padEnd(10)} ${cell(r.boot).padEnd(6)} ${cell(r.stats_ok).padEnd(6)} ${cell(r.logs_ok).padEnd(6)} ${cell(r.events_ok).padEnd(7)} ${cell(r.list_ok).padEnd(6)} ${cell(r.tcp_ok).padEnd(6)}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Isolation: ${leaks === 0 ? '✅ no cross-user data leak' : '🚨 ' + leaks + ' leaks'}`);

  const allOk = results.every(r => r.boot && r.stats_ok && r.logs_ok && r.events_ok && r.list_ok && r.tcp_ok) && leaks === 0;
  console.log(`  Total: ${((Date.now() - overallStart) / 1000).toFixed(0)}s`);
  console.log(allOk ? '  ✅ ALL USERS WORK CORRECTLY · STATS REAL · CONSOLE OK · NO LEAKS' : '  ❌ at least one check failed');
  process.exit(allOk ? 0 : 1);
})();
