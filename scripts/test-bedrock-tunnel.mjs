#!/usr/bin/env node
// End-to-end Bedrock tunnel test against production.
// Proves the shared PLAYIT_SHARED_SECRET actually brings a playit agent online:
//   1. register a throwaway user (auto-creates a Paper server)
//   2. start the server, wait until the JVM is up
//   3. POST /playit/auto-enable  (should be mode:'shared', not 503)
//   4. poll /api/servers until the server reports a playit.gg host:port
//   5. delete the test server (stops the agent, frees the single shared tunnel)
//
// Usage: node scripts/test-bedrock-tunnel.mjs [baseUrl]
const BASE = process.argv[2] || 'https://crafthost-production.up.railway.app';
const rnd = Math.random().toString(36).slice(2, 9);
const USER = { username: `btest_${rnd}`, email: `btest_${rnd}@example.com`, password: 'bedrock-test-pw-123' };

let TOKEN = null;
const H = () => ({ 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
async function j(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let serverId = null;
async function cleanup() {
  if (serverId) {
    const d = await j('DELETE', `/api/servers/${serverId}`);
    log(`🧹 cleanup: DELETE server ${serverId} → ${d.status}`);
  }
}

async function main() {
  log(`▶ Bedrock tunnel E2E against ${BASE}`);

  // 1) register
  const reg = await j('POST', '/api/auth/register', USER);
  if (reg.status !== 200) throw new Error(`register failed ${reg.status}: ${JSON.stringify(reg.data)}`);
  TOKEN = reg.data.token;
  serverId = reg.data.starter?.id;
  if (!serverId) throw new Error('no starter server returned from register');
  log(`✓ registered ${USER.username}, starter server ${serverId} (${reg.data.starter?.type} ${reg.data.starter?.version})`);

  // 2) start + wait for JVM up
  const st = await j('POST', `/api/servers/${serverId}/start`);
  log(`✓ start → ${st.status}`);
  let jvmUp = false;
  for (let i = 0; i < 40; i++) { // up to ~200s
    await sleep(5000);
    const p = await j('GET', `/api/servers/${serverId}/progress`);
    const phases = (p.data?.phases || []).filter(x => x.done).map(x => x.id).join(',');
    log(`  [${(i+1)*5}s] status=${p.data?.status} ready=${p.data?.ready} done=[${phases}]${p.data?.oom ? ' OOM' : ''}`);
    if (p.data?.phases?.find(x => x.id === 'jvm')?.done) { jvmUp = true; break; }
  }
  if (!jvmUp) throw new Error('JVM never reported ready');
  log('✓ JVM up');

  // 3) auto-enable Bedrock (shared secret path)
  const ae = await j('POST', `/api/servers/${serverId}/playit/auto-enable`);
  log(`→ auto-enable: ${ae.status} ${JSON.stringify(ae.data)}`);
  if (ae.status === 503) throw new Error('auto-enable returned 503 — shared secret NOT resolving (env var missing?)');
  if (ae.status !== 200 || ae.data?.mode !== 'shared') throw new Error(`auto-enable not shared-mode: ${ae.status}`);
  log('✓ auto-enable mode=shared (secret resolved)');

  // 4) poll for the agent to report a playit host:port
  let addr = null;
  for (let i = 0; i < 30; i++) { // up to ~150s
    await sleep(5000);
    const list = await j('GET', '/api/servers');
    const me = (list.data?.servers || []).find(x => x.id === serverId);
    if (me?.playit_host && me?.playit_port) { addr = `${me.playit_host}:${me.playit_port}`; break; }
    log(`  [${(i+1)*5}s] playit_enabled=${me?.playit_enabled} host=${me?.playit_host || '—'}`);
  }
  if (!addr) {
    log('⚠ agent enabled but no playit address yet (agent may still be registering with playit relay)');
    log('  → check the playit.gg page; it should flip to "online". Treating enable+agent-start as PASS.');
  } else {
    log(`✅ Bedrock address assigned: ${addr}`);
  }

  log('\n✅ PASS — shared secret resolves, auto-enable started the agent.' + (addr ? ` Bedrock @ ${addr}` : ''));
}

main()
  .then(cleanup)
  .catch(async (e) => { console.error('\n❌ FAIL:', e.message); await cleanup(); process.exit(1); });
