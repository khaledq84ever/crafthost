// Broader auto-fix engine for CraftHost.
//
// The existing auto-heal handles OOM by swapping to Paper 1.20.1.
// This module extends it with rule-based diagnosis of recent log lines
// to catch + fix:
//   • port collisions  — Address already in use, BindException
//   • bad JAR          — ClassNotFoundException, NoSuchMethodError,
//                        UnsupportedClassVersionError, corrupt archive
//   • corrupt world    — EOFException on region files, ChunkSerializer errors
//   • plugin crash     — "Could not load/enable plugin <name>" with stack trace
//   • paperclip libs   — "Hash check failed for extract" → corrupted libraries/
//                        cache; wipe it so Paperclip re-extracts on next start
//
// Each fix sets servers.last_auto_fix_kind + .last_auto_fix_at so the
// dashboard health pill can show what was done, and the same kind isn't
// applied twice within FIX_COOLDOWN_MS for the same server.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data/servers');
const FIX_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per kind per server

// ── Diagnostic patterns ───────────────────────────────────────────────────────
// Each pattern returns the fix kind ('port'|'jar'|'world'|'plugin') or null.
// Order matters: more specific patterns first.

// Order matters: plugin patterns BEFORE jar patterns so a "Could not load
// plugin Foo: ClassNotFoundException..." line is diagnosed as a plugin issue
// (specific) rather than a generic JAR issue.
const PATTERNS = [
  {
    kind: 'port',
    re: /Address already in use|BindException|FAILED TO BIND TO PORT|bind to 0\.0\.0\.0|bind\(\) failed|Perhaps a server is already running/i,
    name: 'port collision',
  },
  {
    kind: 'plugin',
    // Bukkit/Paper prints this when a plugin throws during onEnable. The plugin
    // name follows "plugin " and is one identifier (letters/digits/dot/dash/_),
    // terminated by quote/space/colon. Lookahead anchors without consuming.
    re: /Could not (?:load|enable) plugin (?:['"])?([\w.\-]+)(?=['"]|\s|:|$)/i,
    name: 'plugin crash on enable',
  },
  {
    kind: 'plugin',
    // Requires the "vX.Y" version tag to avoid false-matching JVM messages like
    // "Error: LinkageError occurred while loading main class".
    re: /Error occurred (?:while|during) (?:enabling|loading) ([\w.\-]+)\s+v[\d.]+/i,
    name: 'plugin init error',
  },
  {
    kind: 'libs',
    // Paperclip extracts bundled libraries to ./libraries/ on first boot. If
    // any file there is truncated or partially-written (disk pressure, OOM
    // mid-extract, crash) it bombs with "Hash check failed for extract" and
    // the JVM exits before the world ever loads. Fix is to wipe the whole
    // libraries/ tree so Paperclip re-extracts fresh on the next start.
    re: /Hash check failed for extract|io\.papermc\.paperclip\.FileEntry\.extractFile|paperclip\.Paperclip\.extractEntries/,
    name: 'corrupt Paperclip libraries cache',
  },
  {
    kind: 'jar',
    re: /UnsupportedClassVersionError|class file version \d+\.\d+|Unrecognized option|Could not find or load main class|Invalid or corrupt jarfile|Error: LinkageError|NoSuchMethodError/i,
    name: 'bad / corrupt JAR',
  },
  {
    kind: 'world',
    re: /Failed to read chunk|Region file .* is corrupt|ChunkSerializer|EOFException.*\.mca|Corrupted chunk|Invalid chunk found|Bad packet id|Could not read region file/i,
    name: 'corrupt world data',
  },
];

// Returns { kind, name, pluginName? } or null if nothing matched.
function diagnose(logLines) {
  const window = logLines.slice(-150).join('\n'); // scan last ~150 lines
  for (const p of PATTERNS) {
    const m = window.match(p.re);
    if (m) {
      return { kind: p.kind, name: p.name, pluginName: m[1] || null };
    }
  }
  return null;
}

// ── Fixes ────────────────────────────────────────────────────────────────────

async function fixPort(server, db) {
  // Reallocate an unused port from the same range. The JVM controller already
  // re-reads server.port from the row on restart, so just updating the DB
  // is enough.
  const USED = new Set(
    db.prepare('SELECT port FROM servers WHERE id != ?').all(server.id).map(r => r.port).filter(Boolean)
  );
  const MIN = 25565, MAX = 25999;
  let next = null;
  for (let p = MIN; p <= MAX; p++) {
    if (!USED.has(p) && p !== server.port) { next = p; break; }
  }
  if (!next) throw new Error('no free ports in range');
  db.prepare('UPDATE servers SET port = ? WHERE id = ?').run(next, server.id);
  return { from: server.port, to: next };
}

async function fixJar(server) {
  // Wipe server.jar so the controller re-downloads it on next start.
  const jarPath = path.join(DATA_DIR, server.id, 'server.jar');
  if (fs.existsSync(jarPath)) {
    await fsp.unlink(jarPath);
    return { jar: 'deleted', will: 're-download on next start' };
  }
  return { jar: 'already missing' };
}

async function fixLibs(server) {
  // Paperclip refuses to start if any file under libraries/ has a hash mismatch.
  // Wipe the whole tree (and the version-bundle dir while we're at it — that
  // can carry the same staleness). Paperclip will re-extract everything from
  // the bundled JAR on next start in ~5 seconds.
  const base = path.join(DATA_DIR, server.id);
  const removed = [];
  for (const sub of ['libraries', 'versions']) {
    const p = path.join(base, sub);
    if (fs.existsSync(p)) {
      try { await fsp.rm(p, { recursive: true, force: true }); removed.push(sub); }
      catch (err) { return { error: `rm ${sub}/ failed: ${err.message}` }; }
    }
  }
  if (removed.length === 0) return { libs: 'already clean' };
  return { libs: 'wiped', dirs: removed, will: 'Paperclip re-extracts on next start' };
}

async function fixWorld(server) {
  // Move corrupt region files aside (.mca → .mca.corrupt-<ts>). Don't delete
  // the world — let the user restore from backup if needed.
  const worldDir = path.join(DATA_DIR, server.id, 'world', 'region');
  if (!fs.existsSync(worldDir)) return { moved: 0, note: 'no region dir' };
  const ts = Date.now();
  const entries = await fsp.readdir(worldDir);
  let moved = 0;
  for (const e of entries) {
    if (!e.endsWith('.mca')) continue;
    const full = path.join(worldDir, e);
    try {
      const st = await fsp.stat(full);
      // Very small region files are usually corrupt (valid ones are >4KB minimum).
      if (st.size > 0 && st.size < 4096) {
        await fsp.rename(full, full + `.corrupt-${ts}`);
        moved++;
      }
    } catch {}
  }
  return { moved, note: moved ? 'truncated region files quarantined' : 'no obvious corruption found' };
}

async function fixPlugin(server, pluginName) {
  // Disable the offending plugin so the server can boot. We don't delete it —
  // the user can re-enable from the file manager.
  if (!pluginName) return { skipped: 'no plugin name parsed' };
  const pluginsDir = path.join(DATA_DIR, server.id, 'plugins');
  if (!fs.existsSync(pluginsDir)) return { skipped: 'no plugins dir' };
  const wanted = pluginName.toLowerCase();
  const entries = await fsp.readdir(pluginsDir);
  let disabled = null;
  for (const e of entries) {
    const base = e.toLowerCase().replace(/\.jar$/, '');
    if (e.toLowerCase().endsWith('.jar') && (base === wanted || base.startsWith(wanted) || wanted.startsWith(base))) {
      const from = path.join(pluginsDir, e);
      const to = path.join(pluginsDir, e + '.disabled');
      await fsp.rename(from, to);
      disabled = e;
      break;
    }
  }
  return disabled ? { disabled } : { skipped: `no matching .jar for "${pluginName}"` };
}

// ── Public entrypoint ─────────────────────────────────────────────────────────
// Inspects server state + logs; if a fixable error pattern matches AND the
// per-kind cooldown is clear, applies the fix and returns a summary the
// caller can use to log + audit.
// Returns null if nothing fixable was detected.
//
// `deps` must provide: { db, audit }
async function tryAutoFix(server, logLines, deps) {
  const { db, audit } = deps;
  if (!Array.isArray(logLines) || logLines.length === 0) return null;

  const dx = diagnose(logLines);
  if (!dx) return null;

  // Cooldown — don't apply the same kind twice within FIX_COOLDOWN_MS.
  const now = Date.now();
  if (server.last_auto_fix_kind === dx.kind && server.last_auto_fix_at && (now - server.last_auto_fix_at) < FIX_COOLDOWN_MS) {
    return { skipped: true, reason: 'cooldown', kind: dx.kind, since_ms: now - server.last_auto_fix_at };
  }

  let detail = null;
  try {
    if      (dx.kind === 'port')   detail = await fixPort(server, db);
    else if (dx.kind === 'libs')   detail = await fixLibs(server);
    else if (dx.kind === 'jar')    detail = await fixJar(server);
    else if (dx.kind === 'world')  detail = await fixWorld(server);
    else if (dx.kind === 'plugin') detail = await fixPlugin(server, dx.pluginName);
    else return null;
  } catch (err) {
    return { kind: dx.kind, ok: false, error: err.message };
  }

  db.prepare('UPDATE servers SET last_auto_fix_kind = ?, last_auto_fix_at = ? WHERE id = ?')
    .run(dx.kind, now, server.id);
  if (audit) audit(server.user_id, 'server.auto_fix', server.id, null, { kind: dx.kind, detail, diagnosis: dx.name });

  return { ok: true, kind: dx.kind, diagnosis: dx.name, detail, pluginName: dx.pluginName || undefined };
}

module.exports = { tryAutoFix, diagnose, PATTERNS };
