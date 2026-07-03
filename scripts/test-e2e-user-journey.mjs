// Full-site user journey, driven like a REAL user in a real browser:
//   register → dashboard (card renders, every card-menu modal opens+closes,
//   stop/start button works) → console (stream + send command, read output)
//   → files (tree loads, open server.properties in editor) → marketplace
//   (feed loads, search works) → jars (every engine's version list loads)
//   → settings (profile prefilled, password modal opens) → logout → login.
//
// Fails on: any page JS error, any 5xx response, any modal that doesn't
// appear after its trigger click, any missing content.
// Also records per-page transfer weight (bytes over the wire, per doc+subresources).
//
// Usage:
//   local: BASE=http://localhost:4123 node scripts/test-e2e-user-journey.mjs
//   live:  BASE=https://crafthost-production.up.railway.app node scripts/test-e2e-user-journey.mjs
//   SHOTS=1 to save per-step screenshots next to the run (scratch dir via SHOT_DIR).
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:4123";
const SHOTS = process.env.SHOTS === "1";
const SHOT_DIR = process.env.SHOT_DIR || "journey-shots";
const rand = Math.random().toString(36).slice(2, 8);
const USER = `journey${rand}`;
const PASS = "E2e-test-12345";

let pass = 0, fail = 0;
const expect = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};
const step = (s) => console.log("── " + s);

if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
const shot = async (label) => {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, "0")}-${label}.png`, fullPage: false });
};

const jsErrors = [];   // { page, text }
const badResponses = []; // { url, status }
const pageWeight = {}; // path -> bytes
let currentPage = "(boot)";

// MOBILE=1 runs the whole journey at phone size (iPhone-ish 390x844, touch).
const MOBILE = process.env.MOBILE === "1";
const browser = await chromium.launch();
const ctx = await browser.newContext(
  MOBILE
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" }
    : { viewport: { width: 1280, height: 800 } },
);
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") jsErrors.push({ page: currentPage, text: m.text().slice(0, 200) }); });
page.on("pageerror", (e) => jsErrors.push({ page: currentPage, text: "PAGEERROR: " + e.message.slice(0, 200) }));
page.on("dialog", (d) => d.accept());
page.on("response", async (r) => {
  if (r.status() >= 500) badResponses.push({ url: r.url().slice(0, 120), status: r.status() });
  try {
    const sizes = await r.request().sizes();
    pageWeight[currentPage] = (pageWeight[currentPage] || 0) + sizes.responseBodySize + sizes.responseHeadersSize;
  } catch { /* request context gone — fine */ }
});

const goto = async (path, label) => {
  currentPage = label || path;
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
};

async function apiCall(path, opts = {}) {
  return page.evaluate(async ({ path, opts }) => {
    const r = await fetch(path, {
      method: opts.method || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { path, opts });
}

// Click a card-menu item by its visible label; assert the modal opens
// (.modal-bg.show); close it with Escape (global handler) and assert it
// actually closed — a stuck overlay would wedge the rest of the journey.
async function menuModal(sid, label, id) {
  await page.click(`.sc-menu-btn`);
  await page.waitForTimeout(300);
  const item = page.locator(`#sc-menu-${sid} button[role="menuitem"]`, { hasText: label });
  if ((await item.count()) === 0) { expect(`menu item "${label}" exists`, false); return; }
  await item.first().click();
  let visible = false;
  try { await page.waitForSelector(`#${id}`, { state: "visible", timeout: 8000 }); visible = true; } catch {}
  expect(`"${label}" opens #${id}`, visible);
  await shot(label.toLowerCase().replace(/[^a-z]+/g, "-"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const stillOpen = await page.evaluate(() =>
    [...document.querySelectorAll(".modal-bg.show, .modal-bg.open, .modal.show, .modal-host")]
      .filter((el) => getComputedStyle(el).display !== "none").length);
  expect(`"${label}" closes on Escape`, stillOpen === 0);
  if (stillOpen) await page.evaluate((mid) => {
    const el = document.getElementById(mid);
    if (el) { el.classList.remove("show"); el.style.display = "none"; }
  }, id);
  await page.waitForTimeout(300);
}

let exitCode = 1;
let sid = null;
try {
  // ── 1) Register (auto-creates + auto-starts a starter server) ──────────
  step(`register ${USER} on ${BASE}`);
  await goto("/register.html", "/register.html");
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="email"]', `${USER}@e2e.local`);
  await page.fill('input[name="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 20000 });
  expect("register lands on dashboard", true);

  // ── 2) Dashboard: card renders, server goes online ──────────────────────
  step("dashboard: starter card renders and boots");
  currentPage = "/dashboard.html";
  await page.waitForSelector(".server-card, .sc-actions", { timeout: 20000 }).catch(() => {});
  const list = await apiCall("/api/servers");
  sid = list.body?.servers?.[0]?.id;
  expect("starter server exists", !!sid, sid);
  // Local dev boxes with Java 17 can't boot the default starter version
  // (1.21+ needs Java 21) — SOFT_BOOT=1 downgrades the online check to a
  // warning so the rest of the journey (modals, pages) still gets exercised.
  const SOFT_BOOT = process.env.SOFT_BOOT === "1";
  const bootWait = SOFT_BOOT ? 45000 : 180000;
  const t0 = Date.now();
  let online = false;
  while (Date.now() - t0 < bootWait) {
    const st = await apiCall(`/api/servers/${sid}/status`);
    if (st.body?.status === "online") { online = true; break; }
    await page.waitForTimeout(3000);
  }
  if (SOFT_BOOT && !online) console.log("  ! starter not online (SOFT_BOOT) — continuing anyway");
  else expect("starter server reaches online", online, `${Math.round((Date.now() - t0) / 1000)}s`);
  // card should show a primary action button (Stop when online, Start when not)
  await page.waitForTimeout(4000); // one poll tick
  const primaryBtn = await page.locator(".sc-primary").count();
  expect("card shows primary action button", primaryBtn > 0);
  await shot("dashboard-online");

  // ── 3) Dashboard: every card-menu modal opens and closes ───────────────
  step("dashboard: card menu modals");
  await menuModal(sid, "View Logs", "logsModal");
  await menuModal(sid, "Settings", "settingsModal");
  await menuModal(sid, "Change JAR", "swapJarModal");
  // Change JAR must actually list versions (papermc v3 regression guard)
  await page.click(".sc-menu-btn"); await page.waitForTimeout(250);
  await page.locator(`#sc-menu-${sid} button[role="menuitem"]`, { hasText: "Change JAR" }).first().click();
  await page.waitForTimeout(3000);
  const sj = await page.evaluate(() => ({
    types: [...(document.querySelectorAll("#sjType option") || [])].map((o) => o.value),
    versions: document.querySelectorAll("#sjVersion option").length,
  }));
  expect("Change JAR version picker populates", sj.versions > 1, `${sj.versions} options`);
  expect("Change JAR offers neoforge", sj.types.includes("neoforge"), sj.types.join(","));
  await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  await menuModal(sid, "Bedrock", "bedrockModal");
  await menuModal(sid, "Clone server", "cloneModal");
  await menuModal(sid, "Import world.zip", "worldModal");
  await menuModal(sid, "Backups", "backupsModal");
  await menuModal(sid, "Delete server", "delServerModal");

  // ── 4) Console: stream + send command + read output ────────────────────
  step("console: live stream, send command, read echo");
  await goto(`/console.html?id=${sid}`, "/console.html");
  if (!online) {
    console.log("  ! server offline — skipping stream/echo checks");
  } else {
  const streamed = await (async () => {
    const t = Date.now();
    while (Date.now() - t < 30000) {
      const txt = await page.evaluate(() => document.getElementById("term")?.textContent || "");
      if (txt.length > 100) return true;
      await page.waitForTimeout(1500);
    }
    return false;
  })();
  expect("console stream shows log lines", streamed);
  const token = `journey-${rand}`;
  await page.fill("#cmdInput", `say ${token}`);
  await page.press("#cmdInput", "Enter");
  const echoed = await (async () => {
    const t = Date.now();
    while (Date.now() - t < 20000) {
      const txt = await page.evaluate(() => document.getElementById("term")?.textContent || "");
      if (txt.includes(token)) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  })();
  expect("command echo appears in terminal", echoed);
  await shot("console");
  }

  // ── 5) Files: tree loads, open server.properties in editor ─────────────
  step("files: tree + editor");
  await goto(`/files.html?id=${sid}`, "/files.html");
  await page.waitForTimeout(3000);
  const rows = await page.locator("#fmBody .fm-row, #fmBody [data-name]").count();
  expect("file list shows entries", rows > 0, `${rows} rows`);
  const propRow = page.locator("#fmBody", { hasText: "server.properties" });
  if (!online && (await propRow.count()) === 0) {
    console.log("  ! server never booted — server.properties may not exist yet; skipping editor check");
  } else if (await propRow.count()) {
    await page.locator("#fmBody :text('server.properties')").first().click();
    let editorOpen = false;
    try { await page.waitForSelector("#editor", { state: "visible", timeout: 8000 }); editorOpen = true; } catch {}
    expect("server.properties opens in editor", editorOpen);
    if (editorOpen) {
      const content = await page.inputValue("#editorArea").catch(() => "");
      expect("editor shows real file content", /motd|server-port|gamemode/.test(content));
      await page.click("#editorClose");
    }
  } else expect("server.properties visible in file list", false);
  await shot("files");

  // ── 6) Marketplace: feed + search ───────────────────────────────────────
  step("marketplace: feed + search");
  await goto(`/marketplace.html?id=${sid}`, "/marketplace.html");
  await page.waitForTimeout(3500);
  const feedCards = await page.locator(".mp-feed-card").count();
  expect("marketplace feeds render cards", feedCards > 0, `${feedCards} cards`);
  await page.fill("#mpSearch", "essentials");
  await page.waitForTimeout(4000);
  const resCards = await page.locator("#searchRow .mp-feed-card").count();
  expect("marketplace search returns results", resCards > 0, `${resCards} cards`);
  await shot("marketplace");

  // ── 7) Jars: every engine's version list loads ──────────────────────────
  step("jars: version lists per engine");
  await goto("/jars.html", "/jars.html");
  await page.waitForTimeout(4000);
  const verMetas = await page.evaluate(() =>
    [...document.querySelectorAll('[id^="ver_"]')].map((el) => ({ id: el.id.slice(4), text: (el.textContent || "").trim() })));
  expect("official jar grid renders", verMetas.length > 0, `${verMetas.length} engines`);
  for (const v of verMetas) {
    const ok = v.text && !/loading|failed|error/i.test(v.text);
    expect(`versions load: ${v.id}`, ok, v.text.slice(0, 40));
  }
  await shot("jars");

  // ── 8) Settings: profile prefilled, password modal opens ────────────────
  step("settings: profile + password modal");
  await goto("/settings.html", "/settings.html");
  await page.waitForTimeout(2000);
  const uname = await page.inputValue("#fUsername").catch(() => "");
  expect("profile username prefilled", uname === USER, uname);
  const pwBtn = page.locator("button", { hasText: /change password/i }).first();
  if (await pwBtn.count()) {
    await pwBtn.click();
    let pwOpen = false;
    try { await page.waitForSelector("#pwModal", { state: "visible", timeout: 5000 }); pwOpen = true; } catch {}
    expect("password modal opens", pwOpen);
    await page.keyboard.press("Escape");
  }
  await shot("settings");

  // ── 9) Public pages + logout/login round-trip ───────────────────────────
  step("public pages + logout/login");
  for (const p of ["/pricing.html", "/status.html", "/index.html"]) {
    await goto(p, p);
    await page.waitForTimeout(1200);
  }
  expect("public pages load", true);
  await goto("/dashboard.html", "/dashboard.html(logout)");
  await page.click("#logoutBtn");
  await page.waitForURL(/login|index|\/$/, { timeout: 10000 }).catch(() => {});
  await goto("/login.html", "/login.html");
  await page.fill('input[name="username"], input[type="text"], input[type="email"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  let backIn = false;
  try { await page.waitForURL(/dashboard/, { timeout: 15000 }); backIn = true; } catch {}
  expect("logout → login round-trip", backIn);

  // ── 10) No JS errors, no 5xx anywhere in the whole journey ──────────────
  step("global error audit");
  const realJsErrors = jsErrors.filter((e) => !/Failed to load resource/i.test(e.text));
  expect("no page JS errors across journey", realJsErrors.length === 0);
  for (const e of realJsErrors.slice(0, 8)) console.log(`      [${e.page}] ${e.text}`);
  expect("no 5xx responses across journey", badResponses.length === 0);
  for (const b of badResponses.slice(0, 8)) console.log(`      ${b.status} ${b.url}`);

  exitCode = fail === 0 ? 0 : 1;
} catch (err) {
  console.error("FATAL:", err.message);
  fail++;
} finally {
  // cleanup: delete the throwaway account's servers
  try {
    step("cleanup");
    const l = await apiCall("/api/servers");
    for (const s of l.body?.servers || []) {
      const d = await apiCall(`/api/servers/${s.id}`, { method: "DELETE" });
      console.log(`  deleted ${s.name}: ${d.status}`);
    }
  } catch {}
  console.log("\n─── Page weight (transfer, KB) ───");
  for (const [p, bytes] of Object.entries(pageWeight).sort((a, b) => b[1] - a[1]))
    console.log(`  ${(bytes / 1024).toFixed(0).padStart(6)} KB  ${p}`);
  await browser.close();
  console.log(`\n─── User journey: ${pass} pass · ${fail} fail ───`);
  process.exit(exitCode);
}
