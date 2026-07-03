// Platform-event recorder for the admin ops page. Supervisor loops and other
// automatic actions (idle-stop, auto-heal, auto-restart, swap rollback,
// auto-snapshots, janitor sweeps) log here so operators can see what the
// platform did without digging through Railway logs.
//
// Events reuse audit_log with user_id NULL and action "platform.<kind>" —
// same retention/query story as user actions, no new table.

const db = require("../db");

function record(kind, serverId, detail) {
  try {
    db.prepare(
      "INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip, metadata) VALUES (NULL, ?, 'server', ?, NULL, ?)",
    ).run(
      `platform.${kind}`,
      serverId || null,
      detail ? JSON.stringify(detail) : null,
    );
  } catch (err) {
    console.warn("[events] record failed:", err.message);
  }
}

// Recent platform events, newest first. Joined with the server name when the
// server still exists (deleted servers show just the id).
function recent(limit = 200) {
  return db
    .prepare(
      `SELECT a.id, a.action, a.resource_id AS server_id, s.name AS server_name,
              a.metadata, a.created_at
       FROM audit_log a LEFT JOIN servers s ON s.id = a.resource_id
       WHERE a.action LIKE 'platform.%'
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(Math.min(1000, Math.max(1, limit)))
    .map((r) => ({
      ...r,
      kind: r.action.replace(/^platform\./, ""),
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
    }));
}

module.exports = { record, recent };
