// Public one-click launcher endpoints — consumed by the downloadable
// start-<server>.bat (GET /api/servers/:id/launcher.bat in routes/servers.js).
// Auth is the long random per-server launcher_token itself: it can only
// start/inspect its one server, so no login session is needed on the PC that
// double-clicks the file. Responses are single-line text/plain because the
// consumer is a Windows batch script, not a browser.
const express = require("express");
const db = require("../db");
const dc = require("../lib/controller");
const pubtun = require("../lib/public-tunnel");
const playit = require("../lib/playit");
const capacity = require("../lib/capacity");
const oplock = require("../lib/oplock");
const servers = require("./servers");

const router = express.Router();

function byToken(req) {
  const token = String(req.params.token || "");
  if (token.length < 32) return null;
  return (
    db.prepare("SELECT * FROM servers WHERE launcher_token = ?").get(token) ||
    null
  );
}

router.post("/:token/start", async (req, res) => {
  res.type("text/plain");
  const s = byToken(req);
  if (!s)
    return res
      .status(404)
      .send("ERROR unknown launcher - re-download the .bat from your dashboard");
  if (s.status === "online" || s.status === "starting")
    return res.send(`OK already ${s.status}`);
  if (oplock.has(s.id))
    return res
      .status(409)
      .send("ERROR server is busy (backup/restore in progress) - try again in a minute");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(s.user_id);
  const quotaErr = servers.checkRunningQuota(s, user);
  if (quotaErr) return res.status(409).send(`ERROR ${quotaErr.message}`);
  const capErr = capacity.checkCapacity(db, s);
  if (capErr)
    return res
      .status(503)
      .send(`ERROR ${capErr.error || "platform is full right now - try again soon"}`);
  try {
    const r = await dc.startServer(s);
    if (r?.status === "cancelled") return res.send("OK cancelled");
    if (r.containerId && r.containerId !== s.container_id)
      db.prepare("UPDATE servers SET container_id = ? WHERE id = ?").run(
        r.containerId,
        s.id,
      );
    db.prepare("UPDATE servers SET status = ? WHERE id = ?").run(
      "starting",
      s.id,
    );
    servers.audit(s.user_id, "server.start.launcher", s.id, req.ip);
    if (pubtun.isAvailable())
      pubtun
        .start(s.id, servers.internalListenPort(s))
        .catch((err) => console.warn("[launcher] tunnel:", err.message));
    if (s.playit_secret && playit.isAvailable())
      playit
        .start(s.id, servers.bedrockLocalPort(s), s.playit_secret)
        .catch((err) => console.warn("[launcher] playit:", err.message));
    res.send("OK starting");
  } catch (err) {
    res.status(500).send(`ERROR ${err.message || "start failed"}`);
  }
});

// "<status> <host:port>" — address only once the public tunnel is up, so the
// .bat keeps polling until players actually have something to paste.
router.get("/:token/status", (req, res) => {
  res.type("text/plain");
  const s = byToken(req);
  if (!s) return res.status(404).send("ERROR unknown launcher");
  const addr =
    s.tunnel_host && s.tunnel_port ? `${s.tunnel_host}:${s.tunnel_port}` : "";
  res.send(`${s.status || "offline"} ${addr}`.trim());
});

module.exports = router;
