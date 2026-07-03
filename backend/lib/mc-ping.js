// Minecraft Java "server list ping" (the thing the multiplayer screen does).
// Speaks just enough of the modern (1.7+) protocol to get the status JSON:
// handshake(next_state=1) → status request → status response.
//
// Used by the join monitor to answer the only question that matters to a
// player: "if I typed this address into Minecraft, would it connect?"
// A TCP connect alone is NOT enough — a dead tunnel or wedged JVM can still
// accept sockets. Getting the status JSON back proves MC handled the request.
const net = require("net");

function varint(n) {
  const bytes = [];
  while (true) {
    if ((n & ~0x7f) === 0) {
      bytes.push(n);
      return Buffer.from(bytes);
    }
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
}

function packet(id, payload) {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
}

function mcString(s) {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([varint(b.length), b]);
}

// Read one varint out of buf at offset; returns [value, bytesRead] or null if
// more data is needed.
function readVarint(buf, off) {
  let val = 0,
    n = 0;
  while (true) {
    if (off + n >= buf.length) return null;
    const b = buf[off + n];
    val |= (b & 0x7f) << (7 * n);
    n++;
    if ((b & 0x80) === 0) return [val, n];
    if (n > 5) throw new Error("varint too long");
  }
}

/**
 * Ping a Java server. Resolves { ok: true, latencyMs, version, players } or
 * { ok: false, error }. Never rejects.
 */
function ping(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(out);
    };
    const sock = net.connect({ host, port: Number(port), timeout: timeoutMs });
    sock.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    sock.on("error", (err) => finish({ ok: false, error: err.code || err.message }));
    sock.on("connect", () => {
      const handshake = packet(
        0x00,
        Buffer.concat([
          varint(-1 >>> 0), // protocol version: -1 = "just asking"
          mcString(host),
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          varint(1), // next state: status
        ]),
      );
      sock.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]));
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len) return;
        if (buf.length < len[1] + len[0]) return; // whole packet not here yet
        let off = len[1];
        const pid = readVarint(buf, off);
        off += pid[1];
        const strLen = readVarint(buf, off);
        off += strLen[1];
        const json = JSON.parse(buf.slice(off, off + strLen[0]).toString("utf8"));
        finish({
          ok: true,
          latencyMs: Date.now() - t0,
          version: json.version?.name,
          players: json.players ? { online: json.players.online, max: json.players.max } : null,
        });
      } catch (err) {
        finish({ ok: false, error: "bad response: " + err.message });
      }
    });
  });
}

module.exports = { ping };
