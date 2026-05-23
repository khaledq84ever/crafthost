import { chromium, devices } from 'playwright';
import fs from 'fs';
const OUT = '/tmp/crafthost-shots';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'https://crafthost-production.up.railway.app';
const PAGES = ['/', '/login.html', '/dashboard.html', '/pricing.html', '/status.html'];
const VPS = [
  { name: 'iPhoneSE',    ...devices['iPhone SE'] },
  { name: 'iPhone14Pro', ...devices['iPhone 14 Pro'] },
];
const browser = await chromium.launch({ headless: true });
for (const vp of VPS) {
  const ctx = await browser.newContext(vp);
  const page = await ctx.newPage();
  for (const p of PAGES) {
    await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 20000 });
    const safe = p.replace(/\//g, '_').replace(/^_/, '') || 'home';
    const file = `${OUT}/${vp.name}_${safe}.png`;
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  ${vp.name}  ${p.padEnd(20)} → ${file}`);
  }
  await ctx.close();
}
await browser.close();
console.log('Done.');
