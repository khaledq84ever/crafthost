// Live version listings for each server type. 1-hour in-memory cache.
const express = require("express");
const router = express.Router();

const UA = "CraftHost/1.0 (crafthost.up.railway.app)";
const TTL = 60 * 60 * 1000;
const cache = Object.create(null); // key → { ts, data }

function cached(key, fn) {
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < TTL) return Promise.resolve(hit.data);
  return fn().then((data) => {
    cache[key] = { ts: Date.now(), data };
    return data;
  });
}

function clampLimit(req, def = 30, max = 200) {
  const n = parseInt(req.query.limit || def, 10);
  return Math.max(1, Math.min(max, isNaN(n) ? def : n));
}

router.get("/vanilla", async (req, res) => {
  try {
    const data = await cached("vanilla", async () => {
      const r = await fetch(
        process.env.MOJANG_MANIFEST ||
          "https://launchermeta.mojang.com/mc/game/version_manifest.json",
        { headers: { "User-Agent": UA } },
      );
      const m = await r.json();
      return m.versions
        .filter((v) => v.type === "release")
        .map((v) => ({
          id: v.id,
          type: "vanilla",
          released: v.releaseTime,
        }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) {
    res.status(500).json({ error: "vanilla fetch failed" });
  }
});

// Spigot deploys use the Paper jar (see the unified map below), but jars.html
// fetches path-style /api/versions/spigot — alias it so it doesn't 404.
router.get("/spigot", (req, res, next) => {
  req.url =
    "/paper" +
    (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  router.handle(req, res, next);
});

router.get("/paper", async (req, res) => {
  try {
    const data = await cached("paper", async () => {
      // PaperMC sunset api.papermc.io/v2 — its error object has no `versions`
      // array, which made this list silently empty (broken version pickers).
      // v3 ("fill") groups versions: { "26.2": ["26.2","26.2-rc-2"], ... }
      // with each group's array newest-first.
      const r = await fetch(
        (process.env.PAPER_V3_API || "https://fill.papermc.io/v3") +
          "/projects/paper",
        { headers: { "User-Agent": UA } },
      );
      if (!r.ok) throw new Error(`paper v3: HTTP ${r.status}`);
      const m = await r.json();
      const groups = m.versions || {};
      const groupKeys = Object.keys(groups).sort((a, b) => {
        const pa = a.split(".").map(Number),
          pb = b.split(".").map(Number);
        return pb[0] - pa[0] || (pb[1] || 0) - (pa[1] || 0);
      });
      // Newest first; hide rc/pre/snapshot builds — they OOM-bait free-plan
      // users and clutter the wizard dropdown.
      const list = groupKeys
        .flatMap((k) => groups[k] || [])
        .filter((v) => !/-(rc|pre|snapshot)/i.test(String(v)));
      if (!list.length) throw new Error("paper v3: empty version list");
      return list.map((v) => ({ id: v, type: "paper" }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) {
    res.status(500).json({ error: "paper fetch failed" });
  }
});

router.get("/purpur", async (req, res) => {
  try {
    const data = await cached("purpur", async () => {
      const r = await fetch("https://api.purpurmc.org/v2/purpur", {
        headers: { "User-Agent": UA },
      });
      const m = await r.json();
      const list = [...(m.versions || [])].reverse();
      return list.map((v) => ({ id: v, type: "purpur" }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) {
    res.status(500).json({ error: "purpur fetch failed" });
  }
});

router.get("/fabric", async (req, res) => {
  try {
    const data = await cached("fabric", async () => {
      const r = await fetch("https://meta.fabricmc.net/v2/versions/game", {
        headers: { "User-Agent": UA },
      });
      const list = await r.json();
      return list
        .filter((v) => v.stable)
        .map((v) => ({ id: v.version, type: "fabric" }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) {
    res.status(500).json({ error: "fabric fetch failed" });
  }
});

router.get("/neoforge", async (req, res) => {
  try {
    const data = await cached("neoforge", async () => {
      // NeoForge versions API
      const r = await fetch(
        "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
        { headers: { "User-Agent": UA } },
      );
      const m = await r.json();
      const list = (m.versions || []).reverse();
      return list.map((v) => ({ id: v, type: "neoforge" }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) {
    res.status(500).json({ error: "neoforge fetch failed" });
  }
});

// Unified passthrough: /api/versions?type=paper&limit=10
router.get("/", async (req, res) => {
  const type = (req.query.type || "paper").toLowerCase();
  const map = {
    paper: "/paper",
    vanilla: "/vanilla",
    purpur: "/purpur",
    fabric: "/fabric",
    neoforge: "/neoforge",
    spigot: "/paper" /* spigot uses Paper jar */,
  };
  const route = map[type];
  if (!route) return res.status(400).json({ error: "Unknown type" });
  // Redirect internally
  req.url =
    route + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  router.handle(req, res, () => {});
});

module.exports = router;
