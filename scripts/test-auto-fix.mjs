#!/usr/bin/env node
// Unit tests for backend/lib/auto-fix.js diagnose() pattern matching.
// Pure logic — no network needed. Run: node scripts/test-auto-fix.mjs

import { diagnose } from '../backend/lib/auto-fix.js';

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
let pass = 0, fail = 0;
function check(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ${G('✓')} ${name}`); pass++; }
  else { console.log(`  ${R('✗')} ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); fail++; }
}

// ── Port collision patterns ───────────────────────────────────────────────────
console.log(`${Y('▶')} Port collision`);
check(diagnose([
  '[12:00:00] INFO: Starting Minecraft server',
  '[12:00:01] WARN: **** FAILED TO BIND TO PORT!',
  '[12:00:01] WARN: The exception was: java.net.BindException: Address already in use',
])?.kind, 'port', 'FAILED TO BIND TO PORT');

check(diagnose([
  'Caused by: java.net.BindException: Cannot assign requested address: bind',
])?.kind, 'port', 'BindException');

check(diagnose([
  'Perhaps a server is already running on that port?',
])?.kind, 'port', 'Perhaps a server is already running');

// ── Bad JAR patterns ─────────────────────────────────────────────────────────
console.log(`${Y('▶')} Bad/corrupt JAR`);
check(diagnose([
  'Error: LinkageError occurred while loading main class',
  'java.lang.UnsupportedClassVersionError: net/minecraft/server/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0)',
])?.kind, 'jar', 'UnsupportedClassVersionError');

check(diagnose([
  'Error: Unable to access jarfile server.jar',
  'Invalid or corrupt jarfile server.jar',
])?.kind, 'jar', 'Invalid or corrupt jarfile');

check(diagnose([
  'Exception in thread "main" java.lang.NoSuchMethodError: org.bukkit.Server.getOnlinePlayers()[Lorg/bukkit/entity/Player;',
])?.kind, 'jar', 'NoSuchMethodError');

// ── Corrupt world patterns ───────────────────────────────────────────────────
console.log(`${Y('▶')} Corrupt world`);
check(diagnose([
  '[Server thread/ERROR]: Failed to read chunk [-1, 3]',
  'java.io.EOFException: Reached end of stream while reading region file /data/world/region/r.0.0.mca',
])?.kind, 'world', 'EOFException on .mca');

check(diagnose([
  'Region file r.-1.0.mca is corrupt — chunk 5 has invalid length',
])?.kind, 'world', 'Region file is corrupt');

// ── Plugin crash patterns ────────────────────────────────────────────────────
console.log(`${Y('▶')} Plugin crash`);
const p1 = diagnose([
  '[Server] Loading plugin LuckPerms v5.5.17',
  '[Server] Could not enable plugin LuckPerms v5.5.17: SQLite database locked',
]);
check(p1?.kind, 'plugin', 'Could not enable plugin LuckPerms — kind');
check(p1?.pluginName, 'LuckPerms', 'Could not enable plugin LuckPerms — name extracted');

const p2 = diagnose([
  "Error occurred while enabling EssentialsX v2.20.1 (Is it up to date?)",
]);
check(p2?.kind, 'plugin', 'Error occurred while enabling — kind');
check(p2?.pluginName, 'EssentialsX', 'Error occurred while enabling — name extracted');

// ── No match — must return null ──────────────────────────────────────────────
console.log(`${Y('▶')} Healthy logs return null`);
check(diagnose([
  '[12:00:00] INFO: Starting Minecraft server version 1.20.1',
  '[12:00:08] INFO: Done (7.8s)! For help, type "help"',
  '[12:00:09] INFO: TPS: 20.0',
]), null, 'healthy boot logs return null');

check(diagnose([]), null, 'empty log array returns null');

// ── ClassNotFoundException for a plugin should be plugin not jar ─────────────
console.log(`${Y('▶')} Disambiguation`);
check(diagnose([
  'Could not load plugin TestPlugin v1.0.0: java.lang.ClassNotFoundException: com.test.TestMain',
])?.kind, 'plugin', 'Plugin-context ClassNotFoundException is plugin, not jar');

// ── Most-recent line wins (or at least matches): scan-window ─────────────────
console.log(`${Y('▶')} Scans the recent log window`);
const oldThenFresh = [
  ...Array(200).fill('[INFO] all good'),
  '[ERROR] java.net.BindException: Address already in use',
];
check(diagnose(oldThenFresh)?.kind, 'port', 'bind exception buried under 200 healthy lines is still found');

console.log(`\n─── Summary ───`);
console.log(`${pass} pass, ${fail} fail · ${fail === 0 ? G('PASS') : R('FAIL')}`);
process.exit(fail === 0 ? 0 : 1);
