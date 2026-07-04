// Tests backend/lib/rcon-client.js against a mock Source-RCON server, plus
// the tps/mspt parsers used by jvm-controller's getCachedTick.
// Run: node scripts/test-rcon-tick.mjs
import { createRequire } from "module";
import net from "net";

const require = createRequire(import.meta.url);
const { rconExec, packet } = require("../backend/lib/rcon-client.js");

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + extra}`);
  if (!ok) failed++;
};

// Mock RCON server speaking the real protocol (auth then one command).
const PASSWORD = "s3cret";
const RESPONSES = {
  tps: "§6TPS from last 1m, 5m, 15m: §a*20.0, §a19.98, §a19.9",
  mspt: "§6Server tick times §e(§7avg§e/§7min§e/§7max§e)§6 from last 5s, 10s, 1m:\n§6◴ §a3.2/2.1/8.7§6, §a3.4/2.0/9.9§6, §a3.1/1.9/12.3",
};
const srv = net.createServer((sock) => {
  let authed = false;
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readInt32LE(0);
      if (buf.length < 4 + len) break;
      const id = buf.readInt32LE(4);
      const type = buf.readInt32LE(8);
      const body = buf.toString("utf8", 12, 4 + len - 2);
      buf = buf.subarray(4 + len);
      if (type === 3) {
        authed = body === PASSWORD;
        sock.write(packet(authed ? id : -1, 2, ""));
      } else if (type === 2 && authed) {
        sock.write(packet(id, 0, RESPONSES[body] ?? "Unknown command"));
      }
    }
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;

console.log("[1] rcon protocol");
const tpsRaw = await rconExec(PORT, PASSWORD, "tps");
check("tps command answered", /TPS from last/.test(tpsRaw), tpsRaw);
const msptRaw = await rconExec(PORT, PASSWORD, "mspt");
check("mspt command answered", /tick times/.test(msptRaw), msptRaw);
const bad = await rconExec(PORT, "wrong", "tps").catch((e) => e.message);
check("wrong password rejected", bad === "rcon auth failed", String(bad));
const dead = await rconExec(1, PASSWORD, "tps", 800).catch((e) => e.message);
check("dead port errors (not hangs)", typeof dead === "string" && dead.length > 0, String(dead));

console.log("[2] parsers (same regexes as getCachedTick)");
const strip = (s) => String(s || "").replace(/§./g, "");
const tpsM = strip(tpsRaw).match(/:\s*\*?([\d.]+)/);
check("tps parsed = 20.0 (not the '1' from '1m')", tpsM && parseFloat(tpsM[1]) === 20.0, JSON.stringify(tpsM));
const msptM = strip(msptRaw).match(/([\d.]+)\/[\d.]+\/[\d.]+/);
check("mspt parsed = 3.2 (5s avg)", msptM && parseFloat(msptM[1]) === 3.2, JSON.stringify(msptM));
const vanilla = strip("Unknown command").match(/:\s*\*?([\d.]+)/);
check("unknown command → null (fallback estimate)", vanilla === null);

srv.close();
console.log(failed ? `\n✗ ${failed} FAILED` : "\n✅ ALL PASS");
process.exit(failed ? 1 : 0);
