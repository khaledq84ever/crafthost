// Minimal Source-RCON client (auth + one command per connection). Used for
// SILENT telemetry probes (/tps, /mspt): sendRcon() in jvm-controller writes
// to the JVM's stdin, which makes Paper print the command's output to the
// console — every user watching the live console would see the probe spam.
// RCON responses travel over the RCON socket instead and never touch stdout.
//
// Protocol: [int32 len][int32 id][int32 type][body\0][\0]
//   type 3 = auth request, 2 = auth response OR exec command,
//   0 = command response. Auth failure echoes id = -1.
const net = require("net");

function packet(id, type, body) {
  const b = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

function rconExec(port, password, command, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let buf = Buffer.alloc(0);
    let authed = false;
    let done = false;
    const finish = (err, out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {}
      err ? reject(err) : resolve(out);
    };
    const timer = setTimeout(() => finish(new Error("rcon timeout")), timeoutMs);
    sock.on("error", (e) => finish(e));
    sock.on("connect", () => sock.write(packet(1, 3, password)));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString("utf8", 12, Math.max(12, 4 + len - 2));
        buf = buf.subarray(4 + len);
        if (!authed) {
          if (type === 2) {
            if (id === -1) return finish(new Error("rcon auth failed"));
            authed = true;
            sock.write(packet(2, 2, command));
          }
        } else if (type === 0) {
          // Minecraft answers with a single response packet per command.
          return finish(null, body);
        }
      }
    });
  });
}

module.exports = { rconExec, packet };
