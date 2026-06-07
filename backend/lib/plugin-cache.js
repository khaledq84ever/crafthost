// Plugin JAR cache — mirrors the server-JAR cache pattern in jvm-controller.js.
// Modrinth fetches add 2-8 seconds per plugin to server creation; this prewarms
// the popular starter plugins at startup so seedDefaultPlugins copies from a
// local cache file instead of downloading from cdn.modrinth.com.
//
// Per-MC-version pinning: each plugin is cached PER game version because some
// plugins (squaremap, WorldEdit) ship per-MC-version builds. A 1.20.1 server
// needs a different JAR than a 26.1.2 server. Cache layout:
//   /data/.plugin-cache/<project_id>__<mc_version>.jar   (e.g. Vebnzrzj__1.20.1.jar)
//   /data/.plugin-cache/<project_id>__any.jar            (fallback / universal builds)
//   /data/.plugin-cache/_index.json                      ({ "<pid>__<mcVer>": meta })
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, "../../data/servers");
const CACHE_DIR = path.join(path.dirname(DATA_DIR), ".plugin-cache");
const INDEX_FILE = path.join(CACHE_DIR, "_index.json");
const MODRINTH = process.env.MODRINTH_API || "https://api.modrinth.com/v2";
const UA = "CraftHost/1.0 (crafthost.up.railway.app)";
// Cap every Modrinth/Geyser request so a stalled fetch can't hang prewarm/deploy.
const FETCH_TIMEOUT_MS = parseInt(
  process.env.PLUGIN_FETCH_TIMEOUT_MS || "120000",
  10,
);

// Must mirror STARTER_PLUGINS in frontend/js/wizard.js. Adding a plugin here
// pre-caches it so the FIRST user to enable it gets an instant copy.
const STARTER_PLUGIN_IDS = [
  "Vebnzrzj", // LuckPerms
  "hXiIvTyT", // EssentialsX
  "1u6JkXh5", // WorldEdit
  "P1OZGk5p", // ViaVersion
  "Lu3KuzdV", // CoreProtect
  "squaremap",
  "wKkoqHrH", // GeyserMC — Bedrock cross-play bridge
  "bWrNNfkb", // Floodgate — companion to Geyser
];

// MC versions worth prewarming (one cache slot per plugin × version). Mirrors
// the most popular wizard picks. Cache cost: 8 plugins × 3 versions ≈ 150 MB.
const PREWARM_MC_VERSIONS = ["1.20.1", "1.21.1", "26.1.2"];

function safeKey(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function cachePath(projectId, mcVersion) {
  const pid = String(projectId).replace(/[^a-zA-Z0-9_-]/g, "");
  const ver = mcVersion ? safeKey(mcVersion) : "any";
  return path.join(CACHE_DIR, `${pid}__${ver}.jar`);
}

function indexKey(projectId, mcVersion) {
  return `${projectId}__${mcVersion ? safeKey(mcVersion) : "any"}`;
}

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveIndex(idx) {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
  } catch {}
}

// One-time migration: rename legacy single-version cache files
// (Vebnzrzj.jar) to the new __any.jar shape so existing cache entries keep
// serving as fallbacks while the per-version slots populate.
function migrateLegacyCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const idx = loadIndex();
    let migrated = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith(".jar")) continue;
      if (f.includes("__")) continue; // already new-shape
      const pid = f.replace(/\.jar$/, "");
      const oldPath = path.join(CACHE_DIR, f);
      const newPath = path.join(CACHE_DIR, `${pid}__any.jar`);
      try {
        fs.renameSync(oldPath, newPath);
        if (idx[pid]) {
          idx[indexKey(pid, null)] = idx[pid];
          delete idx[pid];
        }
        migrated++;
      } catch {}
    }
    if (migrated > 0) {
      saveIndex(idx);
      console.log(
        `[plugin-cache] migrated ${migrated} legacy cache entries → __any.jar`,
      );
    }
  } catch (err) {
    console.warn("[plugin-cache] migration failed:", err.message);
  }
}

// Some plugins don't publish Paper/Spigot/Bukkit builds to Modrinth — they're
// only on the upstream project's own download server. The resolver here
// returns the same { version_id, filename, url } shape as the Modrinth path.
// CUSTOM_RESOLVERS receive mcVersion but most return a universal JAR (Floodgate
// ships one Spigot JAR per Geyser release that covers all supported MC versions).
const CUSTOM_RESOLVERS = {
  bWrNNfkb: async (_mcVersion) => {
    const GEYSER = "https://download.geysermc.org/v2/projects/floodgate";
    const pr = await fetch(GEYSER, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!pr.ok) throw new Error(`geysermc project: HTTP ${pr.status}`);
    const proj = await pr.json();
    const latestVer = proj.versions[proj.versions.length - 1];
    const br = await fetch(`${GEYSER}/versions/${latestVer}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!br.ok)
      throw new Error(`geysermc version ${latestVer}: HTTP ${br.status}`);
    const ver = await br.json();
    const latestBuild = ver.builds[ver.builds.length - 1];
    return {
      version_id: `${latestVer}-b${latestBuild}`,
      version_number: latestVer,
      filename: `floodgate-spigot-${latestVer}-b${latestBuild}.jar`,
      url: `${GEYSER}/versions/${latestVer}/builds/${latestBuild}/downloads/spigot`,
      sha512: null,
    };
  },
};

// Resolve the latest paper/spigot/bukkit-compatible version for a plugin AT a
// specific MC version. If mcVersion is null/undefined, picks the latest
// universal build. Falls back to the latest unfiltered version if no
// MC-specific match exists (e.g. for forward-compat plugins like LuckPerms
// where one JAR works across many MC versions).
async function resolveLatestVersion(projectId, mcVersion) {
  if (CUSTOM_RESOLVERS[projectId])
    return CUSTOM_RESOLVERS[projectId](mcVersion);
  const loaders = encodeURIComponent('["paper","spigot","bukkit"]');
  // Step 1: try filtered by (loaders, game_version) — strictest match
  const tryFetch = async (url) => {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  };
  let versions = [];
  if (mcVersion) {
    const gv = encodeURIComponent(JSON.stringify([mcVersion]));
    versions = await tryFetch(
      `${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${loaders}&game_versions=${gv}`,
    );
  }
  // Step 2: loaders only (covers forward-compat plugins that don't list every minor MC ver)
  if (!versions.length) {
    versions = await tryFetch(
      `${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${loaders}`,
    );
    // If we have a mcVersion, prefer entries that LIST it in game_versions
    if (mcVersion && versions.length) {
      const match = versions.find(
        (v) =>
          Array.isArray(v.game_versions) && v.game_versions.includes(mcVersion),
      );
      if (match) versions = [match, ...versions.filter((v) => v !== match)];
    }
  }
  // Step 3: unfiltered fallback
  if (!versions.length) {
    versions = await tryFetch(
      `${MODRINTH}/project/${encodeURIComponent(projectId)}/version`,
    );
  }
  const v = versions[0];
  const file = v?.files?.find((f) => f.primary) || v?.files?.[0];
  if (!file?.url)
    throw new Error(
      `no compatible file for ${projectId} mc=${mcVersion || "any"}`,
    );
  return {
    version_id: v.id,
    version_number: v.version_number,
    filename: file.filename,
    url: file.url,
    sha512: file.hashes?.sha512,
  };
}

async function downloadOne(projectId, mcVersion, idx) {
  const meta = await resolveLatestVersion(projectId, mcVersion);
  const dl = await fetch(meta.url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!dl.ok) throw new Error(`HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.writeFile(cachePath(projectId, mcVersion), buf);
  idx[indexKey(projectId, mcVersion)] = {
    project_id: projectId,
    mc_version: mcVersion || "any",
    filename: meta.filename,
    version_id: meta.version_id,
    version_number: meta.version_number,
    sha512: meta.sha512,
    size: buf.length,
    mtime: Date.now(),
  };
  return buf.length;
}

// Pre-warm: download every (starter plugin × MC version) combo once. Custom
// resolvers (Floodgate) only cache one universal entry under 'any' since they
// ship a single Spigot JAR per release.
async function prewarmPluginCache() {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
  } catch {}
  migrateLegacyCache();
  const idx = loadIndex();
  let hits = 0,
    misses = 0,
    refreshed = 0,
    errors = 0,
    mb = 0;

  // Build target list: (plugin × MC version) for Modrinth, plus 'any' for custom resolvers
  const targets = [];
  for (const pid of STARTER_PLUGIN_IDS) {
    if (CUSTOM_RESOLVERS[pid]) {
      // Universal — one slot under 'any'
      targets.push({ pid, mc: null });
    } else {
      // Per-MC-version slots + an 'any' fallback for forward-compat plugins
      for (const mc of PREWARM_MC_VERSIONS) targets.push({ pid, mc });
      targets.push({ pid, mc: null });
    }
  }

  for (const { pid, mc } of targets) {
    try {
      const cp = cachePath(pid, mc);
      const key = indexKey(pid, mc);
      const cached = idx[key];
      const wrongLoader =
        cached && /\b(neoforge|fabric|forge)\b/i.test(cached.filename || "");
      if (
        !wrongLoader &&
        cached &&
        fs.existsSync(cp) &&
        fs.statSync(cp).size > 1000 &&
        Date.now() - cached.mtime < 24 * 3600 * 1000
      ) {
        hits++;
        continue;
      }
      if (wrongLoader) {
        console.log(
          `[plugin-cache/prewarm] ${key} cached as wrong loader (${cached.filename}) — re-resolving`,
        );
        try {
          fs.unlinkSync(cp);
        } catch {}
      }
      if (cached && fs.existsSync(cp)) {
        try {
          const latest = await resolveLatestVersion(pid, mc);
          if (latest.version_id === cached.version_id) {
            idx[key] = { ...cached, mtime: Date.now() };
            hits++;
            continue;
          }
          console.log(
            `[plugin-cache/prewarm] ${key} → newer version ${latest.version_number} (was ${cached.version_number})`,
          );
          refreshed++;
        } catch {
          hits++;
          continue;
        }
      } else {
        console.log(`[plugin-cache/prewarm] ${key} → downloading`);
        misses++;
      }
      const size = await downloadOne(pid, mc, idx);
      mb += size / 1024 / 1024;
    } catch (err) {
      errors++;
      console.warn(
        `[plugin-cache/prewarm] ${pid}__${mc || "any"} failed: ${err.message.slice(0, 120)}`,
      );
    }
  }
  saveIndex(idx);
  console.log(
    `🧩 Plugin cache prewarmed: ${hits} hit · ${misses} downloaded · ${refreshed} refreshed (${mb.toFixed(1)}MB) · ${errors} errors`,
  );
}

// Copy a cached plugin JAR into a server's plugins/ dir. Looks up cache by
// (projectId, mcVersion). If the exact MC slot is missing, falls back to the
// 'any' universal slot. Returns null on full miss — caller fetches fresh.
async function copyFromCache(projectId, destPluginsDir, mcVersion) {
  const idx = loadIndex();
  const candidates = [
    cachePath(projectId, mcVersion),
    cachePath(projectId, null), // 'any' fallback
  ];
  const keys = [indexKey(projectId, mcVersion), indexKey(projectId, null)];
  for (let i = 0; i < candidates.length; i++) {
    const cp = candidates[i];
    const meta = idx[keys[i]];
    if (!fs.existsSync(cp) || fs.statSync(cp).size < 1000 || !meta) continue;
    await fsp.mkdir(destPluginsDir, { recursive: true });
    const safe = String(meta.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const destPath = path.join(destPluginsDir, safe);
    try {
      await fsp.link(cp, destPath);
    } catch (err) {
      if (err.code === "EEXIST")
        return { filename: safe, fromCache: true, mc: meta.mc_version };
      if (err.code === "EXDEV" || err.code === "EPERM")
        await fsp.copyFile(cp, destPath);
      else throw err;
    }
    return { filename: safe, fromCache: true, mc: meta.mc_version };
  }
  return null;
}

// Persist a freshly-downloaded JAR into the cache so future installs hit.
async function writeIntoCache(
  projectId,
  filename,
  buf,
  versionMeta = {},
  mcVersion,
) {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
  } catch {}
  await fsp.writeFile(cachePath(projectId, mcVersion), buf);
  const idx = loadIndex();
  idx[indexKey(projectId, mcVersion)] = {
    project_id: projectId,
    mc_version: mcVersion || "any",
    filename,
    version_id: versionMeta.version_id || null,
    version_number: versionMeta.version_number || null,
    sha512: versionMeta.sha512 || null,
    size: buf.length,
    mtime: Date.now(),
  };
  saveIndex(idx);
}

function listCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return [];
    const idx = loadIndex();
    return fs
      .readdirSync(CACHE_DIR)
      .filter((n) => n.endsWith(".jar"))
      .map((n) => {
        const base = n.replace(/\.jar$/, "");
        const [pid, mc] = base.includes("__")
          ? base.split("__", 2)
          : [base, "any"];
        const key = `${pid}__${mc}`;
        const meta = idx[key] || idx[pid] || {};
        const st = fs.statSync(path.join(CACHE_DIR, n));
        return {
          project_id: pid,
          mc_version: mc,
          filename: meta.filename || n,
          version: meta.version_number,
          mb: +(st.size / 1024 / 1024).toFixed(1),
        };
      })
      .sort(
        (a, b) =>
          a.project_id.localeCompare(b.project_id) ||
          a.mc_version.localeCompare(b.mc_version),
      );
  } catch {
    return [];
  }
}

module.exports = {
  STARTER_PLUGIN_IDS,
  PREWARM_MC_VERSIONS,
  CACHE_DIR,
  prewarmPluginCache,
  copyFromCache,
  writeIntoCache,
  resolveLatestVersion,
  listCache,
};
