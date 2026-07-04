// Unit test for backend/lib/console-health.js — the running-server console
// reader. Uses a stub jvm controller + scratch SQLite DB (events.record
// writes audit_log rows). Run: node scripts/test-console-health.mjs
import { createRequire } from "module";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const scratch = mkdtempSync(path.join(tmpdir(), "ch-consolehealth-"));
process.env.DATABASE_PATH = path.join(scratch, "test.db");
process.env.DATA_DIR = path.join(scratch, "servers");

const require = createRequire(import.meta.url);
const db = require("../backend/db");
const ch = require("../backend/lib/console-health");

let failed = 0;
function check(name, ok, extra = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + extra}`);
  if (!ok) failed++;
}

// ── classify ─────────────────────────────────────────────────────────────────
console.log("[1] classify()");
check(
  "lag line",
  ch.classify(
    "[12:00:01 WARN]: Can't keep up! Is the server overloaded? Running 2543ms or 50 ticks behind",
  )?.kind === "lag",
);
check(
  "watchdog dump = lag",
  ch.classify("[12:00:02 ERROR]: A single server tick took 60.00 seconds")
    ?.kind === "lag",
);
const pt = ch.classify(
  "[12:00:03 WARN]: [Essentials] Task #312 for Essentials v2.20.1 generated an exception",
);
check("plugin task crash + name", pt?.kind === "plugin_task" && pt.plugin === "Essentials");
check(
  "ERROR] line",
  ch.classify("[12:00:04 ERROR]: Could not pass event PlayerJoinEvent to Foo")
    ?.kind === "error",
);
check(
  "bare java exception",
  ch.classify("java.lang.NullPointerException: Cannot invoke method")?.kind ===
    "error",
);
check(
  "noise ignored (moved too quickly)",
  ch.classify("[12:00:05 WARN]: Player123 moved too quickly! -12.3,4.5") === null,
);
check(
  "plain INFO ignored",
  ch.classify("[12:00:06 INFO]: Loaded 7 recipes") === null,
);

// ── sweep + cursor + summary + events ────────────────────────────────────────
console.log("[2] sweep() incremental cursor");
const logs = ["[12:00:00 INFO]: Done (5.0s)! For help, type \"help\""];
const stubJvm = {
  listRunning: () => [{ id: "srv1" }],
  __getState: (id) => (id === "srv1" ? { logs } : null),
};

let r = ch.sweep(stubJvm);
check("first sweep baselines, counts nothing", r.length === 0);
check("summary exists after baseline", ch.summary("srv1")?.errors === 0);

for (let i = 0; i < 6; i++)
  logs.push(`[12:01:0${i} ERROR]: Could not pass event Tick to BadPlugin #${i}`);
logs.push("[12:01:07 WARN]: Can't keep up! Is the server overloaded? Running 3000ms or 60 ticks behind");
r = ch.sweep(stubJvm);
check("second sweep sees 7 new issue lines", r[0]?.added === 7, JSON.stringify(r));
let s = ch.summary("srv1");
check("summary: 6 errors", s.errors === 6, JSON.stringify(s));
check("summary: 1 lag", s.lag === 1);
check("summary keeps last error sample", /BadPlugin #5/.test(s.lastError || ""));

r = ch.sweep(stubJvm);
check("third sweep (no new lines) adds nothing", r.length === 0);
s = ch.summary("srv1");
check("counters not double-counted", s.errors === 6, JSON.stringify(s));

console.log("[3] events recorded at threshold");
const rows = db
  .prepare(
    "SELECT action FROM audit_log WHERE action LIKE 'platform.console%' OR action LIKE 'platform.server_lag%'",
  )
  .all();
check(
  "console_errors event recorded (6 ≥ threshold 5)",
  rows.some((x) => x.action === "platform.console_errors"),
  JSON.stringify(rows),
);
check(
  "server_lagging NOT recorded (1 < threshold 3)",
  !rows.some((x) => x.action === "platform.server_lagging"),
);

console.log("[4] ring-shift resilience + state cleanup");
// Simulate the ring shifting: drop the first 3 lines (cursor line survives).
logs.splice(0, 3);
logs.push("[12:02:00 ERROR]: one more java.io.IOException: boom");
r = ch.sweep(stubJvm);
check("after ring shift, only the 1 new line counted", r[0]?.added === 1, JSON.stringify(r));

const emptyJvm = { listRunning: () => [], __getState: () => null };
ch.sweep(emptyJvm);
check("stopped server state dropped", ch.summary("srv1") === null);

console.log(failed ? `\n✗ ${failed} check(s) FAILED` : "\n✅ ALL PASS");
process.exit(failed ? 1 : 0);
