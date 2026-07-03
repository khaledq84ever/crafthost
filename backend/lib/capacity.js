// Platform-wide memory capacity guard. Per-user quotas stop one user hogging
// the box; this stops the SUM of everyone's servers exceeding what the
// container actually has — the failure mode otherwise is the kernel OOM-killing
// random JVMs (or node itself) and auto-heal fighting the fallout.
//
// Ceiling detection: CAPACITY_TOTAL_MB env override → cgroup v2 memory.max →
// cgroup v1 limit_in_bytes → os.totalmem(). On Railway the cgroup file is the
// real container limit; os.totalmem() would report the (huge) host.
const fs = require("fs");
const os = require("os");

const MAX_HEAP_MB = parseInt(process.env.MAX_HEAP_MB || "1024", 10);
// A JVM's RSS runs well past -Xmx (metaspace, threads, GC, mmap'd chunks).
const RSS_FACTOR = 1.7;
// Node + tunnels + sqlite + headroom.
const RESERVE_MB = parseInt(process.env.CAPACITY_RESERVE_MB || "1536", 10);

function containerMemMb() {
  const env = parseInt(process.env.CAPACITY_TOTAL_MB || "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const v2 = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (v2 && v2 !== "max") {
      const mb = Math.floor(parseInt(v2, 10) / 1024 / 1024);
      if (mb > 0) return mb;
    }
  } catch {}
  try {
    const v1 = parseInt(
      fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8"),
      10,
    );
    // v1 reports a huge sentinel when unlimited.
    if (v1 > 0 && v1 < 2 ** 60) return Math.floor(v1 / 1024 / 1024);
  } catch {}
  return Math.floor(os.totalmem() / 1024 / 1024);
}

function heapOf(row) {
  return Math.max(256, Math.min(parseInt(row.ram_mb || 512, 10), MAX_HEAP_MB));
}

// Estimated MB already committed to running/starting servers.
function committedMb(db) {
  const rows = db
    .prepare(
      `SELECT COALESCE(p.ram_mb, 512) AS ram_mb FROM servers s
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE s.status IN ('starting','online','running')
         AND s.container_id NOT LIKE 'stub-%'`,
    )
    .all();
  return Math.round(rows.reduce((sum, r) => sum + heapOf(r) * RSS_FACTOR, 0));
}

// null when the server fits; otherwise a payload for a 503. Refusing a start
// politely beats accepting it and letting the kernel kill someone's world.
function checkCapacity(db, nextServerRow) {
  const limit = containerMemMb();
  const committed = committedMb(db);
  const next = Math.round(heapOf(nextServerRow || {}) * RSS_FACTOR);
  if (committed + next + RESERVE_MB <= limit) return null;
  return {
    error:
      "The platform is at full capacity right now. Please try again in a few minutes — servers stop automatically when idle, which frees up room.",
    code: "capacity_full",
    committed_mb: committed,
    limit_mb: limit,
  };
}

function snapshot(db) {
  return { limit_mb: containerMemMb(), committed_mb: committedMb(db), reserve_mb: RESERVE_MB };
}

module.exports = { checkCapacity, snapshot };
