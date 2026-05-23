#!/usr/bin/env node
// User-simulation + console-watcher + auto-fix.
// Acts like a real user: registers, creates a server, sends commands while
// streaming the live console log. Classifies anything that looks like a
// problem and attempts a fix (RAM bump, restart, recreate world).
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-user-sim-autofix.mjs

import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';
import { URL } from 'node:url';

const BASE = (process.env.BASE || 'https://crafthost-production.up.railway.app').replace(/\/$/, '');
const ENGINE = process.env.ENGINE || 'paper';
const VERSION = process.env.VERSION || '1.21.1';
const RUN_SECS = parseInt(process.env.RUN_SECS || '90', 10);

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let cookie = '';
function setCookie(setCookieHeader) {
  if (!setCookieHeader) return;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of arr) cookie = c.split(';')[0];
}

function call(path, opts = {}) {
  const u = new URL(BASE + path);
  const fn = u.protocol === 'https:' ? httpsReq : httpReq;
  const body = opts.body ? JSON.stringify(opts.body) : null;
  const headers = { 'Accept': 'application/json' };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  if (cookie) headers['Cookie'] = cookie;
  return new Promise((resolve, reject) => {
    const r = fn({ method: opts.method || 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers }, (res) => {
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        if (res.headers['set-cookie']) setCookie(res.headers['set-cookie']);
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const issues = [];
const fixes = [];
const noted = new Set();

// Classify a log line. Returns { kind, severity, fix? } or null.
function classify(line) {
  const l = line.toLowerCase();
  if (/outofmemory|java\.lang\.outofmemory|outofmemoryerror|gc overhead/i.test(line))
    return { kind: 'OOM', severity: 'critical', fix: 'bump-ram-restart' };
  if (/address already in use|bind exception|java\.net\.bindexception/i.test(line))
    return { kind: 'port-in-use', severity: 'high', fix: 'restart' };
  if (/encountered an unexpected exception|exception in server tick|fatal error/i.test(line))
    return { kind: 'server-crash', severity: 'high', fix: 'restart' };
  if (/corruption|chunk save failed|failed to load region/i.test(line))
    return { kind: 'world-corruption', severity: 'high', fix: 'restart' };
  if (/no main manifest attribute|unable to access jarfile|could not find or load main class/i.test(line))
    return { kind: 'bad-jar', severity: 'critical', fix: 'recreate' };
  if (/\[error\]|\[severe\]/i.test(line))
    return { kind: 'error-line', severity: 'medium', fix: null };
  if (/exception/i.test(line) && !/deprecated/i.test(line))
    return { kind: 'exception', severity: 'medium', fix: null };
  return null;
}

async function recordIssue(serverId, issue, line) {
  const key = `${issue.kind}:${line.slice(0, 80)}`;
  if (noted.has(key)) return;
  noted.add(key);
  issues.push({ ...issue, line, ts: Date.now() });
  console.log(`  ${R('⚠')}  [${issue.severity}] ${issue.kind} → ${line.trim().slice(0, 140)}`);
  if (issue.fix) await applyFix(serverId, issue);
}

async function applyFix(serverId, issue) {
  switch (issue.fix) {
    case 'bump-ram-restart': {
      console.log(`  ${Y('🔧')} fix: bumping RAM +512MB and restarting`);
      const cur = await call(`/api/servers/${serverId}/status`);
      const newRam = (cur.json?.ram_mb || 1024) + 512;
      const r1 = await call(`/api/servers/${serverId}`, { method: 'PATCH', body: { ram_mb: newRam } });
      const r2 = await call(`/api/servers/${serverId}/restart`, { method: 'POST' });
      fixes.push({ kind: issue.kind, action: `ram→${newRam}MB+restart`, ok: r1.status < 400 && r2.status < 400 });
      console.log(`     PATCH→${r1.status} RESTART→${r2.status}`);
      break;
    }
    case 'restart': {
      console.log(`  ${Y('🔧')} fix: restarting server`);
      const r = await call(`/api/servers/${serverId}/restart`, { method: 'POST' });
      fixes.push({ kind: issue.kind, action: 'restart', ok: r.status < 400 });
      console.log(`     RESTART→${r.status}`);
      break;
    }
    case 'recreate': {
      console.log(`  ${Y('🔧')} fix: recreate (delete + new)`);
      const d = await call(`/api/servers/${serverId}`, { method: 'DELETE' });
      fixes.push({ kind: issue.kind, action: 'delete-and-recreate', ok: d.status < 400 });
      console.log(`     DELETE→${d.status}`);
      break;
    }
  }
  await sleep(2000);
}

async function main() {
  console.log(B(`\n══ User-sim + console-watch + auto-fix ══`));
  console.log(D(`base=${BASE} engine=${ENGINE} version=${VERSION} run_secs=${RUN_SECS}\n`));

  // 1. Register (server auto-creates a starter server)
  const ts = Date.now();
  const username = `usersim_${ts}`;
  const email = `${username}@e.test`;
  console.log(`${Y('▶')} Register user ${email}`);
  const reg = await call('/api/auth/register', { method: 'POST', body: { username, email, password: 'TestPass123!' } });
  if (reg.status !== 200 && reg.status !== 201) {
    console.log(R(`✗ register failed: ${reg.status} ${reg.text.slice(0, 200)}`));
    process.exit(1);
  }
  console.log(G(`  ✓ registered`));

  // 2. Use starter server if present, else create one
  let serverId = reg.json?.starter?.id;
  if (!serverId) {
    console.log(`${Y('▶')} No starter, creating server (${ENGINE} ${VERSION})`);
    const create = await call('/api/servers', { method: 'POST', body: { name: `usersim_${ts}`, type: ENGINE, version: VERSION, plan: 'free', region: 'eu', motd: 'usersim', difficulty: 'normal', gamemode: 'survival', whitelist: false } });
    if (create.status >= 400) {
      console.log(R(`✗ create failed: ${create.status} ${create.text.slice(0, 200)}`));
      process.exit(1);
    }
    serverId = create.json?.id || create.json?.server?.id;
  } else {
    console.log(G(`  ✓ using starter server`));
  }
  console.log(G(`  ✓ server id=${serverId}`));

  // 3. Wait online
  console.log(`${Y('▶')} Waiting for server to boot…`);
  let online = false;
  for (let i = 0; i < 60; i++) {
    const s = await call(`/api/servers/${serverId}/status`);
    const st = s.json?.status || s.json?.state || 'unknown';
    if (i % 3 === 0) console.log(D(`     poll t+${i*2}s → ${st}`));
    if (st === 'online' || st === 'running') { online = true; break; }
    await sleep(2000);
  }
  if (!online) {
    console.log(R(`✗ server never came online`));
    await call(`/api/servers/${serverId}`, { method: 'DELETE' });
    process.exit(1);
  }
  console.log(G(`  ✓ online`));

  // 4. Console-watch + command-injection loop
  console.log(`${Y('▶')} Watching console + sending realistic user commands for ${RUN_SECS}s\n`);
  const cmds = ['list', 'tps', 'save-all', 'weather clear', 'time set day', 'gamerule keepInventory true', 'difficulty easy', 'gc', 'seed', 'spawnpoint @p 0 100 0'];
  let seenLines = new Set();
  let cmdIdx = 0;
  const start = Date.now();
  let cmdSent = 0, cmdOk = 0;

  while (Date.now() - start < RUN_SECS * 1000) {
    // Pull recent logs
    const logs = await call(`/api/servers/${serverId}/logs?lines=200`);
    const lines = (logs.json?.lines || logs.json?.logs || []).map(l => typeof l === 'string' ? l : (l.line || l.text || JSON.stringify(l)));
    for (const ln of lines) {
      if (seenLines.has(ln)) continue;
      seenLines.add(ln);
      const issue = classify(ln);
      if (issue) await recordIssue(serverId, issue, ln);
    }

    // Send a command
    const cmd = cmds[cmdIdx++ % cmds.length];
    const c = await call(`/api/servers/${serverId}/console`, { method: 'POST', body: { command: cmd } });
    cmdSent++;
    if (c.status < 400) {
      cmdOk++;
      const reply = (c.json?.response || '').trim().split('\n')[0].slice(0, 90);
      console.log(D(`  /${cmd.padEnd(28)} → ${c.status} ${reply}`));
    } else {
      console.log(R(`  /${cmd.padEnd(28)} → ${c.status} ${c.text.slice(0, 100)}`));
      issues.push({ kind: 'command-rejected', severity: 'medium', line: `/${cmd} → ${c.status}`, ts: Date.now() });
    }

    await sleep(4500);
  }

  // 5. Final status snapshot
  console.log(`\n${Y('▶')} Final status snapshot`);
  const final = await call(`/api/servers/${serverId}/status`);
  console.log(D(`  status=${final.json?.status} cpu=${final.json?.cpu_pct || 0}% ram=${final.json?.ram_mb_used || '?'}MB tps=${final.json?.tps || '?'} players=${final.json?.players_online || 0}/${final.json?.players_max || '?'}`));

  // 6. Cleanup
  console.log(`${Y('▶')} Cleanup`);
  const del = await call(`/api/servers/${serverId}`, { method: 'DELETE' });
  console.log(D(`  delete→${del.status}`));

  // 7. Report
  console.log(`\n${B('━━━━━━━━━━━━━━ REPORT ━━━━━━━━━━━━━━')}`);
  console.log(`Commands sent: ${cmdSent}  ·  accepted: ${cmdOk}  ·  rejected: ${cmdSent - cmdOk}`);
  console.log(`Log lines scanned: ${seenLines.size}`);
  console.log(`Issues detected: ${issues.length}`);
  if (issues.length) {
    const byKind = {};
    for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    for (const [k, v] of Object.entries(byKind)) console.log(`  - ${k}: ${v}`);
  }
  console.log(`Auto-fixes applied: ${fixes.length}`);
  for (const f of fixes) console.log(`  - ${f.kind} → ${f.action} (${f.ok ? G('ok') : R('failed')})`);

  const verdict = issues.filter(i => i.severity === 'critical').length === 0 && cmdOk >= Math.floor(cmdSent * 0.8);
  console.log(`\n${verdict ? G('✅ HEALTHY — no critical errors, commands working') : R('❌ PROBLEMS — see above')}`);
  process.exit(verdict ? 0 : 1);
}

main().catch(e => { console.error(R(`fatal: ${e.message}`)); console.error(e.stack); process.exit(2); });
