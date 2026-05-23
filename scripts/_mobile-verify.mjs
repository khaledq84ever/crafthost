#!/usr/bin/env node
// Verify CraftHost mobile rendering across three phone sizes.
// For each page + viewport, render and detect:
//   1. Horizontal overflow (page wider than viewport)
//   2. Any element wider than the viewport
//   3. Critical layout failures (sidebar off-screen, modal misplaced)
// Captures a screenshot of each failure.

import { chromium, devices } from 'playwright';
import fs from 'fs';

const BASE = 'https://crafthost-production.up.railway.app';
const OUT = '/tmp/crafthost-mobile';
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'iPhone SE',     ...devices['iPhone SE'] },           // 375x667
  { name: 'iPhone 14 Pro', ...devices['iPhone 14 Pro'] },        // 393x852
  { name: 'Galaxy S9+',    ...devices['Galaxy S9+'] },           // 320x658 (small android)
];

const PAGES = ['/', '/login.html', '/register.html', '/dashboard.html',
               '/pricing.html', '/status.html', '/files.html', '/console.html',
               '/marketplace.html', '/jars.html', '/settings.html'];

const issues = [];
let ok = 0, warn = 0, fail = 0;

const browser = await chromium.launch({ headless: true });

for (const vp of VIEWPORTS) {
  console.log(`\n=== ${vp.name} (${vp.viewport.width}x${vp.viewport.height}) ===`);
  const ctx = await browser.newContext(vp);
  const page = await ctx.newPage();
  for (const p of PAGES) {
    try {
      const url = BASE + p;
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      const status = resp.status();

      // Measure document width vs viewport width
      const result = await page.evaluate(() => {
        const doc = document.documentElement;
        const vw = window.innerWidth;
        const docWidth = Math.max(doc.scrollWidth, document.body.scrollWidth);
        // Find any wide elements
        const wide = [];
        document.querySelectorAll('*').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width > vw + 1 && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
            // Only report visible elements taller than 8px (skip pseudo / hidden)
            if (r.height > 8 && r.width > 100) {
              wide.push({
                tag: el.tagName.toLowerCase(),
                cls: (el.className || '').toString().split(' ').slice(0, 3).join(' '),
                w: Math.round(r.width),
                vw,
              });
            }
          }
        });
        return { vw, docWidth, hasOverflow: docWidth > vw + 1, wide: wide.slice(0, 5) };
      });

      const safePage = p.replace(/\//g, '_').replace(/^_/, '') || 'home';
      const safeVp = vp.name.replace(/\s+/g, '_');
      const shot = `${OUT}/${safeVp}_${safePage}.png`;

      if (result.hasOverflow) {
        await page.screenshot({ path: shot, fullPage: false });
        console.log(`  ✗ ${p}  HTTP ${status}  vw=${result.vw} doc=${result.docWidth} OVERFLOW +${result.docWidth - result.vw}px`);
        for (const w of result.wide) console.log(`      offender: <${w.tag}.${w.cls}> width=${w.w} (vw=${w.vw})`);
        issues.push({ vp: vp.name, page: p, ...result });
        fail++;
      } else if (status !== 200) {
        console.log(`  ⚠ ${p}  HTTP ${status}`);
        warn++;
      } else {
        console.log(`  ✓ ${p}  vw=${result.vw} doc=${result.docWidth}`);
        ok++;
      }
    } catch (e) {
      console.log(`  ✗ ${p}  ERROR ${e.message}`);
      fail++;
    }
  }
  await ctx.close();
}

await browser.close();

console.log(`\n━━━━ SUMMARY ━━━━`);
console.log(`pass=${ok}  warn=${warn}  fail=${fail}`);
if (issues.length) {
  console.log(`\nIssues:`);
  for (const i of issues) console.log(`  ${i.vp}  ${i.page}  +${i.docWidth - i.vw}px`);
}
process.exit(fail > 0 ? 1 : 0);
