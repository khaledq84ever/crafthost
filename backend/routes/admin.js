// Admin-only ops API — powers /admin.html. Shows what the platform's
// automation did (idle-stops, auto-heals, auto-restarts, swap rollbacks,
// auto-backups, janitor sweeps) plus a live fleet summary, so operators
// don't have to tail Railway logs to know the platform's health.

const express = require("express");
const db = require("../db");
const { authMiddleware, adminOnly } = require("../lib/auth");
const events = require("../lib/events");
const dc = require("../lib/controller");

const router = express.Router();
router.use(authMiddleware, adminOnly);

// GET /api/admin/ops?limit=200&kind=idle_stop
router.get("/ops", async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit || "200", 10) || 200);
    let list = events.recent(limit);
    if (req.query.kind)
      list = list.filter((e) => e.kind === String(req.query.kind));

    const servers = db
      .prepare(
        `SELECT id, name, type, version, status, user_id,
                auto_restart_count, last_auto_restart_at, auto_healed_at, last_idle_stop_at
         FROM servers ORDER BY status IN ('online','running','starting') DESC, name`,
      )
      .all();
    const running = servers.filter((s) =>
      ["online", "running", "starting"].includes(s.status),
    );

    res.json({
      events: list,
      fleet: {
        total: servers.length,
        running: running.length,
        running_list: running.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          version: s.version,
          status: s.status,
        })),
        users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
      },
      config: {
        backend: await dc.backendName?.().catch?.(() => null) ?? null,
        idle_stop_minutes: parseInt(process.env.IDLE_STOP_MINUTES || "10", 10),
        max_running_per_user: parseInt(
          process.env.MAX_RUNNING_PER_USER || "1",
          10,
        ),
        auto_restart_max: parseInt(process.env.AUTO_RESTART_MAX || "5", 10),
        backups_per_server: parseInt(
          process.env.BACKUPS_PER_SERVER || "10",
          10,
        ),
        bedrock_per_server: process.env.BEDROCK_PER_SERVER === "1",
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "ops fetch failed" });
  }
});

module.exports = router;
