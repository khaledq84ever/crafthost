// Real Bedrock JOIN-path test: runs the RakNet connection handshake (not just a
// ping) through the public tunnel. Ping only proves the MOTD shows; the handshake
// proves the tunnel passes the larger MTU packets a real client uses to actually
// connect — the exact thing that fails when "ping works but join doesn't".
import dgram from 'node:dgram';
import dnsp from 'node:dns/promises';

const HOST = process.env.BR_HOST || 'president-status.gl.at.ply.gg';
const PORT = parseInt(process.env.BR_PORT || '65397', 10);
const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const CLIENT_GUID = Buffer.from('1122334455667788', 'hex');

const sock = dgram.createSocket('udp4');
let stage = 'ping', finished = false, serverIp4 = Buffer.from([0, 0, 0, 0]);

function done(msg) { if (finished) return; finished = true; try { sock.close(); } catch {} console.log(msg); process.exit(0); }
function send(buf) { sock.send(buf, PORT, HOST, (e) => { if (e) done('send error: ' + e.message); }); }

function ping() {
  const b = Buffer.alloc(33); let o = 0;
  b.writeUInt8(0x01, o); o += 1; b.writeBigInt64BE(BigInt(Date.now()), o); o += 8;
  MAGIC.copy(b, o); o += 16; CLIENT_GUID.copy(b, o); send(b);
}
function ocr1(mtu) { // Open Connection Request 1 — 0x05 + MAGIC + proto + zero padding to MTU
  const b = Buffer.alloc(mtu); b.fill(0); let o = 0;
  b.writeUInt8(0x05, o); o += 1; MAGIC.copy(b, o); o += 16; b.writeUInt8(11, o); send(b);
}
function ocr2(mtu, cookie) { // 0x07 + MAGIC + [cookie+0 if security] + serverAddr + mtu + clientGUID
  const b = Buffer.alloc(64); let o = 0;
  b.writeUInt8(0x07, o); o += 1; MAGIC.copy(b, o); o += 16;
  if (cookie != null) { b.writeUInt32BE(cookie >>> 0, o); o += 4; b.writeUInt8(0, o); o += 1; }
  b.writeUInt8(4, o); o += 1; serverIp4.copy(b, o); o += 4; b.writeUInt16BE(PORT, o); o += 2;
  b.writeUInt16BE(mtu, o); o += 2; CLIENT_GUID.copy(b, o); o += 8;
  send(b.subarray(0, o));
}

// A real client negotiates MTU down until one gets through. Try several sizes,
// each retransmitted twice (UDP is lossy), before giving up.
const MTUS = [1492, 1200, 576];
let mtuIdx = 0;
function probeNextMtu() {
  if (mtuIdx >= MTUS.length) {
    done('\nTunnel blocks ALL connection-sized packets (tried MTU 1492/1200/576) while ping passes.\n   => playit free tunnel only forwards tiny packets here; Bedrock can SEE the server but cannot JOIN.\n   Fix path: use a playit tunnel/region that forwards full MTU, or expose Bedrock via Railway UDP, not bore.');
    return;
  }
  const mtu = MTUS[mtuIdx++];
  console.log(`  [2/3] .. probing connection at MTU=${mtu}`);
  ocr1(mtu); setTimeout(() => ocr1(mtu), 400);
  setTimeout(() => { if (stage === 'ocr1') probeNextMtu(); }, 2500);
}

sock.on('message', (m) => {
  const id = m[0];
  if (id === 0x1c) {
    const t = m.slice(35).toString('utf8').split(';');
    console.log(`  [1/3] OK  Ping/MOTD: "${t[1]}" v${t[3]} ${t[4]}/${t[5]} players`);
    stage = 'ocr1'; probeNextMtu();
  } else if (id === 0x06) {
    if (stage === 'ocr2') return; // already advanced (dup reply)
    // 0x06 + MAGIC(16) + serverGUID(8) + security(1) + [cookie(4) if security] + MTU(2)
    const security = m[25];
    let cookie = null, mtu;
    if (security === 1) { cookie = m.readUInt32BE(26); mtu = m.readUInt16BE(30); }
    else { mtu = m.readUInt16BE(26); }
    if (!mtu || mtu > 1500) mtu = 1200; // sanity clamp
    console.log(`  [2/3] OK  Open Connection Reply 1 — tunnel forwards connection packets (security=${security}, MTU=${mtu})`);
    stage = 'ocr2'; ocr2(mtu, cookie); setTimeout(() => ocr2(mtu, cookie), 500);
  } else if (id === 0x08) {
    console.log('  [3/3] OK  Open Connection Reply 2 — RakNet SESSION ESTABLISHED');
    done('\nREAL JOIN PATH WORKS — a Bedrock client can open a full connection through the tunnel.\n   Connect with:  president-status.gl.at.ply.gg   port 65397');
  } else if (id === 0x19) {
    done('  Incompatible RakNet protocol (0x19) — transport is fine, just a version byte mismatch.');
  } else {
    console.log('  · packet id=0x' + id.toString(16));
  }
});
sock.on('error', (e) => done('socket error: ' + e.message));

const a = await dnsp.lookup(HOST).catch(() => null);
if (a) { serverIp4 = Buffer.from(a.address.split('.').map(Number)); console.log(`Resolved ${HOST} -> ${a.address}`); }
ping();
setTimeout(() => done(`\nStuck at stage "${stage}". If [1/3] passed but [2/3] did not, the tunnel blocks the larger join packets (classic playit free-tier MTU issue) — that is why ping works but join fails.`), 12000);
