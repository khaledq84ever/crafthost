// Full UI e2e of the in-place upgrade (swap-jar) flow, driven like a real user:
//   register → create → Start (card button) → online → open card menu →
//   "Change JAR" → pick a newer version → Apply → card shows Starting… →
//   online again → card + API show the new version → negative paths → cleanup.
//
// Negative paths exercised THROUGH THE UI:
//   • second Apply while a swap is in flight → inline "Server is busy" error
//   • selecting an older version → inline downgrade warning + "Downgrade anyway"
//   • swapping a stopped server while another runs → inline running-quota error
//
// Usage:
//   local: BASE=http://localhost:4123 UP_FROM=1.19.4 UP_TO=1.20.1 DOWNGRADE_TO=1.16.5 node scripts/test-e2e-upgrade-flow.mjs
//   live:  BASE=https://crafthost-production.up.railway.app node scripts/test-e2e-upgrade-flow.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:4123";
const UP_FROM = process.env.UP_FROM || "1.20.1";
const UP_TO = process.env.UP_TO || "26.1.2";
const DOWNGRADE_TO = process.env.DOWNGRADE_TO || "1.19.4";
const rand = Math.random().toString(36).slice(2, 8);
const USER = `smoke${rand}`; // smoke* users are auto-cleaned on server boot
const PASS = "E2e-test-12345";

let pass = 0,
  fail = 0;
const expect = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
};
const step = (s) => console.log("── " + s);

const consoleErrors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));
page.on("dialog", (d) => d.accept());

async function apiCall(path, opts = {}) {
  return page.evaluate(
    async ({ path, opts }) => {
      const r = await fetch(path, {
        method: opts.method || "GET",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    { path, opts },
  );
}

async function waitCardStatus(card, re, maxMs) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < maxMs) {
    last = (await card.locator(".sc-status").textContent().catch(() => "")).trim();
    if (re.test(last)) return { ok: true, ms: Date.now() - t0 };
    await page.waitForTimeout(2000);
  }
  return { ok: false, last };
}

// Open this card's ⋯ menu and click "Change JAR"; wait for the version list.
// A poll tick can re-patch the card and close the menu mid-click, so retry
// the whole menu → item → modal sequence instead of one long click wait.
async function openSwapModal(card) {
  for (let attempt = 0; ; attempt++) {
    try {
      await card.locator("button.sc-menu-btn").click({ timeout: 3000 });
      await card
        .locator('.sc-menu button:has-text("Change JAR")')
        .click({ timeout: 2000 });
      await page.locator("#swapJarModal.show").waitFor({ timeout: 3000 });
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
  await page.waitForFunction(
    () => {
      const sel = document.getElementById("sjVersion");
      return sel && sel.options.length > 1;
    },
    { timeout: 20000 },
  );
}

let exitCode = 1;
try {
  // ── 1) Register (smoke user) ─────────────────────────────────────────────
  step(`register ${USER} on ${BASE}`);
  await page.goto(BASE + "/register.html", { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="email"]', `${USER}@e2e.local`);
  await page.fill('input[name="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 20000 });

  // Delete the auto-created starter so quota can't interfere with the flow.
  const ls0 = await apiCall("/api/servers");
  for (const s of ls0.body?.servers || [])
    await apiCall(`/api/servers/${s.id}`, { method: "DELETE" });

  // ── 2) Create server (API, deterministic) + Start via the card button ────
  step(`create paper ${UP_FROM} + Start via UI`);
  const created = await apiCall("/api/servers", {
    method: "POST",
    body: {
      name: "E2E Upgrade Server",
      type: "paper",
      version: UP_FROM,
      plan: "free",
      region: "eu",
      skipAutoStart: true,
    },
  });
  expect("server created", created.status < 400, `status ${created.status}`);
  if (created.status >= 400) throw new Error("create failed");
  const sid = created.body.id;

  await page.goto(BASE + "/dashboard.html", { waitUntil: "networkidle" });
  const card = page.locator(`.server-card[data-id="${sid}"]`);
  await card.waitFor({ timeout: 15000 });
  await card.locator("button.sc-primary").click();
  const boot1 = await waitCardStatus(card, /online/i, 240000);
  expect(
    `card shows Online on paper ${UP_FROM}`,
    boot1.ok,
    boot1.ok ? `${Math.round(boot1.ms / 1000)}s` : `stuck at "${boot1.last}"`,
  );
  if (!boot1.ok) throw new Error("initial boot failed");

  // ── 3) Open swap modal, pick UP_TO, Apply ────────────────────────────────
  step(`swap via modal → paper ${UP_TO}`);
  await openSwapModal(card);
  await page.selectOption("#sjVersion", UP_TO);
  // Button-stability watcher across the whole swap window.
  await page.evaluate((sid) => {
    window.__btnDeaths = 0;
    window.__watch = setInterval(() => {
      const c = document.querySelector(`.server-card[data-id="${sid}"]`);
      if (!c) return;
      const btn = c.querySelector("button.sc-primary");
      if (window.__lastBtn && window.__lastBtn !== btn && !document.contains(window.__lastBtn))
        window.__btnDeaths++;
      window.__lastBtn = btn;
    }, 250);
  }, sid);
  await page.click("#sjApply");

  // ── 4) Negative path: Apply again while the swap is in flight → busy ─────
  // Do this IMMEDIATELY after Apply #1 — the swap holds its lock only while
  // the stop+download+spawn runs (several seconds); waiting for the status
  // pill first would let a fast swap finish and turn Apply #2 into a real
  // second swap.
  step("second Apply during swap → inline busy error");
  await page
    .locator("#swapJarModal.show")
    .waitFor({ state: "hidden", timeout: 15000 });
  await openSwapModal(card);
  await page.selectOption("#sjVersion", UP_TO);
  await page.click("#sjApply");
  // Wait for the request to settle: inline error rendered (busy → modal stays
  // open) or modal closed (request was accepted as a re-swap).
  await page
    .waitForFunction(
      () => {
        const modal = document.getElementById("swapJarModal");
        const err = document.getElementById("sjError");
        return (
          !modal?.classList.contains("show") ||
          (err && err.textContent.trim().length > 0)
        );
      },
      { timeout: 60000 },
    )
    .catch(() => {});
  const busyText = (await page.locator("#sjError").textContent().catch(() => "")).trim();
  const modalStillOpen = await page
    .locator("#swapJarModal.show")
    .isVisible()
    .catch(() => false);
  if (!modalStillOpen && !busyText) {
    // The first swap finished before our second Apply landed (fast local
    // swaps: cached jar + instant spawn), so it was accepted as a same-version
    // re-swap — there was no busy window to observe. The busy 409 itself is
    // covered deterministically by scripts/test-upgrade-flow.mjs; the modal's
    // inline-error rendering is proven by the downgrade + quota checks below.
    console.log("  ~ busy window missed (swap completed first) — skipped");
  } else {
    expect(
      "modal shows readable busy error",
      /busy|in progress/i.test(busyText),
      busyText.slice(0, 80) || "(empty)",
    );
    const applyEnabled = await page.evaluate(() => !document.getElementById("sjApply").disabled);
    expect("Apply re-enabled after busy error", applyEnabled);
    await page.click("#swapJarModal .close-btn");
  }

  // Card must flip to Starting… without a reload (optimistic update).
  const starting = await waitCardStatus(card, /starting|online/i, 30000);
  expect("card shows Starting…/Online after Apply", starting.ok, starting.ok ? "" : `saw "${starting.last}"`);

  // ── 5) Wait for the upgrade to come online, verify card + API ────────────
  step("wait for online on new version");
  const boot2 = await waitCardStatus(card, /online/i, 300000);
  expect(
    `card shows Online on paper ${UP_TO}`,
    boot2.ok,
    boot2.ok ? `${Math.round(boot2.ms / 1000)}s` : `stuck at "${boot2.last}"`,
  );
  const typeText = (await card.locator(".sc-type").textContent().catch(() => "")).trim();
  expect(`card label shows ${UP_TO}`, typeText.includes(UP_TO), typeText.slice(0, 60));
  const fresh = await apiCall("/api/servers");
  const row = fresh.body?.servers?.find((s) => s.id === sid);
  expect(
    `API row shows paper ${UP_TO}`,
    row?.type === "paper" && row?.version === UP_TO,
    `${row?.type} ${row?.version}`,
  );
  const btnDeaths = await page.evaluate(() => {
    clearInterval(window.__watch);
    return window.__btnDeaths;
  });
  // Legit state transitions (offline→starting→online) rebuild the actions
  // section a few times per swap, and the busy probe above can add a second
  // full swap. The historical glitch was a rebuild on EVERY 500ms poll tick —
  // 40+ over this window — so the bar is "not churning per tick".
  expect("primary button DOM stable through swap (≤10 rebuilds)", btnDeaths <= 10, `${btnDeaths} rebuilds`);

  // ── 6) Negative path: downgrade pick → inline warning + confirm button ───
  // The swap route may still be finishing (graceful stop of a booting JVM can
  // take ~20s) even after SLP reports online — retry through any busy window.
  step("select older version → downgrade warning");
  let downText = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    await openSwapModal(card);
    await page.selectOption("#sjVersion", DOWNGRADE_TO);
    await page.click("#sjApply");
    await page.waitForTimeout(1500);
    downText = (await page.locator("#sjError").textContent().catch(() => "")).trim();
    if (!/busy|in progress/i.test(downText)) break;
    await page.click("#swapJarModal .close-btn");
    await page.waitForTimeout(5000);
  }
  expect("modal shows downgrade warning", /older|corrupt|saved with/i.test(downText), downText.slice(0, 80) || "(empty)");
  const applyLabel = (await page.locator("#sjApply").textContent().catch(() => "")).trim();
  expect('Apply becomes "Downgrade anyway"', /downgrade anyway/i.test(applyLabel), applyLabel);
  await page.click("#swapJarModal .close-btn"); // do NOT confirm the downgrade

  // ── 7) Negative path: swap a stopped server while this one runs → quota ──
  step("swap stopped 2nd server while 1st runs → quota error");
  const c2 = await apiCall("/api/servers", {
    method: "POST",
    body: {
      name: "E2E Quota Server",
      type: "paper",
      version: UP_FROM,
      plan: "free",
      region: "eu",
      skipAutoStart: true,
    },
  });
  if (c2.status < 400) {
    const sid2 = c2.body.id;
    await page.goto(BASE + "/dashboard.html", { waitUntil: "networkidle" });
    const card2 = page.locator(`.server-card[data-id="${sid2}"]`);
    await card2.waitFor({ timeout: 15000 });
    await openSwapModal(card2);
    await page.selectOption("#sjVersion", UP_FROM);
    await page.click("#sjApply");
    await page.waitForTimeout(1500);
    const quotaText = (await page.locator("#sjError").textContent().catch(() => "")).trim();
    expect(
      "modal shows running-quota error",
      /running|stop/i.test(quotaText),
      quotaText.slice(0, 80) || "(empty)",
    );
    await page.click("#swapJarModal .close-btn");
  } else {
    console.log("  ~ skipped quota path (second create failed)");
  }

  // ── 8) Stop via UI ────────────────────────────────────────────────────────
  step("Stop via card button");
  const card1 = page.locator(`.server-card[data-id="${sid}"]`);
  await card1.locator("button.sc-primary").click();
  const stopped = await waitCardStatus(card1, /offline/i, 60000);
  expect("card shows Offline after Stop", stopped.ok, stopped.ok ? "" : `saw "${stopped.last}"`);

  // Negative paths legitimately produce 4xx responses, which Chromium logs as
  // "Failed to load resource" console errors — only real JS errors count.
  const jsErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  expect("no page JS errors", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
  exitCode = fail === 0 ? 0 : 1;
} catch (err) {
  console.error("FATAL:", err.message);
  exitCode = 2;
} finally {
  // Cleanup even on failure so live runs never leave servers behind.
  step("cleanup");
  try {
    const list = await apiCall("/api/servers");
    for (const s of list.body?.servers || []) {
      const r = await apiCall(`/api/servers/${s.id}`, { method: "DELETE" });
      console.log(`  deleted ${s.name}: ${r.status}`);
    }
  } catch (e) {
    console.error("  cleanup failed:", e.message);
  }
  await browser.close();
  console.log(`\n─── UI upgrade flow: ${pass} pass · ${fail} fail ───`);
  process.exit(exitCode);
}
