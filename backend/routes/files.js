// File manager — server-scoped, path-traversal-safe.
// All paths are resolved under DATA_DIR/<server.id>/ and rejected if they escape.

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const archiver = null; // optional, not required for v1
const db = require("../db");
const { authMiddleware } = require("../lib/auth");
const uploadErrors = require("../lib/upload-errors");

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

const DATA_DIR =
  process.env.DATA_DIR || path.resolve(__dirname, "../../data/servers");
fs.mkdirSync(DATA_DIR, { recursive: true });

const MAX_EDITABLE_BYTES = 2 * 1024 * 1024; // 2 MB text edit cap
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB per file
const EDITABLE_EXT = new Set([
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".properties",
  ".toml",
  ".cfg",
  ".conf",
  ".log",
  ".md",
  ".sh",
  ".bat",
  ".mcmeta",
  ".snbt",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
]);

function ownedServer(req, res) {
  const s = db
    .prepare("SELECT * FROM servers WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user.id);
  if (!s) {
    res.status(404).json({ error: "Server not found" });
    return null;
  }
  return s;
}

function serverRoot(serverId) {
  const root = path.resolve(DATA_DIR, serverId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// Resolve user-supplied path against the server root, refusing escapes.
function safeJoin(root, userPath) {
  const cleaned = String(userPath || "")
    .replace(/\\/g, "/")
    .replace(/\0/g, "");
  const target = path.resolve(root, "." + path.posix.normalize("/" + cleaned));
  if (target !== root && !target.startsWith(root + path.sep)) {
    const err = new Error("Path escapes server root");
    err.code = "EPATH";
    throw err;
  }
  return target;
}

function relTo(root, abs) {
  const r = path.relative(root, abs).replace(/\\/g, "/");
  return "/" + r;
}

function isEditable(name, size) {
  const ext = path.extname(name).toLowerCase();
  return size <= MAX_EDITABLE_BYTES && (EDITABLE_EXT.has(ext) || ext === "");
}

// GET /api/servers/:id/files?path=/  → list directory
router.get("/", async (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  try {
    const root = serverRoot(s.id);
    const dir = safeJoin(root, req.query.path || "/");
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat || !stat.isDirectory())
      return res.status(404).json({ error: "Not a directory" });
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        const abs = path.join(dir, e.name);
        const st = await fsp.stat(abs).catch(() => null);
        return {
          name: e.name,
          type: e.isDirectory() ? "folder" : "file",
          size: st ? st.size : 0,
          mtime: st ? st.mtimeMs : 0,
          editable: e.isFile() && st ? isEditable(e.name, st.size) : false,
        };
      }),
    );
    items.sort((a, b) =>
      a.type !== b.type
        ? a.type === "folder"
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
    res.json({ path: relTo(root, dir), items });
  } catch (err) {
    res
      .status(err.code === "EPATH" ? 400 : 500)
      .json({ error: err.code === "EPATH" ? "Invalid path" : "List failed" });
  }
});

// GET /api/servers/:id/files/read?path=/server.properties
router.get("/read", async (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  try {
    const root = serverRoot(s.id);
    const target = safeJoin(root, req.query.path);
    const st = await fsp.stat(target).catch(() => null);
    if (!st) return res.status(404).json({ error: "File not found" });
    if (!st.isFile()) return res.status(400).json({ error: "Not a file" });
    if (st.size > MAX_EDITABLE_BYTES)
      return res.status(413).json({ error: "File too large to edit" });
    const content = await fsp.readFile(target, "utf8").catch(async () => {
      const buf = await fsp.readFile(target);
      return buf.toString("base64");
    });
    res.json({ path: relTo(root, target), size: st.size, content });
  } catch (err) {
    res.status(err.code === "EPATH" ? 400 : 500).json({ error: "Read failed" });
  }
});

// PUT /api/servers/:id/files/write  { path, content }
router.put("/write", async (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  try {
    const { path: p, content } = req.body || {};
    if (typeof content !== "string")
      return res.status(400).json({ error: "content required" });
    if (content.length > MAX_EDITABLE_BYTES)
      return res.status(413).json({ error: "Too large" });
    const root = serverRoot(s.id);
    const target = safeJoin(root, p);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, "utf8");
    audit(req.user.id, "file.write", s.id, req.ip, { path: p });
    res.json({ ok: true, path: relTo(root, target) });
  } catch (err) {
    res
      .status(err.code === "EPATH" ? 400 : 500)
      .json({ error: err.code === "EPATH" ? "Invalid path" : "Write failed" });
  }
});

// POST /api/servers/:id/files/mkdir  { path }
router.post("/mkdir", async (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  try {
    const root = serverRoot(s.id);
    const target = safeJoin(root, req.body?.path);
    await fsp.mkdir(target, { recursive: true });
    audit(req.user.id, "file.mkdir", s.id, req.ip, { path: req.body?.path });
    res.json({ ok: true, path: relTo(root, target) });
  } catch (err) {
    res
      .status(err.code === "EPATH" ? 400 : 500)
      .json({ error: err.code === "EPATH" ? "Invalid path" : "Mkdir failed" });
  }
});

// POST /api/servers/:id/files/rename  { from, to }
router.post("/rename", async (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  try {
    const root = serverRoot(s.id);
    const from = safeJoin(root, req.body?.from);
    const to = safeJoin(root, req.body?.to);
    await fsp.rename(from, to);
    audit(req.user.id, "file.rename", s.id, req.ip, {
      from: req.body?.from,
      to: req.body?.to,
    });
    res.json({ ok: true });
  } catch (err) {
    res
      .status(err.code === "EPATH" ? 400 : 500)
      .json({ error: err.code === "EPATH" ? "Invalid path" : "Rename failed" });
  }
});

// DELETE /api/servers/:id/files?path=/foo
router.delete("/", async (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  try {
    const root = serverRoot(s.id);
    const target = safeJoin(root, req.query.path);
    if (target === root)
      return res.status(400).json({ error: "Cannot delete root" });
    await fsp.rm(target, { recursive: true, force: true });
    audit(req.user.id, "file.delete", s.id, req.ip, { path: req.query.path });
    res.json({ ok: true });
  } catch (err) {
    res
      .status(err.code === "EPATH" ? 400 : 500)
      .json({ error: err.code === "EPATH" ? "Invalid path" : "Delete failed" });
  }
});

// GET /api/servers/:id/files/download?path=/foo.json — stream raw bytes
router.get("/download", async (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  try {
    const root = serverRoot(s.id);
    const target = safeJoin(root, req.query.path);
    const st = await fsp.stat(target).catch(() => null);
    if (!st) return res.status(404).json({ error: "File not found" });
    if (!st.isFile()) return res.status(400).json({ error: "Not a file" });
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(target)}"`,
    );
    res.setHeader("Content-Length", st.size);
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    res.status(err.code === "EPATH" ? 400 : 500).json({
      error: err.code === "EPATH" ? "Invalid path" : "Download failed",
    });
  }
});

// POST /api/servers/:id/files/upload  (multipart, fields: path, files[])
// The "filename" of each file MAY contain "__SLASH__" tokens to encode a
// relative path (used by the drag-drop UI to upload folders intact).
function decodeRel(name) {
  return String(name || "").replace(/__SLASH__/g, "/");
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const s = db
          .prepare("SELECT id, user_id FROM servers WHERE id = ?")
          .get(req.params.id);
        if (!s || s.user_id !== req.user.id)
          return cb(new Error("Not authorized"));
        const root = serverRoot(s.id);
        const base = safeJoin(root, req.body?.path || req.query.path || "/");
        const rel = decodeRel(file.originalname);
        const sub = path.posix.dirname("/" + rel.replace(/\\/g, "/"));
        const dest = safeJoin(base, sub);
        fs.mkdirSync(dest, { recursive: true });
        cb(null, dest);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const rel = decodeRel(file.originalname);
      cb(null, path.basename(rel));
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 200 },
});

router.post("/upload", upload.array("files", 200), (req, res) => {
  const s = ownedServer(req, res);
  if (!s) return;
  const root = serverRoot(s.id);
  const uploaded = (req.files || []).map((f) => ({
    name: decodeRel(f.originalname),
    size: f.size,
    path: relTo(root, f.path),
  }));
  audit(req.user.id, "file.upload", s.id, req.ip, { count: uploaded.length });
  res.json({ ok: true, uploaded });
});

function audit(user_id, action, resource_id, ip, metadata) {
  try {
    db.prepare(
      "INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      user_id,
      action,
      "file",
      resource_id,
      ip || null,
      metadata ? JSON.stringify(metadata) : null,
    );
  } catch {}
}

// Multer error handler — without this an oversized upload (or a destination
// error) falls through to Express's default handler and returns an HTML 500.
router.use(
  uploadErrors({
    catchAll: true,
    maxLabel: `${MAX_UPLOAD_BYTES / 1024 / 1024} MB per file`,
  }),
);

module.exports = router;
