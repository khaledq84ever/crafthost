// Plugin install — fetches a Modrinth version's primary JAR and lands it in
// <server_data_dir>/plugins/<filename>.jar. Same per-server isolation as files.js.

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const db = require('../db');
const { authMiddleware } = require('../lib/auth');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
const MODRINTH = process.env.MODRINTH_API || 'https://api.modrinth.com/v2';
const UA = 'CraftHost/1.0 (crafthost.up.railway.app)';
const MAX_JAR_BYTES = 250 * 1024 * 1024; // 250 MB

function ownedServer(req, res) {
  const s = db.prepare('SELECT * FROM servers WHERE id = ? AND user_id = ?')
              .get(req.params.id, req.user.id);
  if (!s) { res.status(404).json({ error: 'Server not found' }); return null; }
  return s;
}

function pluginsDir(serverId) {
  const dir = path.join(DATA_DIR, serverId, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 200);
}

function sha512Of(buf) {
  return crypto.createHash('sha512').update(buf).digest('hex');
}

// GET /api/servers/:id/plugins  — list installed JARs
router.get('/', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const dir = pluginsDir(s.id);
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    const list = await Promise.all(items.filter(e => e.isFile()).map(async (e) => {
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      return { name: e.name, size: st?.size || 0, mtime: st?.mtimeMs || 0 };
    }));
    list.sort((a, b) => b.mtime - a.mtime);
    res.json({ plugins: list });
  } catch { res.json({ plugins: [] }); }
});

// POST /api/servers/:id/plugins/install  { version_id }
// or { project_id } to install the latest matching version
router.post('/install', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const { version_id, project_id } = req.body || {};
  if (!version_id && !project_id) return res.status(400).json({ error: 'version_id or project_id required' });

  try {
    // Resolve to a concrete version
    let version;
    if (version_id) {
      const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(version_id)}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) return res.status(502).json({ error: 'Modrinth version lookup failed' });
      version = await r.json();
    } else {
      // Resolve the newest compatible version. Modrinth filters are strict — a Paper
      // server still happily loads Spigot/Bukkit plugins, and many popular plugins
      // (WorldGuard, Spark) tag themselves only as 'bukkit'. So try progressively
      // wider filters before giving up.
      const loader = (s.type || '').toLowerCase();
      const gameV  = (s.version && s.version !== 'LATEST') ? s.version : null;
      const FAMILY = {
        paper:    ['paper', 'spigot', 'bukkit'],
        spigot:   ['spigot', 'paper', 'bukkit'],
        purpur:   ['purpur', 'paper', 'spigot', 'bukkit'],
        bukkit:   ['bukkit', 'spigot', 'paper'],
        fabric:   ['fabric'],
        neoforge: ['neoforge', 'forge'],
        forge:    ['forge', 'neoforge'],
      };
      const loaderList = FAMILY[loader] || (loader ? [loader] : null);

      async function tryQuery({ loaders, version }) {
        const params = new URLSearchParams();
        if (loaders) params.set('loaders', JSON.stringify(loaders));
        if (version) params.set('game_versions', JSON.stringify([version]));
        const url = `${MODRINTH}/project/${encodeURIComponent(project_id)}/version${params.toString() ? '?' + params : ''}`;
        const rr = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!rr.ok) return null;
        const arr = await rr.json();
        return Array.isArray(arr) && arr.length ? arr[0] : null;
      }

      // Loader-strict: only fall back to a wider game-version, never to an
      // incompatible loader family. A Paper server must NEVER receive a Fabric
      // jar (it would silently install and fail to load at runtime). If the
      // project has no version for the server's loader family, return 404 so
      // the UI can surface a real error.
      if (loaderList) {
        version =
          await tryQuery({ loaders: loaderList, version: gameV }) ||
          await tryQuery({ loaders: loaderList, version: null  });
        if (!version) return res.status(404).json({
          error: `No ${loaderList[0]}-compatible version found for this plugin`,
        });
      } else {
        version =
          await tryQuery({ loaders: null, version: gameV }) ||
          await tryQuery({ loaders: null, version: null });
        if (!version) return res.status(404).json({ error: 'No compatible version found' });
      }
    }

    const file = (version.files || []).find(f => f.primary) || version.files?.[0];
    if (!file?.url) return res.status(404).json({ error: 'No downloadable file in version' });

    // Stream the JAR with a size cap
    const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
    if (!dl.ok) return res.status(502).json({ error: 'JAR download failed' });

    const contentLength = parseInt(dl.headers.get('content-length') || '0', 10);
    if (contentLength && contentLength > MAX_JAR_BYTES)
      return res.status(413).json({ error: 'JAR too large' });

    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length > MAX_JAR_BYTES) return res.status(413).json({ error: 'JAR too large' });

    // Optional integrity check against modrinth-reported sha512
    if (file.hashes?.sha512) {
      const got = sha512Of(buf);
      if (got !== file.hashes.sha512)
        return res.status(502).json({ error: 'Hash mismatch — refusing to install' });
    }

    const name = sanitizeName(file.filename || 'plugin.jar');
    const dest = path.join(pluginsDir(s.id), name);
    await fsp.writeFile(dest, buf);

    try {
      audit(req.user.id, 'plugin.install', s.id, req.ip, { name, version: version.version_number });
    } catch (err) { console.warn('[plugin.install] audit failed:', err.message); }
    res.json({ ok: true, name, size: buf.length, version: version.version_number });
  } catch (err) {
    console.warn(`[plugin.install] ${project_id || version_id}: ${err.stack || err.message}`);
    res.status(500).json({ error: `Install failed: ${err.message || 'unknown error'}` });
  }
});

// POST /api/servers/:id/plugins/install-modpack { project_id } or { version_id }
// Downloads a Modrinth .mrpack, parses modrinth.index.json, and writes every
// referenced mod into the server's mods/ folder. Overrides folder content is
// extracted to the server root (config/, resourcepacks/, etc).
router.post('/install-modpack', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const { version_id, project_id } = req.body || {};
  if (!version_id && !project_id) return res.status(400).json({ error: 'project_id required' });

  try {
    let version;
    if (version_id) {
      const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(version_id)}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) return res.status(502).json({ error: 'Modrinth version lookup failed' });
      version = await r.json();
    } else {
      // For modpacks, prefer the newest version; loader/MC filtering is implicit in the modpack itself
      const r = await fetch(`${MODRINTH}/project/${encodeURIComponent(project_id)}/version`, { headers: { 'User-Agent': UA } });
      if (!r.ok) return res.status(502).json({ error: 'Modrinth project lookup failed' });
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) return res.status(404).json({ error: 'No modpack versions available' });
      version = list[0];
    }

    const packFile = (version.files || []).find(f => f.primary) || version.files?.[0];
    if (!packFile?.url) return res.status(404).json({ error: 'No primary file in modpack version' });

    // Download .mrpack
    const dl = await fetch(packFile.url, { headers: { 'User-Agent': UA } });
    if (!dl.ok) return res.status(502).json({ error: 'Modpack download failed' });
    const packBuf = Buffer.from(await dl.arrayBuffer());
    if (packBuf.length > 800 * 1024 * 1024) return res.status(413).json({ error: 'Modpack too large' });

    // Parse modrinth.index.json
    const AdmZip = require('adm-zip');
    let zip;
    try { zip = new AdmZip(packBuf); }
    catch { return res.status(502).json({ error: 'Modpack is not a valid .mrpack' }); }

    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) return res.status(502).json({ error: 'modrinth.index.json missing in modpack' });
    let index;
    try { index = JSON.parse(zip.readAsText(indexEntry)); }
    catch { return res.status(502).json({ error: 'modrinth.index.json malformed' }); }

    const dir = path.join(DATA_DIR, s.id);
    const modsDir = path.join(dir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });

    // Download each file with size guard. Concurrency 4.
    const files = Array.isArray(index.files) ? index.files : [];
    const MAX_TOTAL = 1024 * 1024 * 1024; // 1 GB total cap
    let totalBytes = 0;
    let installed = 0;
    let skipped = 0;

    const queue = files.slice();
    async function worker() {
      while (queue.length) {
        const f = queue.shift();
        try {
          // Sanitize relative path; must stay inside server dir
          const rel = String(f.path || '').replace(/\\/g, '/').replace(/\.\.+\//g, '');
          const dest = path.resolve(dir, rel);
          if (!dest.startsWith(dir + path.sep)) { skipped++; continue; }
          fs.mkdirSync(path.dirname(dest), { recursive: true });

          const downloads = Array.isArray(f.downloads) ? f.downloads : [];
          let wrote = false;
          for (const u of downloads) {
            const r = await fetch(u, { headers: { 'User-Agent': UA } });
            if (!r.ok) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            totalBytes += buf.length;
            if (totalBytes > MAX_TOTAL) throw new Error('Modpack content exceeds 1 GB cap');
            await fsp.writeFile(dest, buf);
            wrote = true;
            installed++;
            break;
          }
          if (!wrote) skipped++;
        } catch (err) {
          // bail out hard on cap exceeded
          if (/exceeds 1 GB/.test(err.message)) throw err;
          skipped++;
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);

    // Extract overrides/* into the server root
    let overrides = 0;
    for (const e of zip.getEntries()) {
      const en = e.entryName.replace(/\\/g, '/');
      if (!en.startsWith('overrides/') || e.isDirectory) continue;
      const sub = en.slice('overrides/'.length);
      const dest = path.resolve(dir, sub);
      if (!dest.startsWith(dir + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
      overrides++;
    }

    audit(req.user.id, 'plugin.install_modpack', s.id, req.ip, {
      name: index.name, version_id: version.id, installed, skipped, overrides
    });

    res.json({
      ok: true,
      name: index.name,
      version: index.versionId || version.version_number,
      installed,
      skipped,
      overrides,
      mc_version: index.dependencies?.minecraft || null,
      loader: Object.keys(index.dependencies || {}).find(k => k !== 'minecraft') || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Modpack install failed' });
  }
});

// DELETE /api/servers/:id/plugins/:name
router.delete('/:name', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const name = sanitizeName(req.params.name);
  const target = path.join(pluginsDir(s.id), name);
  // Confine to plugins dir
  if (!target.startsWith(pluginsDir(s.id) + path.sep)) return res.status(400).json({ error: 'Invalid name' });
  await fsp.unlink(target).catch(() => {});
  audit(req.user.id, 'plugin.remove', s.id, req.ip, { name });
  res.json({ ok: true });
});

function audit(user_id, action, resource_id, ip, metadata) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user_id, action, 'plugin', resource_id, ip || null, metadata ? JSON.stringify(metadata) : null);
  } catch {}
}

module.exports = router;
