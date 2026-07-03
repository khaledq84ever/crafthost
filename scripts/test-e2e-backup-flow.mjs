// Full UI e2e of the backups flow, driven like a real user:
//   register → create server → card ⋯ menu → Backups → "Back up now" →
//   list shows the manual backup → change world via API → Restore (confirm) →
//   marker reverted + auto-pre-restore badge appears → delete a backup →
//   list shrinks → cleanup.
//
// Usage:
//   local: BASE=http://localhost:4123 UP_FROM=1.19.4 node scripts/test-e2e-backup-flow.mjs
//   live:  BASE=https://crafthost-production.up.railway.app node scripts/test-e2e-backup-flow.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:4123";
const UP_FROM = process.env.UP_FROM || "1.20.1";
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
const dialogs = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));
page.on("dialog", (d) => {
  dialogs.push(d.message().slice(0, 300));
  d.accept();
});

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

// Open the card's ⋯ menu → Backups, retrying through poll-tick re-renders.
async function openBackupsModal(card) {
  for (let attempt = 0; ; attempt++) {
    try {
      await card.locator("button.sc-menu-btn").click({ timeout: 3000 });
      await card
        .locator('.sc-menu button:has-text("Backups")')
        .click({ timeout: 2000 });
      await page.locator("#backupsModal.show").waitFor({ timeout: 3000 });
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
  // Wait for the list to finish its initial load.
  await page.waitForFunction(
    () => {
      const el = document.getElementById("bkList");
      return el && !/Loading…/.test(el.textContent);
    },
    { timeout: 15000 },
  );
}

const backupRows = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#bkList .badge")).map((b) =>
      b.textContent.trim(),
    ),
  );

let exitCode = 1;
try {
  // ── 1) Register + clean slate ────────────────────────────────────────────
  step(`register ${USER} on ${BASE}`);
  await page.goto(BASE + "/register.html", { waitUntil: "networkidle" });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="email"]', `${USER}@e2e.local`);
  await page.fill('input[name="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 20000 });
  const ls0 = await apiCall("/api/servers");
  for (const s of ls0.body?.servers || [])
    await apiCall(`/api/servers/${s.id}`, { method: "DELETE" });

  // ── 2) Create server (offline is fine — snapshots work without a boot) ───
  step(`create paper ${UP_FROM} (no boot)`);
  const created = await apiCall("/api/servers", {
    method: "POST",
    body: {
      name: "E2E Backup Server",
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

  const markerPath = "world/backup-marker.txt";
  const V1 = "UI_BK_V1_" + rand;
  const V2 = "UI_BK_V2_" + rand;
  const w1 = await apiCall(`/api/servers/${sid}/files/write`, {
    method: "PUT",
    body: { path: markerPath, content: V1 },
  });
  expect("marker V1 written", w1.status < 400, `status ${w1.status}`);

  // ── 3) Open Backups modal, take a backup ─────────────────────────────────
  step("Backups modal → Back up now");
  await page.goto(BASE + "/dashboard.html", { waitUntil: "networkidle" });
  const card = page.locator(`.server-card[data-id="${sid}"]`);
  await card.waitFor({ timeout: 15000 });
  await openBackupsModal(card);
  expect(
    "empty state shown",
    /No backups yet/i.test(await page.locator("#bkList").textContent()),
  );
  await page.click("#bkCreate");
  await page.waitForFunction(
    () => document.querySelectorAll("#bkList .badge").length >= 1,
    { timeout: 30000 },
  );
  let badges = await backupRows();
  expect("list shows 1 manual backup", badges.length === 1 && badges[0] === "manual", badges.join(","));

  // ── 4) Change world, Restore through the UI ──────────────────────────────
  step("change marker → Restore via UI");
  const w2 = await apiCall(`/api/servers/${sid}/files/write`, {
    method: "PUT",
    body: { path: markerPath, content: V2 },
  });
  expect("marker changed to V2", w2.status < 400);

  await page.click('#bkList button:has-text("Restore")');
  // Restore confirm dialog auto-accepted by the dialog handler above.
  await page.waitForFunction(
    () => document.querySelectorAll("#bkList .badge").length >= 2,
    { timeout: 60000 },
  );
  expect(
    "restore confirm dialog mentioned safety backup",
    dialogs.some((d) => /safety backup/i.test(d)),
    dialogs.join(" | ").slice(0, 100),
  );
  badges = await backupRows();
  expect(
    "auto-pre-restore badge appears",
    badges.includes("auto"),
    badges.join(","),
  );
  const r1 = await apiCall(
    `/api/servers/${sid}/files/read?path=${encodeURIComponent(markerPath)}`,
  );
  expect("marker reverted to V1", r1.body?.content === V1, String(r1.body?.content).slice(0, 24));

  // ── 5) Delete a backup through the UI ────────────────────────────────────
  step("delete newest backup via UI");
  const beforeDel = (await backupRows()).length;
  await page.click('#bkList button[title="Delete backup"]');
  await page.waitForFunction(
    (n) => document.querySelectorAll("#bkList .badge").length === n - 1,
    beforeDel,
    { timeout: 15000 },
  );
  expect("list shrank by 1", true, `${beforeDel} → ${beforeDel - 1}`);

  // Negative-path (busy) rendering is covered deterministically by
  // scripts/test-backup-flow.mjs; the modal reuses the same inline-error path.

  const jsErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
  expect("no page JS errors", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
  exitCode = fail === 0 ? 0 : 1;
} catch (err) {
  console.error("FATAL:", err.message);
  exitCode = 2;
} finally {
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
  console.log(`\n─── UI backup flow: ${pass} pass · ${fail} fail ───`);
  process.exit(exitCode);
}
