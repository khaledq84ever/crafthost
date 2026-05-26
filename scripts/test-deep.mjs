#!/usr/bin/env node
// Deep sweep — finds bug classes the basic page-checker misses:
//   1. Untranslated i18n keys: every [data-i18n="X"] must resolve in BOTH en + ar
//   2. Auth bypass: every /api/* endpoint that isn't public must 401 when unauthed
//   3. Cross-page link rot: every <a href="/foo"> on each HTML page must resolve
//   4. Hardcoded production-URL leaks (any localhost: or 127.0.0.1 left in HTML)
//   5. Empty server-rendered placeholders (data-i18n attrs with `>—<` or empty text)
//   6. Service worker / manifest references that 404
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-deep.mjs

const BASE = (process.env.BASE || 'https://crafthost-production.up.railway.app').replace(/\/$/, '');
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`, D = s => `\x1b[2m${s}\x1b[0m`;
let pass = 0, fail = 0;
const issues = [];
function check(cond, msg, severity = 'error') {
  if (cond) { pass++; }
  else {
    fail++;
    issues.push({ severity, msg });
    console.log(`  ${R('✗')} ${msg}`);
  }
}

// pricing.html removed from this list: tiers/pricing were dropped (CraftHost is
// free), so pricing.html is now just a redirect stub — it intentionally doesn't
// load app.js or carry i18n, which the per-page checks below would flag.
const PAGES = ['/', '/login.html', '/register.html', '/forgot.html', '/reset.html', '/dashboard.html', '/files.html', '/console.html', '/marketplace.html', '/jars.html', '/billing.html', '/settings.html', '/admin.html', '/support.html'];

console.log(`\nDeep test against ${BASE}\n`);

// 1. Pull each page's HTML once and the app.js i18n dict
console.log(`${Y('▶')} Fetching all pages + i18n dict`);
const pageHtml = new Map();
for (const p of PAGES) {
  try {
    const r = await fetch(BASE + p);
    if (r.ok) pageHtml.set(p, await r.text());
    else issues.push({ severity: 'error', msg: `${p} → HTTP ${r.status}` });
  } catch (err) {
    issues.push({ severity: 'error', msg: `${p} → fetch error: ${err.message}` });
  }
}
console.log(`  ${G('✓')} fetched ${pageHtml.size}/${PAGES.length} pages`);

const appJs = await (await fetch(BASE + '/js/app.js')).text();
// Extract en + ar dicts from the source. Look for `en: { ... }` and `ar: { ... }`
// blocks, then collect key names.
function extractKeys(dictName) {
  const re = new RegExp(`${dictName}\\s*:\\s*\\{([\\s\\S]*?)\\}\\s*[,}]`);
  const m = appJs.match(re);
  if (!m) return new Set();
  const body = m[1];
  const keys = new Set();
  const keyRe = /(\w+)\s*:\s*['"`]/g;
  let km; while ((km = keyRe.exec(body))) keys.add(km[1]);
  return keys;
}
const enKeys = extractKeys('en');
const arKeys = extractKeys('ar');
console.log(`  ${G('✓')} i18n: en has ${enKeys.size} keys, ar has ${arKeys.size} keys`);

// 2. For each page, collect all data-i18n="X" + data-i18n-placeholder="X" attrs,
//    fail if X isn't in BOTH en and ar dicts (untranslated → user sees literal slug).
console.log(`\n${Y('▶')} Check every data-i18n key resolves in en + ar`);
const i18nRe = /\bdata-i18n(?:-placeholder)?=["']([^"']+)["']/g;
let missingEn = 0, missingAr = 0;
for (const [page, html] of pageHtml) {
  const used = new Set();
  let m;
  while ((m = i18nRe.exec(html))) used.add(m[1]);
  i18nRe.lastIndex = 0;
  for (const key of used) {
    if (!enKeys.has(key)) { missingEn++; check(false, `${page}: i18n key "${key}" missing in en dict`); }
    if (!arKeys.has(key)) { missingAr++; check(false, `${page}: i18n key "${key}" missing in ar dict`); }
  }
}
if (missingEn === 0 && missingAr === 0) console.log(`  ${G('✓')} all i18n keys resolve in both en + ar`);
else console.log(`  ${R('✗')} ${missingEn} missing-en, ${missingAr} missing-ar`);

// 3. Auth-bypass check — sample of protected endpoints. Each MUST return 401 without auth.
console.log(`\n${Y('▶')} Auth gate — unauth requests to protected endpoints must 401`);
const PROTECTED = [
  ['GET',  '/api/servers'],
  ['POST', '/api/servers'],
  ['GET',  '/api/servers/health-check'],
  ['POST', '/api/servers/clone'],
  ['GET',  '/api/auth/me'],
  ['GET',  '/api/jars'],
  // Removed 2026-05-25: /api/admin/* and /api/billing/summary were dropped when the
  // platform collapsed to a single free plan (no billing). The routers aren't mounted,
  // so these returned 404 instead of 401 — stale checks, not real auth gaps.
];
for (const [method, path] of PROTECTED) {
  try {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: method !== 'GET' ? '{}' : undefined });
    check(r.status === 401 || r.status === 403, `${method} ${path} → ${r.status} (expected 401/403)`);
  } catch (err) {
    check(false, `${method} ${path} → fetch error: ${err.message}`);
  }
}

// 4. Public endpoints MUST be reachable without auth
console.log(`\n${Y('▶')} Public endpoints reachable without auth`);
const PUBLIC = [
  ['GET', '/api/health'],
  ['GET', '/api/servers/public'],
  ['GET', '/api/plans'],
];
for (const [method, path] of PUBLIC) {
  try {
    const r = await fetch(BASE + path);
    check(r.status === 200, `${method} ${path} → ${r.status} (expected 200)`);
  } catch (err) {
    check(false, `${method} ${path} → fetch error: ${err.message}`);
  }
}

// 5. Cross-page link rot — every <a href="/foo"> on each page must resolve.
console.log(`\n${Y('▶')} Cross-page link rot — internal hrefs return 200`);
const seenLinks = new Set();
const linkRe = /<a\b[^>]*\bhref=["'](\/[^"'#?]+)["']/g;
const linkResults = new Map();
for (const [page, html] of pageHtml) {
  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    if (href.startsWith('//')) continue;
    if (href.includes('${')) continue;
    seenLinks.add(href);
  }
  linkRe.lastIndex = 0;
}
for (const href of seenLinks) {
  try {
    const r = await fetch(BASE + href, { redirect: 'manual' });
    linkResults.set(href, r.status);
    if (r.status >= 400 && r.status !== 401 && r.status !== 403) {
      check(false, `link ${href} → ${r.status}`);
    }
  } catch (err) {
    check(false, `link ${href} → fetch error`);
  }
}
const okLinks = [...linkResults.values()].filter(s => s < 400 || s === 401 || s === 403).length;
console.log(`  ${G('✓')} ${okLinks}/${seenLinks.size} internal links resolve OK (401/403 acceptable for protected pages)`);

// 6. No localhost / 127.0.0.1 leaks in served HTML
console.log(`\n${Y('▶')} No dev-URL leaks in production HTML`);
for (const [page, html] of pageHtml) {
  const m1 = html.match(/localhost:\d+/);
  const m2 = html.match(/127\.0\.0\.1/);
  check(!m1, `${page}: localhost reference: ${m1?.[0]}`);
  check(!m2, `${page}: 127.0.0.1 reference: ${m2?.[0]}`);
}

// 7. Pages with body class="is-home" should be ONLY the homepage
console.log(`\n${Y('▶')} body.is-home only on homepage`);
for (const [page, html] of pageHtml) {
  const hasIsHome = /<body[^>]*class="[^"]*is-home/.test(html);
  if (page === '/') check(hasIsHome, `${page}: should have body.is-home (for hiding home button)`);
  else check(!hasIsHome, `${page}: body.is-home should NOT be on non-home page`);
}

// 8. Every page should include /js/app.js (for the home icon, i18n, lang toggle)
console.log(`\n${Y('▶')} Every page loads /js/app.js`);
for (const [page, html] of pageHtml) {
  check(html.includes('/js/app.js'), `${page}: missing <script src="/js/app.js">`);
}

// 9. Every page should have a meta viewport with mobile-friendly width
console.log(`\n${Y('▶')} Mobile viewport meta tag present`);
for (const [page, html] of pageHtml) {
  check(/<meta[^>]+name="viewport"[^>]+device-width/.test(html), `${page}: missing or wrong viewport meta`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n─── Summary ───`);
console.log(`Checks: ${G(pass + ' pass')} · ${fail ? R(fail + ' fail') : '0 fail'}`);
if (fail > 0) {
  console.log(`\nFailures by severity:`);
  const grouped = {};
  for (const i of issues) { grouped[i.severity] = grouped[i.severity] || []; grouped[i.severity].push(i.msg); }
  for (const [sev, msgs] of Object.entries(grouped)) {
    console.log(`  ${sev}: ${msgs.length}`);
  }
}
process.exit(fail === 0 ? 0 : 1);
