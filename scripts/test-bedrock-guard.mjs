#!/usr/bin/env node
// Verify the single-tunnel guard: only ONE server platform-wide can hold Bedrock.
//   1. user A: boot server, auto-enable Bedrock → 200
//   2. user B: boot server, auto-enable Bedrock (no takeover) → 409 bedrock_in_use,
//      conflict names A's server
//   3. user B: auto-enable with takeover:true → 200
//   4. user A's server is now disabled (playit_enabled=false)
//   5. cleanup both
//
// Usage: node scripts/test-bedrock-guard.mjs [baseUrl]
const BASE = process.argv[2] || 'https://crafthost-production.up.railway.app';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function mkClient() {
  let token = null;
  const H = () => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  return {
    setToken: (t) => { token = t; },
    async call(method, path, body) {
      const r = await fetch(BASE + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
      let data = null; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    },
  };
}

async function register(c, tag) {
  const rnd = Math.random().toString(36).slice(2, 9);
  const u = { username: `g${tag}_${rnd}`, email: `g${tag}_${rnd}@example.com`, password: 'guard-test-123' };
  const r = await c.call('POST', '/api/auth/register', u);
  if (r.status !== 200) throw new Error(`register ${tag} ${r.status}: ${JSON.stringify(r.data)}`);
  c.setToken(r.data.token);
  return { sid: r.data.starter?.id, name: r.data.starter?.name };
}

async function waitJvm(c, sid, maxS = 200) {
  for (let i = 0; i < maxS / 5; i++) {
    await sleep(5000);
    const p = await c.call('GET', `/api/servers/${sid}/progress`);
    if (p.data?.phases?.find(x => x.id === 'jvm')?.done) return true;
  }
  return false;
}

const A = mkClient(), B = mkClient();
let aSid = null, bSid = null;
async function cleanup() {
  if (aSid) { const d = await A.call('DELETE', `/api/servers/${aSid}`); log(`🧹 delete A ${aSid} → ${d.status}`); }
  if (bSid) { const d = await B.call('DELETE', `/api/servers/${bSid}`); log(`🧹 delete B ${bSid} → ${d.status}`); }
}

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); log(`  ✓ ${msg}`); }

async function main() {
  log(`▶ Bedrock single-tunnel GUARD test against ${BASE}`);

  const a = await register(A, 'a'); aSid = a.sid;
  const b = await register(B, 'b'); bSid = b.sid;
  log(`✓ A server ${aSid} ("${a.name}"), B server ${bSid} ("${b.name}")`);

  await A.call('POST', `/api/servers/${aSid}/start`);
  if (!await waitJvm(A, aSid)) throw new Error('A JVM never came up');
  log('✓ A booted');

  const aEnable = await A.call('POST', `/api/servers/${aSid}/playit/auto-enable`);
  assert(aEnable.status === 200, 'A enables Bedrock (200)');
  const mode = aEnable.data?.mode;
  log(`  backend mode: ${mode}`);

  if (mode === 'per-server') {
    // Per-server tunnels (BEDROCK_PER_SERVER=1): every server has its own
    // Bedrock tunnel — B must ALSO enable fine, and A must stay enabled.
    const bEnable = await B.call('POST', `/api/servers/${bSid}/playit/auto-enable`);
    assert(bEnable.status === 200, 'B enables Bedrock too (200, no takeover needed)');

    const aList = await A.call('GET', '/api/servers');
    const aNow = (aList.data?.servers || []).find(x => x.id === aSid);
    assert(aNow && aNow.playit_enabled === true, 'A remains enabled alongside B');

    const bList = await B.call('GET', '/api/servers');
    const bNow = (bList.data?.servers || []).find(x => x.id === bSid);
    assert(bNow && bNow.playit_enabled === true, 'B is enabled');

    log('\n✅ PASS — per-server mode: both servers hold Bedrock concurrently.');
    return;
  }

  // Legacy shared tunnel: one holder platform-wide, takeover moves it.
  const bBlocked = await B.call('POST', `/api/servers/${bSid}/playit/auto-enable`);
  assert(bBlocked.status === 409, 'B is blocked with 409');
  assert(bBlocked.data?.code === 'bedrock_in_use', 'B 409 has code=bedrock_in_use');
  assert(bBlocked.data?.conflict?.server_id === aSid, `B 409 conflict names A's server (${bBlocked.data?.conflict?.name})`);

  // B takes over — should succeed and disable A.
  const bTakeover = await B.call('POST', `/api/servers/${bSid}/playit/auto-enable`, { takeover: true });
  assert(bTakeover.status === 200 && bTakeover.data?.mode === 'shared', 'B takeover succeeds (200, shared)');

  const aList = await A.call('GET', '/api/servers');
  const aNow = (aList.data?.servers || []).find(x => x.id === aSid);
  assert(aNow && aNow.playit_enabled === false, 'A is now disabled after B took over');

  const bList = await B.call('GET', '/api/servers');
  const bNow = (bList.data?.servers || []).find(x => x.id === bSid);
  assert(bNow && bNow.playit_enabled === true, 'B is now the Bedrock holder');

  log('\n✅ PASS — single-tunnel guard enforced (409 block + takeover handoff).');
}

main().then(cleanup).catch(async (e) => { console.error('\n❌ FAIL:', e.message); await cleanup(); process.exit(1); });
