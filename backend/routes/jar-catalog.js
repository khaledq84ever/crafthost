// Public server-jar catalog — every engine, every version, direct download
// URLs. No auth: this serves people who just want jar files (the
// run-minecraft-server-cli repo, mc-local, curl users), not platform accounts.
//
//   GET /api/jars/catalog                     → all engines + versions + download links
//   GET /api/jars/catalog/:type               → one engine (?limit=)
//   GET /api/jars/catalog/:type/:version      → resolved direct URL + build info
//   GET /api/jars/catalog/:type/:version/download → 302 to the upstream jar
//
// "LATEST" works as a version. "spigot" aliases paper (same jar we deploy).
// Listings and resolutions cache 1h in memory — upstream APIs are only hit
// once per hour per key no matter how public this URL gets.

const express = require("express");
const jvm = require("../lib/jvm-controller");

const router = express.Router();

const UA = "CraftHost/1.0 (crafthost.up.railway.app)";
const TTL = 60 * 60 * 1000;
const cache = Object.create(null); // key → { ts, data }

async function cached(key, fn) {
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  const data = await fn();
  cache[key] = { ts: Date.now(), data };
  return data;
}

const RESOLVERS = {
  paper: jvm.paperJarUrl,
  vanilla: jvm.vanillaJarUrl,
  purpur: jvm.purpurJarUrl,
  fabric: jvm.fabricJarUrl,
  neoforge: jvm.neoforgeJarUrl,
};

const NOTES = {
  paper: "Paper server jar (Spigot-compatible, plugins)",
  vanilla: "Official Mojang server jar",
  purpur: "Purpur server jar (Paper fork, extra gameplay config)",
  fabric: "Fabric server launcher jar (mods)",
  neoforge:
    "NeoForge INSTALLER jar — run `java -jar` once to extract the server",
};

function engineOf(req) {
  const t = String(req.params.type || "").toLowerCase();
  return t === "spigot" ? "paper" : t;
}

// Same upstream listing calls as routes/versions.js, minus the UI trimming —
// the catalog's job is "ALL versions", the wizard's is "sane dropdown".
async function listVersions(type) {
  return cached(`list:${type}`, async () => {
    const get = async (url) => {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`${type} list: HTTP ${r.status}`);
      return r.json();
    };
    if (type === "vanilla") {
      const m = await get(
        process.env.MOJANG_MANIFEST ||
          "https://launchermeta.mojang.com/mc/game/version_manifest.json",
      );
      return m.versions.filter((v) => v.type === "release").map((v) => v.id);
    }
    if (type === "paper") {
      const m = await get(
        (process.env.PAPER_V3_API || "https://fill.papermc.io/v3") +
          "/projects/paper",
      );
      const groups = m.versions || {};
      return Object.keys(groups)
        .sort((a, b) => {
          const pa = a.split(".").map(Number),
            pb = b.split(".").map(Number);
          return pb[0] - pa[0] || (pb[1] || 0) - (pa[1] || 0);
        })
        .flatMap((k) => groups[k] || []);
    }
    if (type === "purpur") {
      const m = await get(
        (process.env.PURPUR_API || "https://api.purpurmc.org/v2") + "/purpur",
      );
      return [...(m.versions || [])].reverse();
    }
    if (type === "fabric") {
      const list = await get(
        (process.env.FABRIC_META || "https://meta.fabricmc.net/v2") +
          "/versions/game",
      );
      return list.filter((v) => v.stable).map((v) => v.version);
    }
    if (type === "neoforge") {
      const m = await get(
        "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
      );
      return [...(m.versions || [])].reverse();
    }
    throw new Error("unknown type");
  });
}

function baseUrl(req) {
  const proto = String(
    req.headers["x-forwarded-proto"] || req.protocol || "https",
  ).split(",")[0];
  return `${proto}://${req.get("host")}`;
}

function engineBlock(base, type, versions, limit) {
  const list = limit ? versions.slice(0, limit) : versions;
  return {
    type,
    note: NOTES[type],
    count: versions.length,
    latest: versions[0] || null,
    versions: list.map((v) => ({
      version: v,
      download: `${base}/api/jars/catalog/${type}/${encodeURIComponent(v)}/download`,
      info: `${base}/api/jars/catalog/${type}/${encodeURIComponent(v)}`,
    })),
  };
}

// GET /api/jars/catalog — everything
router.get("/", async (req, res) => {
  const base = baseUrl(req);
  const limit = req.query.limit
    ? Math.max(1, parseInt(req.query.limit, 10) || 0)
    : 0;
  const engines = {};
  const errors = {};
  await Promise.all(
    Object.keys(RESOLVERS).map(async (type) => {
      try {
        engines[type] = engineBlock(base, type, await listVersions(type), limit);
      } catch (err) {
        errors[type] = err.message;
      }
    }),
  );
  if (!Object.keys(engines).length)
    return res.status(502).json({ error: "all upstream listings failed", errors });
  res.json({
    ok: true,
    engines,
    ...(Object.keys(errors).length ? { errors } : {}),
    usage: `${base}/api/jars/catalog/<type>/<version|LATEST>/download  — types: paper (alias spigot), vanilla, purpur, fabric, neoforge`,
  });
});

// GET /api/jars/catalog/:type
router.get("/:type", async (req, res) => {
  const type = engineOf(req);
  if (!RESOLVERS[type]) return res.status(400).json({ error: "unknown type" });
  const limit = req.query.limit
    ? Math.max(1, parseInt(req.query.limit, 10) || 0)
    : 0;
  try {
    res.json({
      ok: true,
      ...engineBlock(baseUrl(req), type, await listVersions(type), limit),
    });
  } catch (err) {
    res.status(502).json({ error: `${type} listing failed` });
  }
});

async function resolve(type, version) {
  return cached(`resolve:${type}:${version}`, () => RESOLVERS[type](version));
}

// GET /api/jars/catalog/:type/:version — resolved direct URL + build metadata
router.get("/:type/:version", async (req, res) => {
  const type = engineOf(req);
  if (!RESOLVERS[type]) return res.status(400).json({ error: "unknown type" });
  try {
    const info = await resolve(type, req.params.version);
    res.json({
      ok: true,
      type,
      note: NOTES[type],
      ...info,
      download: `${baseUrl(req)}/api/jars/catalog/${type}/${encodeURIComponent(info.version)}/download`,
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /api/jars/catalog/:type/:version/download — 302 to the upstream jar
router.get("/:type/:version/download", async (req, res) => {
  const type = engineOf(req);
  if (!RESOLVERS[type]) return res.status(400).json({ error: "unknown type" });
  try {
    const info = await resolve(type, req.params.version);
    res.redirect(302, info.url);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
