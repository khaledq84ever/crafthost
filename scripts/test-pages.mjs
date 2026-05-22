#!/usr/bin/env node
// Sweeps every HTML page on production. For each page:
//   1. HTTP status (must be 200, must be text/html)
//   2. Pulls every <script src>, <link href>, <img src>, inline <script> body
//   3. Fetches each same-origin asset, fails on 404 / 5xx / wrong content-type
//   4. Validates inline <script> bodies with `new Function(body)` (catches typos)
// Output: per-page pass/fail tree and a final summary. Exit 0 only if everything is green.
//
//   BASE=https://crafthost-production.up.railway.app node scripts/test-pages.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.BASE || 'https://crafthost-production.up.railway.app').replace(/\/$/, '');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(__dirname, '../frontend');

const PAGES = fs.readdirSync(FRONTEND)
  .filter(f => f.endsWith('.html'))
  .map(f => '/' + f);
// Add the index alias too
PAGES.unshift('/');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

const assetCache = new Map(); // url → { status, type, ok }

async function fetchHead(url) {
  if (assetCache.has(url)) return assetCache.get(url);
  try {
    let r = await fetch(url, { method: 'HEAD' });
    // Some static handlers don't implement HEAD — retry with GET
    if (r.status === 405 || r.status === 501) r = await fetch(url, { method: 'GET' });
    const type = r.headers.get('content-type') || '';
    const out = { status: r.status, type, ok: r.ok };
    assetCache.set(url, out);
    return out;
  } catch (err) {
    const out = { status: 0, type: '', ok: false, err: err.message };
    assetCache.set(url, out);
    return out;
  }
}

async function fetchText(url) {
  const r = await fetch(url);
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type') || '', text };
}

function absolutize(href, pageUrl) {
  if (!href) return null;
  if (href.startsWith('data:')) return null;
  if (href.startsWith('//')) return 'https:' + href;
  if (/^https?:/i.test(href)) return href;
  // Anchor / fragment-only
  if (href.startsWith('#')) return null;
  if (href.startsWith('/')) return BASE + href;
  // Relative — resolve against the page URL
  try { return new URL(href, pageUrl).toString(); } catch { return null; }
}

function extractRefs(html) {
  const out = { scripts: [], stylesheets: [], images: [], inlineScripts: [] };
  // <script src=…> and inline <script>…</script>
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const srcM = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (srcM) out.scripts.push(srcM[1]);
    else if (body.trim()) out.inlineScripts.push(body);
  }
  // <link rel=stylesheet href=…>  (only stylesheets — skip preconnect/preload/icon)
  const linkRe = /<link\b([^>]*)>/gi;
  while ((m = linkRe.exec(html))) {
    const attrs = m[1];
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href && /stylesheet/i.test(rel)) out.stylesheets.push(href);
  }
  // <img src=…>
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = imgRe.exec(html))) out.images.push(m[1]);
  return out;
}

function validateInlineScript(body) {
  try { new Function(body); return { ok: true }; }
  catch (err) { return { ok: false, err: err.message }; }
}

// ── Run ───────────────────────────────────────────────────────────────────────
const results = []; // { page, pass, issues: [] }

console.log(`\nSweeping ${PAGES.length} pages on ${BASE}\n`);

for (const pagePath of PAGES) {
  const pageUrl = BASE + pagePath;
  const issues = [];

  // 1. The page itself
  let html = '';
  try {
    const r = await fetchText(pageUrl);
    if (r.status !== 200) issues.push(`page status ${r.status}`);
    if (!/text\/html/i.test(r.type)) issues.push(`wrong content-type: ${r.type}`);
    html = r.text;
  } catch (err) {
    issues.push(`fetch error: ${err.message}`);
    results.push({ page: pagePath, pass: false, issues });
    console.log(`${R('✗')} ${pagePath.padEnd(20)} — ${issues.join('; ')}`);
    continue;
  }

  // 2. Extract references
  const refs = extractRefs(html);
  const ok = (color, msg) => process.stdout.write(`  ${color(msg)}\n`);

  console.log(`${Y('▶')} ${pagePath}  ${D(`(${refs.scripts.length} scripts, ${refs.stylesheets.length} css, ${refs.images.length} img, ${refs.inlineScripts.length} inline)`)}`);

  // 3. Check each asset
  const allRefs = [
    ...refs.scripts.map(s => ({ kind: 'script', href: s, expect: /javascript|ecmascript/i })),
    ...refs.stylesheets.map(s => ({ kind: 'css',    href: s, expect: /text\/css/i })),
    ...refs.images.map(s     => ({ kind: 'img',    href: s, expect: /^image\// })),
  ];
  for (const ref of allRefs) {
    // Skip JS-template placeholders like `${var}` — those resolve at runtime,
    // not at page load, so they're not real static assets.
    if (ref.href.includes('${')) continue;
    const url = absolutize(ref.href, pageUrl);
    if (!url) continue; // anchor / data: / fragment
    // Skip cross-origin asset checks — those depend on third-party uptime
    if (!url.startsWith(BASE)) continue;
    const r = await fetchHead(url);
    if (!r.ok) {
      issues.push(`${ref.kind} ${ref.href} → HTTP ${r.status}`);
      ok(R, `✗ ${ref.kind.padEnd(6)} ${ref.href}  ${R('HTTP ' + r.status)}`);
    } else if (!ref.expect.test(r.type)) {
      issues.push(`${ref.kind} ${ref.href} → wrong type ${r.type}`);
      ok(Y, `⚠ ${ref.kind.padEnd(6)} ${ref.href}  ${Y('type=' + r.type)}`);
    }
  }

  // 4. Inline script syntax check
  for (let i = 0; i < refs.inlineScripts.length; i++) {
    const v = validateInlineScript(refs.inlineScripts[i]);
    if (!v.ok) {
      issues.push(`inline script #${i + 1} syntax: ${v.err}`);
      ok(R, `✗ inline #${i + 1}  ${R(v.err)}`);
    }
  }

  if (issues.length === 0) ok(G, `✓ all good`);
  results.push({ page: pagePath, pass: issues.length === 0, issues });
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n─── Summary ───');
const pass = results.filter(r => r.pass).length;
const tot = results.length;
console.log(`Pages: ${pass}/${tot} ${pass === tot ? G('PASS') : R('FAIL')}`);
if (pass < tot) {
  console.log('\nFailures:');
  for (const r of results.filter(r => !r.pass)) {
    console.log(`  ${R('✗')} ${r.page}`);
    for (const i of r.issues) console.log(`      · ${i}`);
  }
}
console.log(`\nAssets cached: ${assetCache.size} unique URLs checked`);
process.exit(pass === tot ? 0 : 1);
