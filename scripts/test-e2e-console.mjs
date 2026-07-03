// Live-console e2e, driven like a real user:
//   register → create+start server → open console.html → boot lines stream
//   over the WebSocket → type `say <token>` in the command box → the echo
//   line appears in the terminal → restart the server via API → the console
//   auto-reconnects and streams the NEW boot → no page JS errors → cleanup.
//
// Usage:
//   local: BASE=http://localhost:4123 UP_FROM=1.19.4 node scripts/test-e2e-console.mjs
//   live:  BASE=https://crafthost-production.up.railway.app node scripts/test-e2e-console.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:4123";
const UP_FROM = process.env.UP_FROM || "1.20.1";
const rand = Math.random().toString(36).slice(2, 8);
const USER = `smoke${rand}`;
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

// Wait until the terminal's text matches `re`, polling the DOM.
async function waitTermMatch(re, maxMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const txt = await page.evaluate(() => document.getElementById("term")?.textContent || "");
    if (re.test(txt)) return { ok: true, ms: Date.now() - t0 };
    await page.waitForTimeout(1500);
  }
  return { ok: false };
}

async function waitApiOnline(sid, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await apiCall(`/api/servers/${sid}/status`);
    if (r.body?.status === "online") return true;
    await page.waitForTimeout(2500);
  }
  return false;
}

let exitCode = 1;
try {
  // ── 1) Register + create + start ────────────────────────────────────────
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

  step(`create + start paper ${UP_FROM}`);
  const created = await apiCall("/api/servers", {
    method: "POST",
    body: { name: "E2E Console Server", type: "paper", version: UP_FROM, plan: "free", region: "eu" },
  });
  expect("server created (auto-start)", created.status < 400, `status ${created.status}`);
  if (created.status >= 400) throw new Error("create failed");
  const sid = created.body.id;
  expect("server reaches online", await waitApiOnline(sid, 240000));

  // ── 2) Open the console page — live stream connects + boot lines shown ──
  step("open console.html → live stream");
  await page.goto(BASE + `/console.html?id=${sid}`, { waitUntil: "networkidle" });
  const connected = await waitTermMatch(/Connected to live log stream|Streaming/i, 25000);
  expect("WS connects (banner line)", connected.ok);
  const boot = await waitTermMatch(/Done \(|Starting minecraft server/i, 30000);
  expect("boot log lines streamed into terminal", boot.ok);

  // ── 3) Send a command, see its effect in the log stream ─────────────────
  step("send `say` command from the input");
  const token = `hello-e2e-${rand}`;
  await page.fill("#cmdInput", `say ${token}`);
  await page.press("#cmdInput", "Enter");
  const echo = await waitTermMatch(new RegExp(token), 30000);
  expect("command output appears in terminal", echo.ok, echo.ok ? `${Math.round(echo.ms / 1000)}s` : "no echo");

  // ── 4) Restart the MC server — the stream SURVIVES without reconnecting ─
  // (the backend carries log listeners across JVM restarts, so the WS stays
  // up and the new boot flows into the same terminal — no refresh needed)
  step("restart server → stream survives seamlessly");
  const bootsBefore = await page.evaluate(
    () => (document.getElementById("term").textContent.match(/Done \(/g) || []).length,
  );
  await apiCall(`/api/servers/${sid}/restart`, { method: "POST" });
  expect("server back online after restart", await waitApiOnline(sid, 240000));
  const t0boot = Date.now();
  let bootsAfter = bootsBefore;
  while (Date.now() - t0boot < 60000) {
    bootsAfter = await page.evaluate(
      () => (document.getElementById("term").textContent.match(/Done \(/g) || []).length,
    );
    if (bootsAfter > bootsBefore) break;
    await page.waitForTimeout(2000);
  }
  expect("new boot streamed into the SAME terminal (no refresh)", bootsAfter > bootsBefore, `${bootsBefore} → ${bootsAfter}`);
  const token2 = `after-restart-${rand}`;
  await page.fill("#cmdInput", `say ${token2}`);
  await page.press("#cmdInput", "Enter");
  const echo2 = await waitTermMatch(new RegExp(token2), 30000);
  expect("commands still work after restart", echo2.ok);

  // ── 5) Force a WS drop (backend redeploy / network blip) → auto-reconnect ─
  step("force WS drop → auto-reconnect");
  await page.evaluate(() => ws.close());
  const recon = await waitTermMatch(/Reconnecting in/i, 15000);
  expect("reconnect banner shown after drop", recon.ok);
  const resumed = await waitTermMatch(/Reconnected ✓ — resuming live stream/i, 60000);
  expect("stream reconnects (Reconnected ✓)", resumed.ok);
  const token3 = `after-reconnect-${rand}`;
  await page.fill("#cmdInput", `say ${token3}`);
  await page.press("#cmdInput", "Enter");
  const echo3 = await waitTermMatch(new RegExp(token3), 30000);
  expect("commands work after reconnect", echo3.ok);

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
  console.log(`\n─── Console e2e: ${pass} pass · ${fail} fail ───`);
  process.exit(exitCode);
}
