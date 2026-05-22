// Live version listings for each server type. 1-hour in-memory cache.
const express = require('express');
const router = express.Router();

const UA = 'CraftHost/1.0 (crafthost.up.railway.app)';
const TTL = 60 * 60 * 1000;
const cache = Object.create(null); // key → { ts, data }

function cached(key, fn) {
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < TTL) return Promise.resolve(hit.data);
  return fn().then(data => { cache[key] = { ts: Date.now(), data }; return data; });
}

function clampLimit(req, def = 30, max = 200) {
  const n = parseInt(req.query.limit || def, 10);
  return Math.max(1, Math.min(max, isNaN(n) ? def : n));
}

router.get('/vanilla', async (req, res) => {
  try {
    const data = await cached('vanilla', async () => {
      const r = await fetch(process.env.MOJANG_MANIFEST || 'https://launchermeta.mojang.com/mc/game/version_manifest.json', { headers: { 'User-Agent': UA } });
      const m = await r.json();
      return m.versions.filter(v => v.type === 'release').map(v => ({
        id: v.id, type: 'vanilla', released: v.releaseTime,
      }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) { res.status(500).json({ error: 'vanilla fetch failed' }); }
});

router.get('/paper', async (req, res) => {
  try {
    const data = await cached('paper', async () => {
      const r = await fetch((process.env.PAPER_API || 'https://api.papermc.io/v2') + '/projects/paper', { headers: { 'User-Agent': UA } });
      const m = await r.json();
      // Newest first
      const list = [...(m.versions || [])].reverse();
      return list.map(v => ({ id: v, type: 'paper' }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) { res.status(500).json({ error: 'paper fetch failed' }); }
});

router.get('/purpur', async (req, res) => {
  try {
    const data = await cached('purpur', async () => {
      const r = await fetch('https://api.purpurmc.org/v2/purpur', { headers: { 'User-Agent': UA } });
      const m = await r.json();
      const list = [...(m.versions || [])].reverse();
      return list.map(v => ({ id: v, type: 'purpur' }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) { res.status(500).json({ error: 'purpur fetch failed' }); }
});

router.get('/fabric', async (req, res) => {
  try {
    const data = await cached('fabric', async () => {
      const r = await fetch('https://meta.fabricmc.net/v2/versions/game', { headers: { 'User-Agent': UA } });
      const list = await r.json();
      return list.filter(v => v.stable).map(v => ({ id: v.version, type: 'fabric' }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) { res.status(500).json({ error: 'fabric fetch failed' }); }
});

router.get('/neoforge', async (req, res) => {
  try {
    const data = await cached('neoforge', async () => {
      // NeoForge versions API
      const r = await fetch('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', { headers: { 'User-Agent': UA } });
      const m = await r.json();
      const list = (m.versions || []).reverse();
      return list.map(v => ({ id: v, type: 'neoforge' }));
    });
    res.json({ versions: data.slice(0, clampLimit(req)) });
  } catch (err) { res.status(500).json({ error: 'neoforge fetch failed' }); }
});

// Unified passthrough: /api/versions?type=paper&limit=10
router.get('/', async (req, res) => {
  const type = (req.query.type || 'paper').toLowerCase();
  const map = { paper: '/paper', vanilla: '/vanilla', purpur: '/purpur', fabric: '/fabric', neoforge: '/neoforge', spigot: '/paper' /* spigot uses Paper jar */ };
  const route = map[type];
  if (!route) return res.status(400).json({ error: 'Unknown type' });
  // Redirect internally
  req.url = route + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  router.handle(req, res, () => {});
});

module.exports = router;
