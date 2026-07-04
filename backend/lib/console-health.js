// Console health monitor — continuously READS every running server's console
// output (the jvm-controller log ring) and turns raw log noise into health
// signal. The crash-path auto-fix (auto-fix.js) only sees servers that already
// died; this module watches servers that are still ONLINE and catches:
//
//   • runtime errors    — ERROR]/SEVERE] lines, uncaught Java exceptions
//   • plugin task crashes — "Task #N for <plugin> vX generated an exception"
//   • tick lag          — "Can't keep up! ... Running Nms behind"
//   • watchdog stalls   — Paper watchdog "single server tick took" dumps
//
// Findings feed two places:
//   1. events.record("console_errors"|"server_lagging", ...) — visible in the
//      per-server Details events feed and admin ops (cooldown-limited).
//   2. summary(cid) — a rolling 10-minute counter the /health-check endpoint
//      turns into warn issues for the Health modal.
//
// Scanning is incremental: a per-server cursor remembers the last ring line
// seen, so each sweep only inspects NEW output. No fixes are applied here —
// a running server is never restarted by this module (too aggressive); it
// observes and reports, and the existing heal/fix/restart loops act on death.

const events = require("./events");

const WINDOW_MS = 10 * 60 * 1000; // rolling window for counters
const EVENT_COOLDOWN_MS = 30 * 60 * 1000; // per server per kind
const ERROR_EVENT_THRESHOLD = 5; // errors in window → console_errors event
const LAG_EVENT_THRESHOLD = 3; // lag strikes in window → server_lagging event
const MAX_NEW_LINES = 400; // cap per sweep so a log flood can't stall the loop

// Runtime-issue patterns. Order matters: first match wins per line.
// Noise (player movement warnings, chat, join spam) is excluded first.
const NOISE_RE =
  /moved too quickly|moved wrongly|Keeping entity|logged in with entity|lost connection|Disconnecting|UUID of added entity/i;
const MATCHERS = [
  {
    kind: "lag",
    re: /Can't keep up!.*Running \d+ms|Running \d+ms or \d+ ticks behind/i,
  },
  {
    kind: "lag", // Paper watchdog — a single tick stalled long enough to dump threads
    re: /A single server tick took|--- DO NOT REPORT THIS TO (?:PAPER|PURPUR)/i,
  },
  {
    kind: "plugin_task",
    re: /Task #\d+ for ([\w.\-]+) v[\d.]+ generated an exception/i,
  },
  {
    kind: "error",
    re: /\b(?:ERROR|SEVERE|FATAL)\]|\[STDERR\]|(?:^|[\s:])(?:java|io|net|org|com)\.[\w.$]+(?:Exception|Error)\b/,
  },
];

// cid → { lastLine, lastIdx, hits: [{ts, kind, line}], lastEventAt: {kind: ts} }
const state = new Map();

function classify(line) {
  if (NOISE_RE.test(line)) return null;
  for (const m of MATCHERS) {
    const match = line.match(m.re);
    if (match) return { kind: m.kind, plugin: match[1] || null };
  }
  return null;
}

// Lines the cursor hasn't seen yet. The ring shifts, so locate the remembered
// line near its remembered index; if it rolled out entirely, take a bounded
// tail and accept the (rare) chance of recounting a line.
function newLinesSince(logs, cur) {
  if (!cur.lastLine) return []; // first sweep: baseline only, scan nothing
  const len = logs.length;
  let idx = -1;
  const start = Math.min(cur.lastIdx, len - 1);
  for (let i = start; i >= 0; i--) {
    if (logs[i] === cur.lastLine) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    for (let i = Math.max(0, start + 1); i < len; i++) {
      if (logs[i] === cur.lastLine) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) return logs.slice(-MAX_NEW_LINES); // ring rolled past us
  return logs.slice(idx + 1, idx + 1 + MAX_NEW_LINES);
}

// One pass over every running server. `jvm` is passed in (not required at top)
// so tests can hand a stub. Returns per-server hit counts for logging.
function sweep(jvm) {
  const now = Date.now();
  const seen = new Set();
  const results = [];
  for (const r of jvm.listRunning()) {
    seen.add(r.id);
    const st = jvm.__getState(r.id);
    const logs = st?.logs;
    if (!Array.isArray(logs) || logs.length === 0) continue;

    let cur = state.get(r.id);
    if (!cur) {
      cur = { lastLine: null, lastIdx: 0, hits: [], lastEventAt: {} };
      state.set(r.id, cur);
    }
    const fresh = newLinesSince(logs, cur);
    cur.lastLine = logs[logs.length - 1];
    cur.lastIdx = logs.length - 1;

    let added = 0;
    for (const line of fresh) {
      const c = classify(line);
      if (!c) continue;
      cur.hits.push({ ts: now, kind: c.kind, line: line.slice(0, 300) });
      added++;
    }
    // Prune the rolling window.
    cur.hits = cur.hits.filter((h) => now - h.ts < WINDOW_MS);

    maybeRecordEvents(r.id, cur, now);
    if (added) results.push({ id: r.id, added });
  }
  // Drop state for servers that stopped — their next boot starts clean.
  for (const id of state.keys()) if (!seen.has(id)) state.delete(id);
  return results;
}

function counts(cur) {
  let errors = 0,
    lag = 0;
  let lastError = null;
  for (const h of cur.hits) {
    if (h.kind === "lag") lag++;
    else {
      errors++;
      lastError = h.line;
    }
  }
  return { errors, lag, lastError };
}

function maybeRecordEvents(id, cur, now) {
  const { errors, lag, lastError } = counts(cur);
  if (
    errors >= ERROR_EVENT_THRESHOLD &&
    now - (cur.lastEventAt.errors || 0) > EVENT_COOLDOWN_MS
  ) {
    cur.lastEventAt.errors = now;
    events.record("console_errors", id, {
      count: errors,
      window_min: WINDOW_MS / 60000,
      sample: lastError,
    });
  }
  if (
    lag >= LAG_EVENT_THRESHOLD &&
    now - (cur.lastEventAt.lag || 0) > EVENT_COOLDOWN_MS
  ) {
    cur.lastEventAt.lag = now;
    events.record("server_lagging", id, {
      strikes: lag,
      window_min: WINDOW_MS / 60000,
    });
  }
}

// Rolling-window summary for the health-check endpoint. Null when the server
// isn't being tracked (not running, or first sweep hasn't happened yet).
function summary(cid) {
  const cur = state.get(cid);
  if (!cur) return null;
  const { errors, lag, lastError } = counts(cur);
  return { errors, lag, lastError, window_min: WINDOW_MS / 60000 };
}

module.exports = {
  sweep,
  summary,
  classify, // exported for tests
  ERROR_EVENT_THRESHOLD,
  LAG_EVENT_THRESHOLD,
};
