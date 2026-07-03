// Local-only UI smoke: admin.html gate + bedrock modal escalation when the
// playit agent is unavailable (BASE defaults localhost; live has a real agent
// so the escalation path will not trigger there).
// Scratch verification: admin.html gate + bedrock modal escalation.
import { chromium } from "playwright";
const BASE = "http://localhost:4123";
const rand = Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

// 1) admin.html as anonymous → gate visible
await page.goto(BASE + "/admin.html", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const gateVisible = await page.locator("#gate").isVisible();
const gateText = (await page.locator("#gate").textContent()).trim().slice(0, 60);
console.log("admin gate (anon):", gateVisible ? "VISIBLE ✓" : "MISSING ✗", "—", gateText);

// 2) register user, enable bedrock with fake secret (agent unavailable locally)
await page.goto(BASE + "/register.html", { waitUntil: "networkidle" });
await page.fill('input[name="username"]', `smokeui${rand}`);
await page.fill('input[name="email"]', `smokeui${rand}@e2e.local`);
await page.fill('input[name="password"]', "E2e-test-12345");
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 20000 });

const list = await page.evaluate(async () => (await (await fetch("/api/servers", { credentials: "include" })).json()));
const sid = list.servers[0].id;
await page.evaluate(async (sid) => {
  await fetch(`/api/servers/${sid}/playit`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: "fake-secret-for-ui-test-123" }),
  });
}, sid);

// open the bedrock modal → agent_available=false → escalation should render immediately
await page.evaluate((sid) => openBedrockModal(sid, "test"), sid);
await page.waitForTimeout(2500);
const modalText = (await page.locator("#bedrockBody").textContent()).replace(/\s+/g, " ").trim();
const escalated = /isn't connecting|not available/i.test(modalText);
console.log("bedrock escalation (agent down):", escalated ? "SHOWN ✓" : "NOT SHOWN ✗");
console.log("  modal text:", modalText.slice(0, 140));
const hasRetry = await page.locator('#bedrockBody button:has-text("Retry")').count();
const hasRestart = await page.locator('#bedrockBody button:has-text("Restart server")').count();
console.log("  retry button:", hasRetry ? "✓" : "✗", "| restart button:", hasRestart ? "✓" : "✗");

// cleanup
await page.evaluate(async () => {
  const l = await (await fetch("/api/servers", { credentials: "include" })).json();
  for (const s of l.servers || []) await fetch(`/api/servers/${s.id}`, { method: "DELETE", credentials: "include" });
});
console.log("JS errors:", errs.length ? errs : "none");
await browser.close();
process.exit(gateVisible && escalated && hasRetry && hasRestart ? 0 : 1);
