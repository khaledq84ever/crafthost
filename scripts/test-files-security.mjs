#!/usr/bin/env node
// File manager containment: `..` and symlinks must not escape the server
// folder, odd filenames must download, and an unreadable file must not crash
// the backend. Needs filesystem access to the server's DATA_DIR, so run it
// against a local backend only.
//
//   BASE=http://localhost:4099 DATA_DIR=./data/servers node scripts/test-files-security.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:4099';
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data/servers');

let token = '';
async function api(p, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let r;
  try {
    r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    // A crashed backend must show up as a failed check, not abort the run.
    return { status: 0, body: null, text: String(err.cause?.code || err.message), headers: new Headers() };
  }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text, headers: r.headers };
}
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ${G('✓')} ${msg}`); pass++; }
  else      { console.log(`  ${R('✗')} ${msg}`); fail++; }
}

console.log(`\nFile manager security test against ${BASE} (DATA_DIR ${DATA_DIR})\n`);

const suffix = crypto.randomBytes(4).toString('hex');
const password = 'Pw_' + crypto.randomBytes(8).toString('hex');
const reg = await api('/api/auth/register', {
  method: 'POST', body: { username: `fs_${suffix}`, email: `fs+${suffix}@test.io`, password },
});
token = reg.body?.token;
const serverId = reg.body?.starter?.server?.id || reg.body?.starter?.id
  || (await api('/api/servers')).body?.servers?.[0]?.id;
check(!!token && !!serverId, `register + starter server (${serverId})`);
if (!serverId) process.exit(1);
const files = `/api/servers/${serverId}/files`;
const root = path.join(DATA_DIR, serverId);
fs.mkdirSync(root, { recursive: true });

console.log(`${Y('▶')} Path traversal`);
for (const p of ['../../../../etc/passwd', '/../../etc/passwd', '..\\..\\etc\\passwd']) {
  const r = await api(`${files}/read?path=${encodeURIComponent(p)}`);
  check(!r.text.includes('root:'), `read ${p} does not leak /etc/passwd (HTTP ${r.status})`);
}

console.log(`${Y('▶')} Symlinks out of the server folder`);
fs.symlinkSync('/etc', path.join(root, 'escape'));
fs.symlinkSync('/etc/passwd', path.join(root, 'passwd-link'));
{
  const list = await api(`${files}?path=/escape`);
  check(list.status === 400, `list /escape (-> /etc) → 400 (got ${list.status})`);
  const read = await api(`${files}/read?path=/passwd-link`);
  check(read.status === 400 && !read.text.includes('root:'), `read /passwd-link → 400 (got ${read.status})`);
  const dl = await api(`${files}/download?path=/passwd-link`);
  check(dl.status === 400 && !dl.text.includes('root:'), `download /passwd-link → 400 (got ${dl.status})`);
  const write = await api(`${files}/write`, { method: 'PUT', body: { path: '/escape/crafthost-pwned', content: 'x' } });
  check(write.status === 400, `write through /escape → 400 (got ${write.status})`);
}

console.log(`${Y('▶')} Downloads`);
{
  const name = 'wörld "save".txt';
  fs.writeFileSync(path.join(root, name), 'hello');
  const r = await api(`${files}/download?path=${encodeURIComponent('/' + name)}`);
  check(r.status === 200 && r.text === 'hello', `download of "${name}" → 200 (got ${r.status})`);
  check(/attachment/.test(r.headers.get('content-disposition') || ''), 'sends an attachment header');

  const missing = await api(`${files}/download?path=/nope.txt`);
  check(missing.status === 404, `missing file → 404 (got ${missing.status})`);

  if (process.getuid?.() !== 0) {
    const locked = path.join(root, 'locked.txt');
    fs.writeFileSync(locked, 'secret');
    fs.chmodSync(locked, 0o000);
    const r2 = await api(`${files}/download?path=/locked.txt`);
    check(r2.status === 500, `unreadable file → 500 (got ${r2.status})`);
    const h = await api('/api/health');
    check(h.status === 200, `backend still up afterwards (health ${h.status})`);
    fs.chmodSync(locked, 0o600);
  }
}

console.log(`${Y('▶')} Cleanup`);
{
  const r = await api('/api/auth/me', { method: 'DELETE', body: { password, confirm: 'DELETE' } });
  check(r.status === 200, `delete account → ${r.status}`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n─── Summary ───\nChecks: ${pass} pass / ${fail} fail · ${fail ? R('FAIL') : G('PASS')}`);
process.exit(fail ? 1 : 0);
