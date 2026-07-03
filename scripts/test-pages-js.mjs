// Browse every page as a REAL signed-in user and fail on any JS console
// error or pageerror. Complements test-pages.mjs (which checks assets).
// Usage: BASE=<url> node scripts/test-pages-js.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:4123";
const rand = Math.random().toString(36).slice(2, 8);
const PAGES = [
  "/", "/index.html", "/dashboard.html", "/console.html", "/files.html",
  "/marketplace.html", "/jars.html", "/settings.html", "/pricing.html",
  "/status.html", "/login.html", "/register.html", "/forgot.html",
];

const browser = await chromium.launch();
const page = await browser.newPage();
let current = "";
const errsByPage = {};
page.on("console", (m) => {
  if (m.type() === "error") (errsByPage[current] = errsByPage[current] || []).push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => (errsByPage[current] = errsByPage[current] || []).push("PAGEERROR: " + e.message));

// Sign up first so authed pages render their real (non-demo) state.
current = "/register.html(setup)";
await page.goto(BASE + "/register.html", { waitUntil: "networkidle" });
await page.fill('input[name="username"]', `smokepg${rand}`);
await page.fill('input[name="email"]', `smokepg${rand}@e2e.local`);
await page.fill('input[name="password"]', "E2e-test-12345");
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 20000 });

let fail = 0;
for (const p of PAGES) {
  current = p;
  try {
    await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2500);
  } catch (e) {
    (errsByPage[p] = errsByPage[p] || []).push("NAV: " + e.message.slice(0, 120));
  }
  // 4xx resource lines are expected on public pages (auth probes); real JS
  // errors and pageerrors are not.
  const errs = (errsByPage[p] || []).filter((e) => !/Failed to load resource/i.test(e));
  if (errs.length) {
    fail++;
    console.log(`✗ ${p}`);
    errs.slice(0, 4).forEach((e) => console.log(`    ${e}`));
  } else {
    console.log(`✓ ${p}`);
  }
}

// Cleanup the throwaway account's servers.
current = "(cleanup)";
await page.evaluate(async () => {
  const l = await (await fetch("/api/servers", { credentials: "include" })).json();
  for (const s of l.servers || []) await fetch(`/api/servers/${s.id}`, { method: "DELETE", credentials: "include" });
});
await browser.close();
console.log(`\n─── JS-error sweep: ${PAGES.length - fail}/${PAGES.length} clean ───`);
process.exit(fail ? 1 : 0);
