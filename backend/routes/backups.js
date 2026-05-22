// Backups REST API — owner-scoped, plan-aware retention, stop-aware snapshot.

const express = require('express');
const fs = require('fs');
const db = require('../db');
const { authMiddleware } = require('../lib/auth');
const dc = require('../lib/controller');
const bk = require('../lib/backup');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

function ownedServer(req, res) {
  const s = db.prepare(`
    SELECT s.*, p.ram_mb, p.cpu_cores, p.backups_count FROM servers s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.id = ? AND s.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!s) { res.status(404).json({ error: 'Server not found' }); return null; }
  return s;
}

// GET /api/servers/:id/backups
router.get('/', (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const list = bk.listBackups(s.id);
  res.json({
    backups: list,
    retention: s.backups_count,
    used_bytes: bk.totalBackupBytes(s.id),
  });
});

// POST /api/servers/:id/backups  — snapshot now (stops server if running)
router.post('/', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  // Plan limit guard
  const existing = bk.listBackups(s.id);
  if (existing.length >= (s.backups_count || 1)) {
    // Don't refuse — we delete oldest on retention enforcement. Just inform.
  }

  let wasRunning = false;
  try {
    const stats = await dc.getStats(s).catch(() => null);
    wasRunning = !!stats?.online;

    if (wasRunning) {
      // Try a graceful save-all + save-off before stopping, so chunks are flushed
      try { await dc.sendRcon(s, '/save-all'); } catch {}
      try { await dc.sendRcon(s, '/save-off'); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      await dc.stopServer(s);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
    }

    const info = await bk.createBackup(s.id, { retention: s.backups_count || 1 });

    audit(req.user.id, 'server.backup', s.id, req.ip, { backup_id: info.id, size: info.size });

    // Restart if we stopped it
    if (wasRunning) {
      try {
        await dc.startServer(s);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
      } catch {}
    }

    res.json({ ok: true, ...info, was_running: wasRunning });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Backup failed' });
  }
});

// POST /api/servers/:id/backups/:bid/restore
router.post('/:bid/restore', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const bid = String(req.params.bid).replace(/[^A-Za-z0-9_\-:.]/g, '');
  try {
    const wasRunning = !!(await dc.getStats(s).catch(() => null))?.online;
    if (wasRunning) {
      await dc.stopServer(s);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
    }

    await bk.restoreBackup(s.id, bid);
    audit(req.user.id, 'server.restore', s.id, req.ip, { backup_id: bid });

    if (wasRunning) {
      try {
        await dc.startServer(s);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
      } catch {}
    }
    res.json({ ok: true, restarted: wasRunning });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Restore failed' });
  }
});

// DELETE /api/servers/:id/backups/:bid
router.delete('/:bid', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const bid = String(req.params.bid).replace(/[^A-Za-z0-9_\-:.]/g, '');
  try {
    await bk.deleteBackup(s.id, bid);
    audit(req.user.id, 'server.backup_delete', s.id, req.ip, { backup_id: bid });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || 'Delete failed' }); }
});

// GET /api/servers/:id/backups/:bid/download
router.get('/:bid/download', (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const bid = String(req.params.bid).replace(/[^A-Za-z0-9_\-:.]/g, '');
  const p = bk.pathForDownload(s.id, bid);
  if (!p) return res.status(404).json({ error: 'Backup not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${s.name}-${bid}.zip"`);
  fs.createReadStream(p).pipe(res);
});

function audit(user_id, action, resource_id, ip, metadata) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user_id, action, 'backup', resource_id, ip || null, metadata ? JSON.stringify(metadata) : null);
  } catch {}
}

module.exports = router;
