// Per-server exclusive-operation lock, shared across routes. A server with a
// jar swap, backup, or restore in flight must not accept another of these (or
// a start/restart) until it finishes — interleaved stop/wipe/extract/start
// sequences corrupt world state. Stop is intentionally NOT gated: it's the
// universal cancel and is token-safe in the JVM controller.
//
// Synchronous check-then-acquire is race-free on Node's single thread as long
// as callers don't await between has() and acquire().

const held = new Map(); // serverId → operation name ("swap" | "backup" | "restore")

function has(id) {
  return held.has(id);
}

function opName(id) {
  return held.get(id) || null;
}

// Returns true if acquired, false if something else holds the lock.
function acquire(id, op) {
  if (held.has(id)) return false;
  held.set(id, op);
  return true;
}

function release(id) {
  held.delete(id);
}

// Standard 409 payload so every route reports busy the same way.
function busyPayload(id) {
  const op = opName(id);
  const what =
    op === "backup"
      ? "A backup"
      : op === "restore"
        ? "A backup restore"
        : op === "import"
          ? "A world import"
          : "A version change";
  return {
    error: `${what} is in progress for this server. Wait for it to finish.`,
    code: "busy",
    op,
  };
}

module.exports = { has, opName, acquire, release, busyPayload };
