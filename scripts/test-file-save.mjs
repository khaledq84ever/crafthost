#!/usr/bin/env node
// One-off: register → wait for server.properties to exist → write → read back → cleanup.
// Run: BASE=https://crafthost-production.up.railway.app node scripts/test-file-save.mjs
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

const suffix = crypto.randomBytes(4).toString('hex');
console.log(`\n▶ Register e2e_${suffix}`);
const reg = await api('/api/auth/register', { method: 'POST', body: { username: `e2e_${suffix}`, email: `e2e+${suffix}@test.io`, password: 'Pw_'+crypto.randomBytes(8).toString('hex') } });
if (!reg.ok) { console.log('  ✗', reg.status, reg.body); process.exit(2); }
console.log('  ✓ uid=' + reg.body.user.id);

console.log('▶ Find server');
let sid = null;
for (let i = 0; i < 10; i++) {
  const r = await api('/api/servers');
  if (r.body?.servers?.length) { sid = r.body.servers[0].id; break; }
  await sleep(1500);
}
console.log('  ✓ server', sid);

console.log('▶ Wait for server.properties to exist (after JVM boots)');
let exists = false;
for (let i = 0; i < 40; i++) {
  const r = await api(`/api/servers/${sid}/files/read?path=/server.properties`);
  if (r.ok && r.body?.content != null) { exists = true; console.log(`  ✓ found after ${i*2}s (${r.body.size} bytes)`); break; }
  await sleep(2000);
}
if (!exists) { console.log('  ✗ server.properties never appeared — testing write to /test-save.txt instead'); }

const testPath = exists ? '/server.properties' : '/test-save.txt';
console.log(`▶ Read current content of ${testPath}`);
const before = await api(`/api/servers/${sid}/files/read?path=${encodeURIComponent(testPath)}`);
const oldContent = before.body?.content ?? '';
console.log(`  ✓ ${oldContent.length} bytes`);

const marker = `# E2E-MARKER-${suffix} ${new Date().toISOString()}\n`;
const newContent = exists ? marker + oldContent : marker;
console.log(`▶ PUT /files/write → set content (${newContent.length} bytes)`);
const wr = await api(`/api/servers/${sid}/files/write`, { method: 'PUT', body: { path: testPath, content: newContent } });
console.log(`  ${wr.ok ? '✓' : '✗'} HTTP ${wr.status} ${JSON.stringify(wr.body)}`);

console.log(`▶ Read back to verify`);
const after = await api(`/api/servers/${sid}/files/read?path=${encodeURIComponent(testPath)}`);
if (after.body?.content === newContent) {
  console.log('  ✓ READ-BACK MATCH — save works');
} else {
  console.log('  ✗ READ-BACK MISMATCH');
  console.log(`    expected ${newContent.length} bytes, got ${after.body?.content?.length}`);
  console.log(`    first 60 chars expected: ${JSON.stringify(newContent.slice(0,60))}`);
  console.log(`    first 60 chars actual:   ${JSON.stringify(after.body?.content?.slice(0,60))}`);
}

console.log(`▶ Delete server`);
await api(`/api/servers/${sid}`, { method: 'DELETE' });
console.log('  ✓');
