// Full e2e of the CraftHost start flow against a local instance.
// Measures: console errors, failed API requests, and button DOM stability
// (how often the Start/Stop button element is destroyed) during the
// start → online window.
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:4123";
const rand = Math.random().toString(36).slice(2, 8);
const USER = `smoke${rand}`; // smoke* users are auto-cleaned on server boot
const PASS = "E2e-test-12345";

const consoleErrors = [];
const failedRequests = [];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));
page.on("response", (r) => {
  if (r.status() >= 400 && r.url().includes("/api/"))
    failedRequests.push(`${r.request().method()} ${r.url().replace(BASE, "")} → ${r.status()}`);
});
const dialogs = [];
page.on("dialog", (d) => {
  dialogs.push(d.message().slice(0, 120));
  d.accept();
});
// Sample every /status body: does it carry tps_history?
const statusBodies = [];
page.on("response", async (r) => {
  if (r.url().includes("/status") && r.status() === 200) {
    try {
      const b = await r.json();
      statusBodies.push({
        t: Date.now(),
        st: b.status,
        online: b.stats?.online,
        hist: Array.isArray(b.stats?.tps_history) ? b.stats.tps_history.length : -1,
      });
    } catch {}
  }
});

const step = (s) => console.log("── " + s);

// 1) Register
step("register " + USER);
await page.goto(BASE + "/register.html", { waitUntil: "networkidle" });
await page.fill('input[name="username"]', USER);
await page.fill('input[name="email"]', `${USER}@e2e.local`);
await page.fill('input[name="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 20000 });
console.log("   registered, at " + page.url());

// 2) Create server via API (deterministic; UI wizard covered separately)
step("create server (paper 1.20.1)");
const created = await page.evaluate(async () => {
  const r = await fetch("/api/servers", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E2E Test Server",
      type: "paper",
      version: "1.20.1",
      plan: "free",
      region: "eu",
      skipAutoStart: true,
    }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
});
console.log("   create → " + created.status, JSON.stringify(created.body).slice(0, 200));
if (created.status >= 400) process.exit(2);
const sid = created.body.id;

// 3) Reload dashboard, find the card, click Start
step("dashboard + click Start");
await page.goto(BASE + "/dashboard.html", { waitUntil: "networkidle" });
const card = page.locator(`.server-card[data-id="${sid}"]`);
await card.waitFor({ timeout: 15000 });
const startBtn = card.locator("button.sc-primary");
console.log("   button text:", (await startBtn.textContent()).trim());
await startBtn.click();
// The auto-created starter server holds the single running slot, so this
// click should trigger the running-quota confirm → we accept → the starter
// stops and our server starts. Give that handoff a moment.
await page.waitForTimeout(4000);
console.log("   dialogs so far:", dialogs.length ? dialogs : "none");

// 4) Watch for 120s: track button element identity churn + status pill
step("watch start → online (max 150s)");
await page.evaluate((sid) => {
  window.__patchDebug = [];
  window.__btnDeaths = 0;
  window.__watch = setInterval(() => {
    const card = document.querySelector(`.server-card[data-id="${sid}"]`);
    if (!card) return;
    const btn = card.querySelector("button.sc-primary");
    if (window.__lastBtn && window.__lastBtn !== btn && !document.contains(window.__lastBtn)) window.__btnDeaths++;
    window.__lastBtn = btn;
  }, 250);
}, sid);

let status = "";
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  status = (await card.locator(".sc-status").textContent().catch(() => "")).trim();
  if (/online/i.test(status)) break;
  await page.waitForTimeout(2000);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
const btnDeaths = await page.evaluate(() => { clearInterval(window.__watch); return window.__btnDeaths; });
const patchDebug = await page.evaluate(() => (window.__patchDebug || []).slice(0, 6));
console.log("   full-swap reasons:", patchDebug.length, patchDebug.slice(0, 3));
console.log(`   status="${status}" after ${elapsed}s · primary-button DOM destroyed ${btnDeaths}× during watch`);

// 5) Post-online sanity: stop button present, address shown
const btnText = (await card.locator("button.sc-primary").textContent()).trim();
const ipText = (await card.locator(".sc-ip").first().textContent().catch(() => "(none)")).trim();
console.log("   primary button:", btnText);
console.log("   address row:", ipText.replace(/\s+/g, " ").slice(0, 120));

// 6) Stop the server (Paper shutdown + route roundtrip can take 20s+)
step("click Stop");
await card.locator("button.sc-primary").click();
let afterStop = "";
const t1 = Date.now();
while (Date.now() - t1 < 45000) {
  afterStop = (await card.locator(".sc-status").textContent().catch(() => "")).trim();
  if (/offline/i.test(afterStop)) break;
  await page.waitForTimeout(2000);
}
console.log(`   status after stop: ${afterStop} (${((Date.now() - t1) / 1000).toFixed(0)}s)`);

step("results");
console.log("consoleErrors:", consoleErrors.length ? consoleErrors : "none");
console.log("failedRequests:", failedRequests.length ? failedRequests : "none");
console.log("dialogs:", dialogs);
console.log("status bodies (last 20):", statusBodies.slice(-20).map((b) => `${b.st}/${b.online}/${b.hist}`).join(" "));
console.log(JSON.stringify({ ok: /online/i.test(status), btnDeaths, consoleErrors: consoleErrors.length, failedRequests: failedRequests.length }));
// 7) Cleanup: delete both servers so live runs leave nothing behind
step("cleanup");
const cleanup = await page.evaluate(async () => {
  const list = await (await fetch("/api/servers", { credentials: "include" })).json();
  const out = { idle_stop_minutes: list.idle_stop_minutes, deleted: [] };
  for (const s of list.servers || []) {
    const r = await fetch(`/api/servers/${s.id}`, { method: "DELETE", credentials: "include" });
    out.deleted.push(`${s.name}:${r.status}`);
  }
  return out;
});
console.log("   idle_stop_minutes:", cleanup.idle_stop_minutes, "· deleted:", cleanup.deleted.join(", "));
await browser.close();
