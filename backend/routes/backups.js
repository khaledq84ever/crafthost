// Backups REST API — owner-scoped, plan-aware retention, stop-aware snapshot.

const express = require('express');
const fs = require('fs');
const db = require('../db');
const { authMiddleware } = require('../lib/auth');
const dc = require('../lib/controller');
const bk = require('../lib/backup');
const oplock = require('../lib/oplock');

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
    retention_effective: retentionFor(s),
    used_bytes: bk.totalBackupBytes(s.id),
  });
});

// A server whose DB row says starting/online/running must be stopped before we
// touch world files. Checking only the live SLP probe (stats.online) missed a
// BOOTING JVM — still false, yet the process is actively writing the world.
function isActive(s) {
  const st = db.prepare('SELECT status FROM servers WHERE id = ?').get(s.id)?.status;
  return ['starting', 'online', 'running'].includes(String(st || '').toLowerCase());
}

// POST /api/servers/:id/backups  — snapshot now (stops server if running)
// Body: { label? } — label shows in the list (e.g. "before-big-build").
router.post('/', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  if (oplock.has(s.id)) return res.status(409).json(oplock.busyPayload(s.id));
  oplock.acquire(s.id, 'backup');
  try {
    const wasActive = isActive(s);
    if (wasActive) {
      // Graceful save-all before stopping, so chunks are flushed.
      try { await dc.sendRcon(s, '/save-all'); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      await dc.stopServer(s);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
    }

    const info = await bk.createBackup(s.id, {
      retention: retentionFor(s),
      label: req.body?.label,
    });

    audit(req.user.id, 'server.backup', s.id, req.ip, { backup_id: info.id, size: info.size });

    if (wasActive) {
      try {
        await dc.startServer(s);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
      } catch {}
    }

    res.json({ ok: true, ...info, was_running: wasActive });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Backup failed' });
  } finally {
    oplock.release(s.id);
  }
});

function retentionFor(s) {
  return parseInt(process.env.BACKUPS_PER_SERVER || s.backups_count || 10, 10);
}

// POST /api/servers/:id/backups/:bid/restore
// Takes a safety backup of the CURRENT world first, so a mistaken restore is
// itself reversible.
router.post('/:bid/restore', async (req, res) => {
  const s = ownedServer(req, res); if (!s) return;
  const bid = String(req.params.bid).replace(/[^A-Za-z0-9_\-:.]/g, '');
  if (oplock.has(s.id)) return res.status(409).json(oplock.busyPayload(s.id));
  oplock.acquire(s.id, 'restore');
  try {
    const wasActive = isActive(s);
    if (wasActive) {
      try { await dc.sendRcon(s, '/save-all'); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      await dc.stopServer(s);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('offline', s.id);
    }

    try {
      // protect: retention eviction must never delete the backup we are about
      // to restore (it can be the oldest one).
      await bk.createBackup(s.id, { retention: retentionFor(s), label: 'auto-pre-restore', protect: bid });
    } catch {}

    await bk.restoreBackup(s.id, bid);
    audit(req.user.id, 'server.restore', s.id, req.ip, { backup_id: bid });

    if (wasActive) {
      try {
        await dc.startServer(s);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', s.id);
      } catch {}
    }
    res.json({ ok: true, restarted: wasActive });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Restore failed' });
  } finally {
    oplock.release(s.id);
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
