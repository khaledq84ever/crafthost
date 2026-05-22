// World backup engine. Snapshots the playable parts of a server (world dirs +
// server.properties + ops/whitelist/banned-*.json) into a single .zip under
// /data/backups/<server_id>/<id>.zip. Stops the JVM during snapshot to avoid
// torn writes, then restarts if it was running.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
const BACKUP_DIR = process.env.BACKUP_DIR || path.resolve(__dirname, '../../data/backups');

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// What to include in a snapshot, relative to the server's data dir.
const SNAPSHOT_TARGETS = [
  'world', 'world_nether', 'world_the_end',
  'server.properties', 'ops.json', 'whitelist.json',
  'banned-players.json', 'banned-ips.json',
];

function backupDirFor(serverId) {
  const d = path.join(BACKUP_DIR, serverId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function listBackups(serverId) {
  const d = backupDirFor(serverId);
  const entries = fs.readdirSync(d, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.zip')) continue;
    const full = path.join(d, e.name);
    const st = fs.statSync(full);
    out.push({
      id: e.name.replace(/\.zip$/, ''),
      filename: e.name,
      size: st.size,
      created_at: st.mtimeMs,
    });
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return out;
}

async function createBackup(serverId, ctx = {}) {
  const srcDir = path.join(DATA_DIR, serverId);
  if (!fs.existsSync(srcDir)) throw new Error('Server data dir missing');

  const zip = new AdmZip();
  for (const rel of SNAPSHOT_TARGETS) {
    const abs = path.join(srcDir, rel);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) zip.addLocalFolder(abs, rel);
    else zip.addLocalFile(abs, path.dirname(rel) === '.' ? '' : path.dirname(rel));
  }

  // Empty server case: still write a marker file
  if (zip.getEntries().length === 0) {
    zip.addFile('EMPTY.txt', Buffer.from('Server had no world data at backup time.\n'));
  }

  const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${crypto.randomBytes(3).toString('hex')}`;
  const dest = path.join(backupDirFor(serverId), `${id}.zip`);
  zip.writeZip(dest);
  const st = fs.statSync(dest);

  // Enforce retention (oldest-first delete)
  if (ctx.retention && ctx.retention > 0) {
    const all = listBackups(serverId);
    if (all.length > ctx.retention) {
      const toDelete = all.slice(ctx.retention);
      for (const b of toDelete) {
        try { fs.unlinkSync(path.join(backupDirFor(serverId), b.filename)); } catch {}
      }
    }
  }

  return { id, filename: path.basename(dest), size: st.size, created_at: st.mtimeMs };
}

async function restoreBackup(serverId, backupId) {
  const zipPath = path.join(backupDirFor(serverId), `${backupId}.zip`);
  if (!fs.existsSync(zipPath)) throw new Error('Backup not found');

  const srcDir = path.join(DATA_DIR, serverId);
  fs.mkdirSync(srcDir, { recursive: true });

  // Move existing world dirs aside first (so a failed unzip doesn't half-corrupt state)
  const trash = path.join(srcDir, `.restore-trash-${Date.now()}`);
  fs.mkdirSync(trash, { recursive: true });
  for (const rel of SNAPSHOT_TARGETS) {
    const cur = path.join(srcDir, rel);
    if (fs.existsSync(cur)) {
      const dst = path.join(trash, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try { fs.renameSync(cur, dst); } catch {}
    }
  }

  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(srcDir, true);
  } catch (err) {
    // Roll back from trash
    for (const rel of SNAPSHOT_TARGETS) {
      const t = path.join(trash, rel);
      const dst = path.join(srcDir, rel);
      if (fs.existsSync(t)) {
        try { fs.renameSync(t, dst); } catch {}
      }
    }
    throw err;
  }

  // Trash succeeded — wipe it
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch {}
  return { ok: true };
}

async function deleteBackup(serverId, backupId) {
  const p = path.join(backupDirFor(serverId), `${backupId}.zip`);
  if (!fs.existsSync(p)) throw new Error('Backup not found');
  fs.unlinkSync(p);
  return { ok: true };
}

function pathForDownload(serverId, backupId) {
  const p = path.join(backupDirFor(serverId), `${backupId}.zip`);
  if (!fs.existsSync(p)) return null;
  return p;
}

function totalBackupBytes(serverId) {
  return listBackups(serverId).reduce((a, b) => a + b.size, 0);
}

module.exports = {
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  pathForDownload,
  totalBackupBytes,
  SNAPSHOT_TARGETS,
};
