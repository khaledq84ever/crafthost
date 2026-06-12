// Server creation wizard — 4 steps

const SERVER_TYPES = [
  {
    id: "paper",
    img: "/img/engines/paper.svg",
    name: "Paper",
    c: "#F57C00",
    desc: "High-performance fork. Plugins supported.",
  },
  {
    id: "vanilla",
    img: "/img/engines/vanilla.svg",
    name: "Vanilla",
    c: "#7CB342",
    desc: "Pure Mojang. No mods, no plugins.",
  },
  {
    id: "purpur",
    img: "/img/engines/purpur.svg",
    name: "Purpur",
    c: "#283593",
    desc: "Highly configurable Paper fork.",
  },
  {
    id: "fabric",
    img: "/img/engines/fabric.png",
    name: "Fabric",
    c: "#01579B",
    desc: "Lightweight modding API for mods.",
  },
  {
    id: "neoforge",
    img: "/img/engines/neoforge.png",
    name: "NeoForge",
    c: "#FF6F00",
    desc: "Modern Forge fork — for heavy modpacks.",
  },
  {
    id: "custom",
    name: "Custom JAR",
    c: "#FFB300",
    desc: "Upload your own .jar file (up to 500MB).",
  },
];

const MC_VERSIONS = [
  { id: "26.1.2", name: "26.1.2", date: "2026-05-15", latest: true },
  { id: "1.21.11", name: "1.21.11", date: "2026-05-22", stable: true },
  { id: "1.21.8", name: "1.21.8", date: "2025-09-10", stable: true },
  { id: "1.21.5", name: "1.21.5", date: "2025-03-20" },
  { id: "1.21.4", name: "1.21.4", date: "2024-12-03" },
  { id: "1.21.1", name: "1.21.1", date: "2024-08-08", stable: true },
  { id: "1.21", name: "1.21", date: "2024-06-13" },
  { id: "1.20.6", name: "1.20.6", date: "2024-04-29" },
  { id: "1.20.4", name: "1.20.4", date: "2023-12-07", stable: true },
  { id: "1.20.1", name: "1.20.1", date: "2023-06-12", stable: true },
  { id: "1.19.4", name: "1.19.4", date: "2023-03-14" },
  { id: "1.18.2", name: "1.18.2", date: "2022-02-28" },
  { id: "1.16.5", name: "1.16.5", date: "2021-01-14", stable: true },
  { id: "1.12.2", name: "1.12.2", date: "2017-09-18" },
];

const PLANS = [
  {
    id: "free",
    name: "Free",
    price: 0,
    ram: 2048,
    cpu: 2,
    slots: 50,
    badge: "FREE",
  },
];

// Memory-heavy threshold. Plan now ships with 2 GB RAM / 1.5 GB heap, so
// Paper 1.21+ (~700 MB on boot) and most Fabric/NeoForge versions fit
// comfortably. Only flag "very heavy" combinations that exceed even this —
// effectively unused at the moment, but kept as a hook for future plan sizing.
function isHeavyVersion(v) {
  return false;
}
function safeVersionForPlan(planId, candidates) {
  // For free plan, prefer the first 1.20.x in the list (typically 1.20.1 or 1.20.6).
  if (planId !== "free") return candidates[0]?.id || candidates[0];
  const safe = candidates.find((v) => !isHeavyVersion(v.id || v));
  return safe ? safe.id || safe : candidates[0]?.id || candidates[0];
}

// Exposed on window so other modules (dashboard quickDeploy) can set wizState.name
// before reusing renderDeployProgress.
window.wizState = {
  step: 1,
  type: null,
  version: "1.21.1",
  plan: "free",
  name: "",
  region: "eu",
  motd: "Welcome to my CraftHost server!",
  difficulty: "normal",
  gamemode: "survival",
  whitelist: false,
  customJar: null,
  starterPlugins: [], // Modrinth project IDs to pre-install
  seed: "", // Optional world seed — pre-written to server.properties
  bedrock: false, // Bedrock cross-play: installs Geyser+Floodgate + opens playit tunnel
};
// Local alias for the rest of the file so unqualified `wizState` references
// still work as before (they now read the same object from window).
const wizState = window.wizState;

// Popular starter plugins — installed via Modrinth on server boot when toggled.
// Project IDs are stable Modrinth slugs/IDs. Only shown for plugin-compatible
// server types (paper/spigot/purpur). Fabric/NeoForge use mods (different page).
const STARTER_PLUGINS = [
  {
    id: "Vebnzrzj",
    name: "LuckPerms",
    icon: '<img src="/img/plugins/luckperms.webp" alt="" loading="lazy" />',
    desc: "Permissions manager — set roles + privileges.",
  },
  {
    id: "hXiIvTyT",
    name: "EssentialsX",
    icon: '<img src="/img/plugins/essentialsx.webp" alt="" loading="lazy" />',
    desc: "Server essentials — /home /tpa /kit /spawn.",
  },
  {
    id: "1u6JkXh5",
    name: "WorldEdit",
    icon: '<img src="/img/plugins/worldedit.webp" alt="" loading="lazy" />',
    desc: "Terrain editor — copy, paste, fill, generate.",
  },
  {
    id: "P1OZGk5p",
    name: "ViaVersion",
    icon: '<img src="/img/plugins/viaversion.webp" alt="" loading="lazy" />',
    desc: "Cross-version compatibility — older clients connect.",
  },
  {
    id: "Lu3KuzdV",
    name: "CoreProtect",
    icon: '<img src="/img/plugins/coreprotect.png" alt="" loading="lazy" />',
    desc: "Block logging — roll back grief, audit changes.",
  },
  {
    id: "squaremap",
    name: "squaremap",
    icon: '<img src="/img/plugins/squaremap.webp" alt="" loading="lazy" />',
    desc: "Lightweight web map — view your world in a browser.",
  },
  // Bedrock cross-play (Geyser + Floodgate) is NOT shown as loose chips — toggling
  // the plugins alone installs them but doesn't open the UDP tunnel, so Bedrock
  // still wouldn't work. They're driven by the single "Bedrock cross-play" switch
  // below, which installs both AND enables the playit tunnel. See BEDROCK_PLUGIN_IDS.
  {
    id: "wKkoqHrH",
    name: "GeyserMC",
    icon: '<img src="/img/plugins/geyser.webp" alt="" loading="lazy" />',
    desc: "Bedrock cross-play — mobile / Xbox / Switch / PS players join.",
    bedrock: true,
  },
  {
    id: "bWrNNfkb",
    name: "Floodgate",
    icon: "🌊",
    desc: "Geyser companion — Bedrock players join without a Java account.",
    bedrock: true,
  },
];
// The two project IDs the Bedrock toggle pulls in (kept in sync with the flags above).
const BEDROCK_PLUGIN_IDS = STARTER_PLUGINS.filter((p) => p.bedrock).map(
  (p) => p.id,
);

async function openWizard() {
  // Gate at the door: must be authenticated. If not, send to login.
  try {
    await api("/api/servers"); // any auth-gated endpoint
  } catch {
    toast("Sign in to create a server", "warn");
    setTimeout(() => (location.href = "/login.html?next=/dashboard.html"), 600);
    return;
  }
  wizState.step = 1;
  // Default to Paper (most common) so Next works immediately — a null type
  // left the Next button disabled with no visible reason, which users read
  // as "the create page is broken".
  wizState.type = "paper";
  renderWizard();
  document.getElementById("wizardModal").classList.add("show");
}

function closeWizard() {
  document.getElementById("wizardModal").classList.remove("show");
}

function renderWizard() {
  const labels = ["Type", "Version", "Configure", "Review"];
  const m = document.getElementById("wizardModal");
  m.innerHTML = `
  <div class="modal wiz-modal" onclick="event.stopPropagation()">
    <div class="modal-head">
      <h3>Create New Server</h3>
      <button class="close-btn" onclick="closeWizard()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="wiz-steps">
      ${[1, 2, 3, 4].map((n) => `<div class="wiz-step ${wizState.step >= n ? "active" : ""} ${wizState.step > n ? "done" : ""}"></div>`).join("")}
    </div>
    <div class="wiz-step-labels">
      ${labels.map((l, i) => `<span class="${wizState.step === i + 1 ? "active" : ""}">${i + 1}. ${l}</span>`).join("")}
    </div>

    <div class="modal-body" id="wizBody">${renderStep()}</div>

    <div class="modal-foot">
      ${wizState.step > 1 ? '<button class="btn btn-ghost" onclick="wizPrev()">← Back</button>' : ""}
      ${
        wizState.step < 4 && !canAdvance()
          ? `<span class="wiz-foot-hint" style="color:var(--text-disabled);font-size:13px;margin-right:auto;align-self:center;">${
              wizState.step === 1
                ? "Pick an engine to continue"
                : wizState.step === 2
                  ? "Pick a version to continue"
                  : "Enter a server name to continue"
            }</span>`
          : ""
      }
      ${
        wizState.step < 4
          ? `<button class="btn btn-primary" id="nextBtn" onclick="wizNext()" ${!canAdvance() ? "disabled" : ""}>Next →</button>`
          : '<button class="btn btn-primary" onclick="wizDeploy()">🚀 Deploy Server</button>'
      }
    </div>
  </div>
  `;
  m.onclick = (e) => {
    if (e.target === m) closeWizard();
  };
}

function canAdvance() {
  if (wizState.step === 1) return !!wizState.type;
  if (wizState.step === 2) return !!wizState.version;
  if (wizState.step === 3) return wizState.name.trim().length >= 1;
  return true;
}

function renderStep() {
  if (wizState.step === 1) return renderStep1();
  if (wizState.step === 2) return renderStep2();
  if (wizState.step === 3) return renderStep3();
  if (wizState.step === 4) return renderStep4();
}

function renderStep1() {
  const icon = (id) => (window.TYPE_ICONS && window.TYPE_ICONS[id]) || "";
  // All types unlocked on Pro plan (4 GB RAM per server). Auto-heal still
  // recovers any OOM cases that slip through.
  return `
    <p class="text-muted mb-6">Pick the engine that powers your world.</p>
    <div class="type-grid">
      ${SERVER_TYPES.map(
        (t) => `
        <button class="type-pick ${wizState.type === t.id ? "selected" : ""}" onclick="pickType('${t.id}')">
          <div class="tp-logo tp-logo-svg" style="background:${t.c}1f;border-color:${t.c}55;">${t.img ? `<img src="${t.img}" alt="${t.name}" loading="lazy" />` : icon(t.id) || `<span style="color:${t.c};font-weight:800;font-size:22px;">${t.name[0]}</span>`}</div>
          <h4>${t.name}</h4>
          <p>${t.desc}</p>
        </button>
      `,
      ).join("")}
    </div>
  `;
}

function renderStep2() {
  if (wizState.type === "custom") {
    return `
      <p class="text-muted mb-6">Upload your custom server JAR. Max 500MB, will be virus-scanned.</p>
      <div class="upload-zone" id="dropZone" onclick="document.getElementById('jarInput').click()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <p><strong>Click to upload</strong> or drag-drop your .jar file</p>
        <small>Max 500MB · Will be validated before launch</small>
        <input type="file" id="jarInput" accept=".jar" style="display:none" onchange="handleJar(event)" />
      </div>
      ${
        wizState.customJar
          ? `<div class="card mt-4" style="display:flex;justify-content:space-between;align-items:center;">
        <div>📦 <strong>${wizState.customJar.name}</strong><br><small class="text-muted">${fmtBytes(wizState.customJar.size)}</small></div>
        <button class="btn btn-ghost btn-sm" onclick="wizState.customJar=null;renderWizard()">Remove</button>
      </div>`
          : ""
      }
    `;
  }
  // Live versions for the picked type, fetched from /api/versions
  if (!wizState._liveVersions) wizState._liveVersions = {};
  const cached = wizState._liveVersions[wizState.type];
  if (!cached) {
    // Lazy fetch
    fetch(`/api/versions/${encodeURIComponent(wizState.type)}?limit=200`, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : { versions: [] }))
      .then((d) => {
        wizState._liveVersions[wizState.type] = d.versions || [];
        if (wizState._liveVersions[wizState.type].length) {
          wizState.version = safeVersionForPlan(
            wizState.plan,
            wizState._liveVersions[wizState.type],
          );
        }
        renderWizard();
      })
      .catch(() => {
        wizState._liveVersions[wizState.type] = [];
        renderWizard();
      });
    return `
      <p class="text-muted mb-6">Choose your Minecraft version.</p>
      <div class="field"><div class="skel" style="height:42px;"></div></div>
      <p class="text-muted" style="font-size:13px;">Loading versions from ${SERVER_TYPES.find((t) => t.id === wizState.type)?.name || ""}…</p>
    `;
  }
  const live = cached.length ? cached : MC_VERSIONS;
  const planRisky =
    wizState.plan === "free" && isHeavyVersion(wizState.version);
  const recommended = safeVersionForPlan("free", live);
  // Group versions by major.minor (1.21.x, 1.20.x, 1.19.x, ...) so a 50-entry
  // dropdown stays readable. Each group is its own <optgroup>.
  const groups = {};
  for (const v of live) {
    const id = v.id || v.name;
    const m = String(id).match(/^(\d+\.\d+)/);
    const key = m ? m[1] + ".x" : "other";
    (groups[key] = groups[key] || []).push(v);
  }
  const groupKeys = Object.keys(groups).sort((a, b) => {
    const ax = a.split(".").map((n) => parseInt(n, 10) || 0);
    const bx = b.split(".").map((n) => parseInt(n, 10) || 0);
    return bx[0] - ax[0] || bx[1] - ax[1];
  });
  const heavyWarn = planRisky
    ? `
    <div class="wiz-warn" role="alert">
      <strong>⚠ This version may run out of memory on the Free plan.</strong>
      <p>Minecraft ${wizState.version} needs more memory than your plan provides. Pick a lighter version to avoid OOM.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;">
        <button class="btn btn-secondary btn-sm" onclick="wizState.version='${recommended}';renderWizard()">Use ${recommended} instead (recommended)</button>
        <span class="text-muted" style="font-size:12px;">— or upgrade your plan in Step 3.</span>
      </div>
    </div>`
    : "";
  return `
    <p class="text-muted mb-6">Choose your Minecraft version. Showing <strong>${live.length}</strong> releases (newest first).</p>
    <div class="field">
      <label class="label">Version</label>
      <select class="select" onchange="wizState.version=this.value;renderWizard()">
        ${groupKeys
          .map(
            (gk) => `
          <optgroup label="Minecraft ${gk}">
            ${groups[gk]
              .map((v) => {
                const id = v.id || v.name;
                const tags = [];
                if (id === (live[0]?.id || live[0])) tags.push("Latest");
                if (wizState.plan === "free" && isHeavyVersion(id))
                  tags.push("⚠ may OOM");
                if (id === recommended && wizState.plan === "free")
                  tags.push("✓ recommended");
                const tag = tags.length ? ` — ${tags.join(" · ")}` : "";
                return `<option value="${id}" ${wizState.version === id ? "selected" : ""}>${id}${tag}</option>`;
              })
              .join("")}
          </optgroup>
        `,
          )
          .join("")}
      </select>
    </div>
    ${heavyWarn}
    <p class="text-muted" style="font-size:13px;">Selected: <span class="text-emerald">${SERVER_TYPES.find((t) => t.id === wizState.type)?.name} ${wizState.version}</span></p>
    ${renderBedrockToggle()}
  `;
}

function renderStep3() {
  return `
    <p class="text-muted mb-4" style="font-size:13px;">Configure your server.</p>
    <div class="field">
      <label class="label">Server Name</label>
      <input type="text" class="input" placeholder="My Awesome Server" value="${wizState.name}" oninput="wizState.name=this.value;document.getElementById('nextBtn').disabled=this.value.trim().length<1" />
    </div>
    <div class="field">
      <label class="label">MOTD (Server Message)</label>
      <input type="text" class="input" value="${wizState.motd}" oninput="wizState.motd=this.value" maxlength="59" />
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;">
      <div class="field">
        <label class="label">Gamemode</label>
        <select class="select" onchange="wizState.gamemode=this.value">
          <option value="survival">Survival</option>
          <option value="creative">Creative</option>
          <option value="adventure">Adventure</option>
          <option value="spectator">Spectator</option>
        </select>
      </div>
      <div class="field">
        <label class="label">Difficulty</label>
        <select class="select" onchange="wizState.difficulty=this.value">
          <option value="peaceful">Peaceful</option>
          <option value="easy">Easy</option>
          <option value="normal" selected>Normal</option>
          <option value="hard">Hard</option>
        </select>
      </div>
      <div class="field">
        <label class="label">Whitelist</label>
        <select class="select" onchange="wizState.whitelist=this.value==='true'">
          <option value="false">Off</option>
          <option value="true">On</option>
        </select>
      </div>
    </div>
    ${renderBedrockToggle()}
    ${renderStarterPlugins()}
  `;
}

// Starter-plugin chip selector. Only renders for plugin-compatible types.
// Fabric/NeoForge users install mods via the marketplace (different system).
function renderStarterPlugins() {
  const type = (wizState.type || "").toLowerCase();
  const supportsPlugins = ["paper", "spigot", "purpur"].includes(type);
  if (!supportsPlugins) return "";
  return `
    <div class="field" style="margin-top:18px;">
      <label class="label">Starter plugins (optional)</label>
      <p class="text-muted" style="font-size:12.5px;margin-bottom:10px;">Pre-installed on first boot. Toggle the ones you want — you can always install more later from the Marketplace.</p>
      <div class="plugin-chips">
        ${STARTER_PLUGINS.filter((p) => !p.bedrock)
          .map((p) => {
            const on = (wizState.starterPlugins || []).includes(p.id);
            return `
            <button type="button" class="pl-chip ${on ? "on" : ""}" onclick="toggleStarterPlugin('${p.id}')" title="${escapeHtmlW(p.desc)}">
              <span class="pl-chip-icon">${p.icon}</span>
              <span class="pl-chip-text">
                <span class="pl-chip-name">${p.name}</span>
                <span class="pl-chip-desc">${escapeHtmlW(p.desc)}</span>
              </span>
              <span class="pl-chip-check">${on ? "✓" : "+"}</span>
            </button>
          `;
          })
          .join("")}
      </div>
    </div>
  `;
}

// Single switch that does the whole Bedrock job: installs Geyser + Floodgate AND
// opens the playit UDP tunnel after deploy. Replaces the old two loose plugin
// chips that installed the plugins but left Bedrock players unable to connect.
// Bedrock cross-play works on every real server engine. Spigot-family
// (paper/spigot/purpur) loads Geyser as a plugin; Vanilla/Fabric/NeoForge get a
// Geyser-Standalone proxy started automatically. Only the "custom JAR" path is
// excluded (unknown engine).
const BEDROCK_CAPABLE_TYPES = [
  "paper",
  "spigot",
  "purpur",
  "vanilla",
  "fabric",
  "neoforge",
];
function renderBedrockToggle() {
  if (!BEDROCK_CAPABLE_TYPES.includes((wizState.type || "").toLowerCase()))
    return "";
  const on = !!wizState.bedrock;
  return `
    <div class="bedrock-toggle ${on ? "on" : ""}" onclick="toggleBedrock()"
         style="margin-top:14px;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;cursor:pointer;
                border:1px solid ${on ? "var(--emerald)" : "var(--glass-border, rgba(255,255,255,0.12))"};
                background:${on ? "rgba(16,185,129,0.10)" : "rgba(255,255,255,0.03)"};transition:all .18s;">
      <span style="font-size:22px;line-height:1;">📱</span>
      <span style="flex:1;">
        <span style="display:block;font-weight:700;font-size:13.5px;">Bedrock cross-play</span>
        <span style="display:block;font-size:12px;color:var(--text-muted, #9aa);">Let mobile / Xbox / Switch / PS players join. Bridges Bedrock players through Geyser and opens the Bedrock tunnel automatically.</span>
      </span>
      <span aria-hidden="true" style="flex:none;width:40px;height:23px;border-radius:999px;position:relative;transition:background .18s;
            background:${on ? "var(--emerald)" : "rgba(255,255,255,0.18)"};">
        <span style="position:absolute;top:2px;left:${on ? "19px" : "2px"};width:19px;height:19px;border-radius:50%;background:#fff;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.4);"></span>
      </span>
    </div>
  `;
}

function toggleBedrock() {
  wizState.bedrock = !wizState.bedrock;
  renderWizard();
}
window.toggleBedrock = toggleBedrock;

function toggleStarterPlugin(pid) {
  const list = (wizState.starterPlugins = wizState.starterPlugins || []);
  const i = list.indexOf(pid);
  if (i >= 0) list.splice(i, 1);
  else list.push(pid);
  renderWizard();
}
window.toggleStarterPlugin = toggleStarterPlugin;

function renderStep4() {
  const type = SERVER_TYPES.find((t) => t.id === wizState.type);
  const plan = PLANS.find((p) => p.id === wizState.plan);
  return `
    <p class="text-muted mb-6">Review and confirm.</p>
    <div class="review-list">
      <div class="review-row"><span class="l">Server Name</span><span class="v">${wizState.name}</span></div>
      <div class="review-row"><span class="l">Type</span><span class="v">${type.name}${wizState.customJar ? ` · ${wizState.customJar.name}` : ` ${wizState.version}`}</span></div>
      <div class="review-row"><span class="l">Plan</span><span class="v">${plan.name} — ${plan.price === 0 ? "FREE" : "$" + plan.price + "/mo"}</span></div>
      <div class="review-row"><span class="l">Resources</span><span class="v">${plan.ram / 1024} GB RAM · ${plan.cpu} CPU · ${plan.slots} slots</span></div>
      <div class="review-row"><span class="l">Region</span><span class="v">${wizState.region.toUpperCase()}</span></div>
      <div class="review-row"><span class="l">Gamemode</span><span class="v">${wizState.gamemode} (${wizState.difficulty})</span></div>
      <div class="review-row"><span class="l">Whitelist</span><span class="v">${wizState.whitelist ? "On" : "Off"}</span></div>
      <div class="review-row"><span class="l">Bedrock cross-play</span><span class="v">${wizState.bedrock ? "📱 On" : "Off"}</span></div>
    </div>
    <p class="text-muted mt-6" style="font-size:13px;">Your server will be deployed to <span class="text-emerald">${wizState.region.toUpperCase()}</span> region. Boot time is typically 30–90 seconds.</p>
  `;
}

function pickType(id) {
  wizState.type = id;
  if (id !== "custom" && wizState.step === 1) {
    // auto-advance
  }
  renderWizard();
}

function handleJar(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 500 * 1024 * 1024) {
    toast("File too large (max 500MB)", "error");
    return;
  }
  if (!f.name.endsWith(".jar")) {
    toast("Only .jar files accepted", "error");
    return;
  }
  wizState.customJar = { name: f.name, size: f.size, file: f };
  renderWizard();
}

function wizNext() {
  if (!canAdvance()) return;
  wizState.step = Math.min(4, wizState.step + 1);
  renderWizard();
}
function wizPrev() {
  wizState.step = Math.max(1, wizState.step - 1);
  renderWizard();
}

async function wizDeploy() {
  if (!wizState.name || !wizState.type || !wizState.plan) {
    toast("Missing required fields", "error");
    return;
  }
  const btn = document.querySelector(".wiz-modal .btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Deploying…";
  }
  toast("Deploying your server... ⚡");
  try {
    // When Bedrock cross-play is on for a Spigot-family type, fold Geyser +
    // Floodgate into the install list (deduped) so the plugins are present on
    // first boot. Vanilla/Fabric/NeoForge don't use plugins — their Bedrock
    // bridge is the Geyser-Standalone sidecar, so we skip the fold for them.
    // The tunnel itself is opened by the auto-enable call after create (below).
    const spigotFamily = ["paper", "spigot", "purpur"].includes(
      (wizState.type || "").toLowerCase(),
    );
    const plugins = [...(wizState.starterPlugins || [])];
    if (wizState.bedrock && spigotFamily)
      for (const id of BEDROCK_PLUGIN_IDS)
        if (!plugins.includes(id)) plugins.push(id);
    const body = {
      name: wizState.name,
      type: wizState.type,
      version: wizState.version,
      plan: wizState.plan,
      region: wizState.region,
      motd: wizState.motd,
      difficulty: wizState.difficulty,
      gamemode: wizState.gamemode,
      whitelist: !!wizState.whitelist,
      seed_plugins: plugins.length ? plugins : undefined,
      seed: (wizState.seed && wizState.seed.trim()) || undefined,
    };
    // If a custom JAR was selected, upload it first to /api/jars then attach its storage path
    if (wizState.customJar?.file) {
      const fd = new FormData();
      fd.append("jar", wizState.customJar.file, wizState.customJar.name);
      const up = await fetch("/api/jars", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!up.ok) {
        const err = await up.json().catch(() => ({}));
        throw new Error(err.error || "JAR upload failed");
      }
      const jar = await up.json();
      body.customJarPath = jar.id;
    }
    const r = await api("/api/servers", { method: "POST", body });
    if (r?.id) localStorage.setItem("crafthost.currentServerId", r.id);
    // Bedrock toggle: open the playit tunnel for the new server. Uses the shared
    // operator secret (one click). If that's not configured (503), the Geyser +
    // Floodgate plugins are still installed — the user finishes the one-time
    // playit approve from the dashboard's Bedrock panel. Non-fatal either way.
    if (wizState.bedrock && r?.id) {
      try {
        await api(`/api/servers/${r.id}/playit/auto-enable`, {
          method: "POST",
        });
        toast("📱 Bedrock cross-play enabled");
      } catch (err) {
        if (err?.status === 503) {
          toast(
            "Geyser installed — finish Bedrock setup from the server's ⋮ menu",
            "info",
          );
        } else if (err?.status === 409) {
          // Bedrock already active on another server (single shared tunnel).
          toast(
            "Geyser installed — Bedrock is in use on another server; take it over from the ⋮ menu",
            "info",
          );
        } else {
          toast(`Bedrock setup deferred: ${err.message}`, "warn");
        }
      }
    }
    // Switch the wizard modal to the live progress screen and poll until ready
    renderDeployProgress(r);
  } catch (err) {
    toast(err.message || "Deploy failed", "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🚀 Deploy server";
    }
  }
}

// Live progress screen — polls /api/servers/:id/progress every 1.5s and renders
// the phase list. When ready, promotes to the existing success modal. Surfaces
// OOM / non-zero exit codes with a retry path.
function renderDeployProgress(r) {
  const m = document.getElementById("wizardModal");
  m.innerHTML = `
    <div class="modal wiz-modal" onclick="event.stopPropagation()" style="max-width:520px;">
      <div class="modal-head">
        <h3>🚀 Deploying "<span style="color:var(--text-strong);">${escapeHtmlW(wizState.name)}</span>"</h3>
      </div>
      <div class="modal-body">
        <p class="text-muted" style="margin-bottom:18px;font-size:13.5px;">
          Building your Minecraft server. This usually takes 30–60 seconds.
        </p>
        <div id="deployProgress" class="deploy-progress">
          <div class="dp-row current"><span class="dp-icon">⏳</span><span class="dp-label">Connecting…</span></div>
        </div>
        <div id="deployHint" class="text-muted" style="font-size:12px;margin-top:14px;min-height:18px;"></div>
      </div>
    </div>
  `;
  pollDeployProgress(r);
}

async function pollDeployProgress(r) {
  const sid = r.id;
  const startTs = Date.now();
  const hintEl = document.getElementById("deployHint");
  let lastPhaseId = null;
  while (true) {
    let data = null;
    try {
      data = await api(`/api/servers/${sid}/progress`);
    } catch {}
    if (data) {
      renderProgressList(data);
      // Surface a useful hint when stuck on a phase for >15s
      const cur = data.phases.find((p) => p.current);
      if (cur && lastPhaseId === cur.id && hintEl) {
        if (cur.id === "jar")
          hintEl.textContent =
            "Downloading from papermc.io — first launch only, future starts are instant.";
        else if (cur.id === "world")
          hintEl.textContent = "Generating chunks for the spawn region…";
        else if (cur.id === "jvm")
          hintEl.textContent = "Loading mods, libraries, and recipes…";
        else if (cur.id === "tunnel")
          hintEl.textContent = "Allocating a real public IP via bore.pub…";
      } else if (cur) {
        lastPhaseId = cur.id;
        if (hintEl) hintEl.textContent = "";
      }
      // OOM: don't panic the user — auto-heal is already swapping to a safe
      // combo. Just show a friendly "healing" hint and KEEP POLLING so we can
      // promote to success when the swap finishes booting.
      if (data.oom) {
        if (hintEl)
          hintEl.textContent =
            "🔧 First-boot OOM — auto-healing to Paper 1.20.1 (one moment)…";
        // Don't return — keep polling so when auto-heal succeeds we hit `data.ready` below.
      }
      // Real crash with non-zero exit AND not OOM (auto-heal handles OOM):
      if (!data.oom && data.exit_code !== null && data.exit_code !== 0) {
        renderDeployFailure(
          sid,
          `Server crashed on first boot (exit code ${data.exit_code}). Check console logs for details.`,
        );
        return;
      }
      // Ready — promote to success modal
      if (data.ready) {
        // Fetch full server record to populate the success modal
        try {
          const list = await api("/api/servers");
          const me = (list.servers || []).find((x) => x.id === sid) || r;
          const h = await api("/api/health").catch(() => ({}));
          showDeploySuccess(
            {
              id: sid,
              port: me.port,
              proxy: me.tunnel_host
                ? { host: me.tunnel_host, port: me.tunnel_port }
                : null,
              is_public: !!me.is_public,
              auto_started: true,
            },
            h.public_mc_host || "",
            h.public_mc_port || 25565,
          );
        } catch {
          showDeploySuccess(r, "", 25565);
        }
        return;
      }
    }
    // Cap at 180s — surface a timeout (server may still finish but UX shouldn't hang)
    if (Date.now() - startTs > 180_000) {
      renderDeployFailure(
        sid,
        "Boot is taking longer than expected. The server may still come online — check the dashboard.",
      );
      return;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

function renderProgressList(data) {
  const el = document.getElementById("deployProgress");
  if (!el) return;
  el.innerHTML = data.phases
    .map(
      (p) => `
    <div class="dp-row ${p.done ? "done" : p.current ? "current" : "pending"}">
      <span class="dp-icon">${p.done ? "✓" : p.current ? '<span class="dp-spin">●</span>' : "○"}</span>
      <span class="dp-label">${escapeHtmlW(p.label)}</span>
    </div>
  `,
    )
    .join("");
}

function renderDeployFailure(sid, msg) {
  const m = document.getElementById("wizardModal");
  m.innerHTML = `
    <div class="modal wiz-modal" onclick="event.stopPropagation()" style="max-width:520px;">
      <div class="modal-head">
        <h3>⚠ Deploy hit a problem</h3>
        <button class="close-btn" onclick="finishDeploy()">✕</button>
      </div>
      <div class="modal-body">
        <div class="card" style="background:rgba(244,63,94,0.08);border-color:rgba(244,63,94,0.3);margin-bottom:14px;">
          <p style="margin:0;color:#FECACA;">${escapeHtmlW(msg)}</p>
        </div>
        <p class="text-muted" style="font-size:13px;">Your server was still created — you can manage it from the dashboard.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="finishDeploy()">Go to dashboard</button>
        <button class="btn btn-primary" onclick="goToConsoleAfterDeploy('${escapeHtmlW(sid)}')">Open console</button>
      </div>
    </div>
  `;
}
window.renderDeployProgress = renderDeployProgress;

function showDeploySuccess(r, publicHost, publicPort) {
  const m = document.getElementById("wizardModal");
  const hasTunnel = !!(r.proxy && r.proxy.host && r.proxy.port);
  const isPublic = hasTunnel || !!r.is_public;
  const address = hasTunnel
    ? `${r.proxy.host}:${r.proxy.port}`
    : isPublic
      ? `${publicHost}:${publicPort}`
      : `(waiting for tunnel — refresh in 15s)`;
  const startNote = r.auto_started
    ? '<span class="text-emerald">● Starting now — give it 30–90s to finish booting.</span>'
    : r.start_skipped_reason
      ? `<span class="text-muted">Auto-start skipped: ${escapeHtmlW(r.start_skipped_reason)}. Hit ▶ Start on the dashboard.</span>`
      : "";

  m.innerHTML = `
    <div class="modal wiz-modal" onclick="event.stopPropagation()" style="max-width:560px;">
      <div class="modal-head">
        <h3>🎉 Server deployed</h3>
        <button class="close-btn" onclick="finishDeploy()">✕</button>
      </div>
      <div class="modal-body">
        <p class="text-muted" style="margin-bottom:18px;">Your server "<strong>${escapeHtmlW(wizState.name)}</strong>" is ready.</p>

        ${
          isPublic
            ? `
          <div class="card" style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);margin-bottom:16px;">
            <div style="font-weight:700;margin-bottom:6px;">📡 Share this address with friends</div>
            <div style="display:flex;gap:8px;align-items:center;">
              <code style="flex:1;padding:10px 14px;background:rgba(0,0,0,0.4);border-radius:8px;font-family:var(--font-mono);font-size:15px;font-weight:600;color:#10b981;">${escapeHtmlW(address)}</code>
              <button class="btn btn-primary btn-sm" onclick="copyText('${address}')">Copy</button>
            </div>
            <p class="text-muted" style="font-size:13px;margin-top:10px;">
              Anyone with the Minecraft Java client can paste this into <strong>Multiplayer → Add Server</strong> and join.
            </p>
          </div>
        `
            : `
          <div class="card" style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);margin-bottom:16px;">
            <div style="font-weight:700;margin-bottom:6px;">🔒 Internal server</div>
            <p class="text-muted" style="font-size:13px;margin-bottom:10px;">
              This server runs on internal port <code>${r.port}</code>. To share it with friends, promote it to the public TCP port. Only one server can be public at a time.
            </p>
            <p class="text-muted" style="font-size:13px;">Public address (after promote): <code style="font-weight:600;">${escapeHtmlW(publicHost)}:${publicPort}</code></p>
          </div>
        `
        }

        <div class="text-muted" style="font-size:13px;">${startNote}</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="finishDeploy()">Go to dashboard</button>
        <button class="btn btn-primary" onclick="goToConsoleAfterDeploy('${escapeHtmlW(r.id)}')">Open console →</button>
      </div>
    </div>
  `;
}

function escapeHtmlW(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function finishDeploy() {
  closeWizard();
  setTimeout(() => location.reload(), 300);
}

function goToConsoleAfterDeploy(id) {
  localStorage.setItem("crafthost.currentServerId", id);
  location.href = "/console.html";
}

window.showDeploySuccess = showDeploySuccess;
window.finishDeploy = finishDeploy;
window.goToConsoleAfterDeploy = goToConsoleAfterDeploy;

window.openWizard = openWizard;
window.closeWizard = closeWizard;
window.pickType = pickType;
window.handleJar = handleJar;
window.wizNext = wizNext;
window.wizPrev = wizPrev;
window.wizDeploy = wizDeploy;
