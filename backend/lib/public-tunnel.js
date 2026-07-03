// Public Java tunnel chooser. Prefers playit (stable *.joinmc.link addresses,
// served by our singleton agent) when a shared playit secret is configured AND
// PLAYIT_JAVA=1; otherwise falls back to bore.pub. Either way it writes the
// server's public Java address to servers.tunnel_host/tunnel_port, so the rest
// of the app (dashboard, progress, diagnostics) is unchanged.
//
// Gated behind PLAYIT_JAVA so the switch can be verified before flipping it on
// for all servers — with the flag off this is exactly the old bore.pub behavior.

const bore = require("./tunnel");
const playit = require("./playit");
const db = require("../db");

const PLAYIT_JAVA = () => process.env.PLAYIT_JAVA === "1";

// Inline playit-java attempts before falling back to bore. Kept small so server
// start isn't blocked waiting on playit's (often slow) java-address allocation —
// bore comes up immediately and schedulePlayitUpgrade does the patient retry.
const QUICK_JAVA_ATTEMPTS = 3; // ~4.5s max (3 × 1500ms)

// Resolve the shared playit secret the same way routes/servers.js does:
// env var first, else the value captured into app_settings.
function sharedSecret() {
  if (process.env.PLAYIT_SHARED_SECRET) return process.env.PLAYIT_SHARED_SECRET;
  try {
    const row = db
      .prepare(
        "SELECT value FROM app_settings WHERE key = 'playit_shared_secret'",
      )
      .get();
    return row && row.value ? row.value : null;
  } catch {
    return null;
  }
}

function isAvailable() {
  return bore.isAvailable() || playit.isAvailable();
}

// Open the public Java tunnel for a server. Returns { host, port } or null.
async function start(serverId, localPort) {
  if (PLAYIT_JAVA() && playit.isAvailable()) {
    const secret = sharedSecret();
    if (secret) {
      try {
        const addr = await playit.startJava(
          serverId,
          localPort,
          secret,
          QUICK_JAVA_ATTEMPTS,
        );
        if (addr && addr.host && addr.port) {
          try {
            db.prepare(
              "UPDATE servers SET tunnel_host = ?, tunnel_port = ? WHERE id = ?",
            ).run(addr.host, addr.port, serverId);
          } catch (e) {
            console.warn("[pubtun] db update:", e.message);
          }
          return addr;
        }
        // Expected: playit's java address usually isn't ready this fast. Use bore
        // now; the background upgrade swaps to playit once it allocates.
        console.log(
          `[pubtun] ${serverId}: playit-java not ready — using bore, will upgrade in background`,
        );
        schedulePlayitUpgrade(serverId, localPort, secret);
      } catch (e) {
        console.warn(
          "[pubtun] playit-java failed, falling back to bore:",
          e.message,
        );
        schedulePlayitUpgrade(serverId, localPort, secret);
      }
    }
  }
  // Fallback (or flag off): bore.pub. bore.start writes tunnel_host/tunnel_port.
  return bore.start(serverId, localPort);
}

// After a bore fallback, keep trying playit in the background. playit's address
// allocation often finishes a little after the inline wait gives up; once it's
// ready we swap the server's public address to the stable playit one and tear
// down the now-redundant bore process. Guarded so only one upgrade runs per
// server at a time.
const _upgrading = new Set();
function schedulePlayitUpgrade(serverId, localPort, secret) {
  if (_upgrading.has(serverId)) return;
  _upgrading.add(serverId);
  // A fresh playit java tunnel gets its address assigned anywhere between
  // seconds and a few minutes. The old single attempt at t+8s missed that
  // window almost every time, leaving servers on bore.pub (random port each
  // boot — the #1 address complaint). Retry with backoff until the address
  // lands, the server stops, or ~10 minutes pass.
  const DELAYS_MS = [8000, 20000, 40000, 80000, 160000, 300000];
  (async () => {
    try {
      for (const delay of DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        let row = null;
        try {
          row = db
            .prepare("SELECT status, tunnel_host FROM servers WHERE id = ?")
            .get(serverId);
        } catch {}
        if (!row || !/^(online|running|starting)$/.test(row.status || "")) {
          return; // server stopped or deleted meanwhile — nothing to upgrade
        }
        if (/joinmc\.link$/.test(row.tunnel_host || "")) return; // already playit
        try {
          const addr = await playit.startJava(serverId, localPort, secret);
          if (addr && addr.host && addr.port) {
            // Stop bore FIRST — bore.stop() nulls tunnel_host/port — then write
            // the playit address, so the swap doesn't clobber the new address.
            try {
              bore.stop(serverId);
            } catch {}
            try {
              db.prepare(
                "UPDATE servers SET tunnel_host = ?, tunnel_port = ? WHERE id = ?",
              ).run(addr.host, addr.port, serverId);
            } catch (e) {
              console.warn("[pubtun] upgrade db update:", e.message);
            }
            console.log(
              `[pubtun] ${serverId}: upgraded bore → playit @ ${addr.host}:${addr.port}`,
            );
            return;
          }
        } catch (e) {
          console.warn(
            `[pubtun] ${serverId}: playit upgrade attempt failed:`,
            e.message,
          );
        }
      }
      console.warn(
        `[pubtun] ${serverId}: playit never assigned an address (~10min of retries) — staying on bore`,
      );
    } finally {
      _upgrading.delete(serverId);
    }
  })();
}

// Close the public Java tunnel. Stops the bore process (if any), drops the
// cached playit address, and clears the DB address. We clear the DB explicitly
// because bore.stop early-returns without clearing when there was no bore
// process (i.e. when playit served the tunnel instead).
function stop(serverId) {
  try {
    bore.stop(serverId);
  } catch {}
  try {
    playit.stopJava(serverId);
  } catch {}
  try {
    db.prepare(
      "UPDATE servers SET tunnel_host = NULL, tunnel_port = NULL WHERE id = ?",
    ).run(serverId);
  } catch {}
}

module.exports = { start, stop, isAvailable, sharedSecret };
