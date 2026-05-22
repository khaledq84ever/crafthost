const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/crafthost.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migration: user JAR library (custom server JARs)
db.exec(`
  CREATE TABLE IF NOT EXISTS jars (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT,
    storage_path TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jars_user ON jars(user_id);
`);

// Migration: per-user server slot number + public-port flag
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}
if (!hasColumn('servers', 'user_slot')) {
  db.exec(`ALTER TABLE servers ADD COLUMN user_slot INTEGER NOT NULL DEFAULT 1`);
  // Backfill: assign slots per-user in creation order
  const users = db.prepare(`SELECT DISTINCT user_id FROM servers`).all();
  for (const { user_id } of users) {
    const rows = db.prepare(`SELECT id FROM servers WHERE user_id = ? ORDER BY created_at`).all(user_id);
    rows.forEach((r, i) => db.prepare(`UPDATE servers SET user_slot = ? WHERE id = ?`).run(i + 1, r.id));
  }
}
if (!hasColumn('servers', 'is_public')) {
  db.exec(`ALTER TABLE servers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0`);
}

// Per-server Railway TCP proxy info — each MC server can have its own external
// host:port pair via Railway's tcpProxyCreate API. Stored so we can reuse the
// allocation on restart instead of re-provisioning.
if (!hasColumn('servers', 'proxy_id')) {
  db.exec(`ALTER TABLE servers ADD COLUMN proxy_id TEXT`);
}
if (!hasColumn('servers', 'proxy_host')) {
  db.exec(`ALTER TABLE servers ADD COLUMN proxy_host TEXT`);
}
if (!hasColumn('servers', 'proxy_port')) {
  db.exec(`ALTER TABLE servers ADD COLUMN proxy_port INTEGER`);
}

// Per-server TCP tunnel address (bore.pub or similar). Each running MC server
// has a real public host:port that friends can paste into the Minecraft client.
if (!hasColumn('servers', 'tunnel_host')) {
  db.exec(`ALTER TABLE servers ADD COLUMN tunnel_host TEXT`);
}
if (!hasColumn('servers', 'tunnel_port')) {
  db.exec(`ALTER TABLE servers ADD COLUMN tunnel_port INTEGER`);
}

// Auto-heal timestamp — the platform records when it auto-swapped a free-plan
// server from a heavy JAR to Paper 1.20.1 after detecting OOM, so it doesn't
// keep trying the same heal in a loop.
if (!hasColumn('servers', 'auto_healed_at')) {
  db.exec(`ALTER TABLE servers ADD COLUMN auto_healed_at INTEGER`);
}

// Auto-restart bookkeeping — the platform tries to revive crashed servers
// (non-OOM, non-user-stop) and limits retries via a count + cooldown window.
if (!hasColumn('servers', 'last_auto_restart_at')) {
  db.exec(`ALTER TABLE servers ADD COLUMN last_auto_restart_at INTEGER`);
}
if (!hasColumn('servers', 'auto_restart_count')) {
  db.exec(`ALTER TABLE servers ADD COLUMN auto_restart_count INTEGER NOT NULL DEFAULT 0`);
}

// Broader auto-fix tracking: latest fix kind ('port'|'jar'|'world'|'plugin') and
// timestamp. Lets the health-check + dashboard show "✓ auto-fixed by CraftHost"
// pills, and lets the auto-fix loop enforce a per-kind cooldown so a stuck
// problem doesn't loop fix-restart-fix-restart forever.
if (!hasColumn('servers', 'last_auto_fix_kind')) {
  db.exec(`ALTER TABLE servers ADD COLUMN last_auto_fix_kind TEXT`);
}
if (!hasColumn('servers', 'last_auto_fix_at')) {
  db.exec(`ALTER TABLE servers ADD COLUMN last_auto_fix_at INTEGER`);
}

// Idle-stop bookkeeping. The dashboard shows "💤 Auto-stopped — start to resume"
// when last_idle_stop_at is recent so users understand why their server isn't
// online (vs a crash).
if (!hasColumn('servers', 'last_idle_stop_at')) {
  db.exec(`ALTER TABLE servers ADD COLUMN last_idle_stop_at INTEGER`);
}

// Scheduled daily restart. Stored as "HH:MM" (24h UTC) or NULL to disable.
// The loop in server.js checks once per minute and triggers a graceful restart
// at the match. last_scheduled_restart_at tracks the last fire so we don't
// repeat within the same minute on slow polls.
if (!hasColumn('servers', 'scheduled_restart_at')) {
  db.exec(`ALTER TABLE servers ADD COLUMN scheduled_restart_at TEXT`);
}
if (!hasColumn('servers', 'last_scheduled_restart_at')) {
  db.exec(`ALTER TABLE servers ADD COLUMN last_scheduled_restart_at INTEGER`);
}

// Password reset tokens
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);
`);

// Single plan — Free, 512 MB. All previous tiers (dirt/stone/iron/diamond/
// netherite) removed per user request. Existing servers on those tiers stay
// (the rows aren't deleted, just hidden from /api/plans below).
// Format: [id, name, price_cents, ram_mb, cpu_cores, storage_gb, max_players, plugin_slots, backups_count]
// Single Free plan. 3 GB RAM (~2.4 GB heap + 0.6 GB JVM overhead) — handles
// Paper 1.21+ + heavy modpacks comfortably. 3 vCPU, 10 GB storage, 50 player
// slots, unlimited plugins, 30-day backup retention.
// Format: [id, name, price_cents, ram_mb, cpu_cores, storage_gb, max_players, plugin_slots, backups_count]
const seedPlans = [
  ['free', 'Free', 0, 3072, 3, 10, 50, -1, 30],
];
// Mark the deprecated tiers as hidden so they don't show on /api/plans or in
// the wizard, while existing servers on them keep working until their owners
// migrate. (We add a "hidden" column below if needed.)
const DEPRECATED_PLAN_IDS = ['dirt', 'stone', 'iron', 'diamond', 'netherite'];
const upsertPlan = db.prepare(`
  INSERT INTO plans (id, name, price_cents, ram_mb, cpu_cores, storage_gb, max_players, plugin_slots, backups_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, price_cents=excluded.price_cents, ram_mb=excluded.ram_mb,
    cpu_cores=excluded.cpu_cores, storage_gb=excluded.storage_gb,
    max_players=excluded.max_players, plugin_slots=excluded.plugin_slots,
    backups_count=excluded.backups_count
`);
seedPlans.forEach(p => upsertPlan.run(...p));

// Add a "hidden" column to plans (0 = visible, 1 = hidden from public listings).
// Idempotent migration. Then mark all deprecated tiers as hidden.
if (!hasColumn('plans', 'hidden')) {
  db.exec(`ALTER TABLE plans ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
}
// Reset visibility every boot so the source of truth is this file:
db.prepare('UPDATE plans SET hidden = 0').run();
const hidePlan = db.prepare('UPDATE plans SET hidden = 1 WHERE id = ?');
DEPRECATED_PLAN_IDS.forEach(id => hidePlan.run(id));

module.exports = db;
