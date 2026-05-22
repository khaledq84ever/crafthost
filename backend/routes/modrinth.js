const express = require('express');
const router = express.Router();

const BASE = process.env.MODRINTH_API || 'https://api.modrinth.com/v2';

router.get('/search', async (req, res) => {
  const { q = '', loader, version, limit = 24, offset = 0, type, sort = 'relevance' } = req.query;
  // Modrinth facets: each top-level array is an AND group, elements inside are OR.
  const facets = [];
  if (loader) facets.push([`categories:${loader}`]);
  if (version) facets.push([`versions:${version}`]);
  if (type === 'modpack') facets.push(['project_type:modpack']);
  else if (type === 'mod') facets.push(['project_type:mod']);
  else if (type === 'plugin') facets.push(['project_type:plugin']);
  else facets.push(['project_type:mod', 'project_type:plugin']);

  const validSorts = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);
  const useSort = validSorts.has(sort) ? sort : 'relevance';

  const url = `${BASE}/search?query=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&index=${useSort}` +
    `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'CraftHost/1.0 (crafthost.up.railway.app)' } });
    const data = await r.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Modrinth search failed' }); }
});

router.get('/project/:id', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/project/${req.params.id}`, { headers: { 'User-Agent': 'CraftHost/1.0 (crafthost.up.railway.app)' } });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: 'Modrinth fetch failed' }); }
});

// GET /api/modrinth/project/:id/versions?loaders=paper,spigot&game_versions=1.21.1
router.get('/project/:id/versions', async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (req.query.loaders) params.set('loaders', JSON.stringify(String(req.query.loaders).split(',')));
    if (req.query.game_versions) params.set('game_versions', JSON.stringify(String(req.query.game_versions).split(',')));
    const url = `${BASE}/project/${encodeURIComponent(req.params.id)}/version${params.toString() ? '?' + params : ''}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CraftHost/1.0 (crafthost.up.railway.app)' } });
    const data = await r.json();
    // Trim to a UI-friendly shape
    const out = (Array.isArray(data) ? data : []).map(v => ({
      id: v.id,
      version_number: v.version_number,
      name: v.name,
      loaders: v.loaders,
      game_versions: v.game_versions,
      date_published: v.date_published,
      downloads: v.downloads,
      file: (v.files || []).find(f => f.primary) || v.files?.[0] || null,
    }));
    res.json({ versions: out });
  } catch (err) { res.status(500).json({ error: 'Modrinth versions fetch failed' }); }
});

module.exports = router;
