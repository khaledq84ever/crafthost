// Per-user JAR library — upload custom server JARs once, reference from any server.

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { authMiddleware } = require('../lib/auth');
const uploadErrors = require('../lib/upload-errors');

const router = express.Router();
router.use(authMiddleware);

const JAR_DIR = process.env.JAR_DIR || path.resolve(__dirname, '../../jars');
fs.mkdirSync(JAR_DIR, { recursive: true });

const MAX_JAR_BYTES = 500 * 1024 * 1024; // 500 MB

function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 200);
}

// GET /api/jars — list current user's library
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, filename, size, sha256, created_at FROM jars WHERE user_id = ? ORDER BY created_at DESC')
                  .all(req.user.id);
  res.json({ jars: rows });
});

// POST /api/jars — multipart upload, field "jar"
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, JAR_DIR),
    filename: (req, file, cb) => {
      const id = crypto.randomBytes(8).toString('hex');
      cb(null, `${id}__${sanitize(file.originalname)}`);
    },
  }),
  limits: { fileSize: MAX_JAR_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!/\.jar$/i.test(file.originalname)) return cb(new Error('Only .jar files allowed'));
    cb(null, true);
  },
});

router.post('/', upload.single('jar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const buf = await fsp.readFile(req.file.path);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const id = path.basename(req.file.filename).split('__')[0];
    db.prepare('INSERT INTO jars (id, user_id, filename, size, sha256, storage_path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, req.file.originalname, req.file.size, sha256, req.file.path);
    audit(req.user.id, 'jar.upload', id, req.ip, { filename: req.file.originalname, size: req.file.size });
    res.json({ ok: true, id, filename: req.file.originalname, size: req.file.size, sha256 });
  } catch (err) {
    // Best-effort cleanup if DB insert fails
    fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ error: 'JAR upload failed' });
  }
});

// DELETE /api/jars/:id
router.delete('/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM jars WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await fsp.unlink(row.storage_path).catch(() => {});
  db.prepare('DELETE FROM jars WHERE id = ?').run(row.id);
  audit(req.user.id, 'jar.delete', row.id, req.ip);
  res.json({ ok: true });
});

// GET /api/jars/:id/download
router.get('/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM jars WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${sanitize(row.filename)}"`);
  res.setHeader('Content-Length', row.size);
  fs.createReadStream(row.storage_path).pipe(res);
});

function audit(user_id, action, resource_id, ip, metadata) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user_id, action, 'jar', resource_id, ip || null, metadata ? JSON.stringify(metadata) : null);
  } catch {}
}

// Shared upload error handler (413 for oversized, 400 otherwise)
router.use(uploadErrors({ catchAll: true }));

module.exports = router;
