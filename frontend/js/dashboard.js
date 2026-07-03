// Dashboard — real server cards from /api/servers + live status polling.

let servers = [];
let pollTimer = null;
let isDemo = false;

const DEMO_SERVERS = [
  {
    id: "demo-1",
    name: "Survival World",
    type: "paper",
    version: "1.21.1",
    status: "online",
    port: 25565,
    max_players: 25,
    ram_mb: 2048,
    cpu_cores: 2,
    stats: { players: 12, ram_used: 1850, cpu: 34, uptime: 4 * 3600 + 12 * 60 },
    icon: "S",
  },
  {
    id: "demo-2",
    name: "Modded ATM9",
    type: "forge",
    version: "1.20.1",
    status: "online",
    port: 25566,
    max_players: 60,
    ram_mb: 4096,
    cpu_cores: 3,
    stats: { players: 5, ram_used: 3400, cpu: 61, uptime: 12 * 3600 },
    icon: "A",
  },
];

function colorForName(s) {
  const palette = [
    "#00C853",
    "#FFB300",
    "#A855F7",
    "#3B82F6",
    "#EF4444",
    "#01579B",
    "#7CB342",
    "#FF6F00",
  ];
  let h = 0;
  for (const c of s || "?") h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function typeLabel(s) {
  const t = (s.type || "").charAt(0).toUpperCase() + (s.type || "").slice(1);
  return `${t} ${s.version === "LATEST" ? "" : s.version || ""}`.trim();
}

// Real brand-ish inline SVG icons per server type. Geometric, lightweight, no
// external assets. Each returns an SVG sized to fit a 44×44 tile.
const TYPE_ICONS = {
  paper:
    '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 4h12l6 6v18a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#F57C00"/><path d="M20 4v6h6" fill="#FFA940"/><path d="M10 16h12M10 20h12M10 24h8" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>',
  vanilla:
    '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="24" height="24" fill="#7CB342"/><rect x="4" y="4" width="12" height="12" fill="#558B2F"/><rect x="16" y="16" width="12" height="12" fill="#558B2F"/><rect x="4" y="20" width="6" height="6" fill="#8B5A2B"/><rect x="22" y="6" width="6" height="6" fill="#8B5A2B"/></svg>',
  purpur:
    '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 4l10 6v12l-10 6-10-6V10z" fill="#7B1FA2"/><path d="M16 4l10 6v12l-10 6V4z" fill="#5E1791"/><circle cx="16" cy="16" r="4" fill="#E1BEE7"/></svg>',
  fabric:
    '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="#01579B"/><path d="M16 6c-5 0-9 4-9 10 4-2 7-1 9 1s5 3 9 1c0-6-4-12-9-12z" fill="#039BE5"/><circle cx="13" cy="14" r="1.5" fill="white"/><circle cx="19" cy="14" r="1.5" fill="white"/></svg>',
  neoforge:
    '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 6l20 0L26 26L6 26z" fill="#FF6F00"/><path d="M11 11h10v2H11zM11 15h10v2H11zM11 19h6v2h-6z" fill="white"/><circle cx="22" cy="20" r="2" fill="#FFB300"/></svg>',
  forge:
    '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 22l4-12h12l4 12z" fill="#6A1B9A"/><circle cx="16" cy="22" r="4" fill="#9C27B0"/></svg>',
  spigot:
    '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="#E65100"/><path d="M16 8v16M8 16h16" stroke="white" stroke-width="2.5"/></svg>',
  bedrock:
    '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="24" height="24" fill="#37474F"/><rect x="6" y="6" width="6" height="6" fill="#546E7A"/><rect x="14" y="6" width="6" height="6" fill="#455A64"/><rect x="22" y="6" width="4" height="6" fill="#546E7A"/><rect x="6" y="14" width="6" height="6" fill="#455A64"/><rect x="14" y="14" width="6" height="6" fill="#546E7A"/><rect x="22" y="14" width="4" height="6" fill="#455A64"/></svg>',
  custom:
    '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 6h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="#FFB300"/><path d="M16 12v8M12 16h8" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>',
};
function typeIcon(type) {
  return TYPE_ICONS[(type || "").toLowerCase()] || TYPE_ICONS.paper;
}
window.TYPE_ICONS = TYPE_ICONS;
window.typeIcon = typeIcon;

let publicHost = "crafthost-production.up.railway.app";
let publicMcPort = 25565;
// Actual idle-stop window, sent by the backend so the UI never promises a
// different number than the platform enforces.
let idleStopMinutes = 30;
function ipFor(s) {
  if (s.id?.startsWith("demo-"))
    return `${s.name.toLowerCase().replace(/\s+/g, "-")}.crafthost.gg:${s.port}`;
  if (s.tunnel_host && s.tunnel_port)
    return `${s.tunnel_host}:${s.tunnel_port}`;
  if (s.proxy_host && s.proxy_port) return `${s.proxy_host}:${s.proxy_port}`;
  if (s.is_public) return `${publicHost}:${publicMcPort}`;
  // No tunnel yet. While starting it's genuinely "waiting"; when the server
  // is offline there IS no joinable address — returning the proxy host +
  // internal port here showed users a dead address with a Copy button.
  const running = ["online", "running", "starting"].includes(
    String(s.status || "").toLowerCase(),
  );
  if (!running) return null;
  return `${publicHost}:${s.port} (waiting for tunnel…)`;
}

// Tiny SVG sparkline for TPS over the last ~60s. Renders nothing if no history.
// Green when TPS holds 19+; amber 15-19; red <15. Last value shown numerically
// to the right so users get both the trend AND the current absolute value.
function renderTpsSparkline(history, current) {
  if (!Array.isArray(history) || history.length < 2) return "";
  const W = 220,
    H = 28,
    PAD = 2;
  const max = 20;
  // Map values to (x, y) coords
  const pts = history.map((v, i) => {
    const x = PAD + (i / (history.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - Math.max(0, Math.min(max, v)) / max) * (H - PAD * 2);
    return [x, y];
  });
  const d =
    "M " + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L ");
  // Area fill
  const area = d + ` L ${W - PAD} ${H - PAD} L ${PAD} ${H - PAD} Z`;
  const last = current ?? history[history.length - 1] ?? 0;
  const color = last >= 19 ? "#10b981" : last >= 15 ? "#f59e0b" : "#ef4444";
  return `
    <div class="sc-tps-row" title="TPS over last ~60s">
      <svg class="sc-tps-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path d="${area}" fill="${color}" fill-opacity="0.15"/>
        <path d="${d}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <span class="sc-tps-label" style="color:${color};">${last.toFixed(1)} TPS</span>
    </div>`;
}

function renderServer(s) {
  const stats = s.stats || {};
  const ramUsed = stats.ram_used || 0;
  // Prefer the backend-computed realistic process budget (heap × 2) over the
  // plan's advertised heap cap — RSS includes JVM overhead so the plan number
  // alone made the bar overflow.
  const ramMax = stats.ram_max || s.ram_mb || 1024;
  const ramPct = Math.min(100, Math.round((ramUsed / ramMax) * 100)) || 0;
  const playersOnline = stats.players ?? 0;
  const playersMax = stats.players_max || s.max_players || 0;
  const players = stats.online ? `${playersOnline}/${playersMax}` : "—";
  const cpu = stats.cpu != null ? Math.round(stats.cpu) + "%" : "—";
  const uptime = stats.uptime ? fmtTime(stats.uptime) : "—";
  const icon = s.icon || (s.name || "?")[0].toUpperCase();
  const c = colorForName(s.name);

  // Prefer the live stats.online flag (proven by SLP) over the DB status (can lag/lie)
  const liveOnline = stats.online === true;
  // While the DB says the server is running/starting but SLP hasn't confirmed
  // yet (probe lag, 5s SLP cache, boot in progress), show "Starting…" — never
  // fall back to "Offline". Before this, the card flapped Online → Offline →
  // Online on poll ticks and the Start/Stop button flickered with it.
  const dbRunning = ["starting", "online", "running"].includes(
    String(s.status || "").toLowerCase(),
  );
  const isStarting = !liveOnline && dbRunning;
  const isOnline = liveOnline || isStarting;
  const statusKey = liveOnline ? "online" : isStarting ? "starting" : "offline";
  // Pull translated status label so it follows the user's language setting.
  const statusLabel =
    (window.t ? window.t(statusKey) : null) ||
    (liveOnline ? "Online" : isStarting ? "Starting…" : "Offline");
  const motdLine = stats.motd
    ? `<div class="text-muted" style="font-size:11px;margin-top:2px;font-style:italic;">"${escapeHtml(String(stats.motd).slice(0, 60))}"</div>`
    : "";
  const sampleLine = (stats.player_sample || []).length
    ? `<div class="text-muted" style="font-size:11px;margin-top:4px;">👥 ${(stats.player_sample || []).slice(0, 5).map(escapeHtml).join(", ")}${stats.player_sample.length > 5 ? "…" : ""}</div>`
    : "";
  const ip = ipFor(s);

  const slotBadge = s.user_slot
    ? `<span class="badge" style="background:rgba(56,189,248,0.15);color:var(--blue);border:1px solid rgba(56,189,248,0.25);font-size:11px;">#${s.user_slot}</span>`
    : "";
  const publicBadge = s.is_public
    ? `<span class="badge badge-emerald" title="Reachable from Minecraft clients">🌍 Public</span>`
    : `<span class="badge" title="Internal only — promote to play">🔒 Internal</span>`;
  // OOM-aware crash hint. Three states:
  //  1. Auto-healed recently → green "✓ Auto-healed" badge
  //  2. OOM + heavy version → red warn w/ instant-fix button (platform also auto-heals within ~20s)
  //  3. OOM + non-heavy version → generic upgrade hint
  const isOomCrash =
    stats.oom ||
    (s.status === "offline" &&
      stats.exit_code === 0 &&
      (stats.last_log || []).some((l) => /OutOfMemoryError/i.test(l)));
  // "Heavy" = anything that isn't already the proven-safe combo (Paper 1.20.1).
  // Fabric 1.20.1, NeoForge, Purpur, anything 1.21+ all qualify — they need
  // more memory than the plan provides. With 2 GB plan / 1.5 GB heap, this is
  // effectively never true for normal MC versions — kept as a hook for very
  // heavy modpacks that might still OOM.
  const versionIsHeavy = false;
  // auto_healed_at is stored in MILLISECONDS (Date.now() in the auto-heal loop).
  // Comparing it against seconds made this true forever once a server had ever
  // auto-healed, so the green banner never went away.
  const healedRecently =
    s.auto_healed_at && Date.now() - s.auto_healed_at < 600_000; // 10 min window
  // Auto-restart badge — visible for 10 min after the platform restarted a crashed server
  const restartedRecently =
    s.last_auto_restart_at && Date.now() - s.last_auto_restart_at < 600_000;
  const restartCount = s.auto_restart_count || 0;
  let crashHint = "";
  if (healedRecently) {
    crashHint = `<div class="sc-warn sc-warn-healed">
      <strong>✓ Auto-healed</strong>
      <div>The platform detected an out-of-memory crash and switched this server to <strong>Paper 1.21.1</strong>. It will restart automatically.</div>
    </div>`;
  } else if (isOomCrash && versionIsHeavy) {
    crashHint = `<div class="sc-warn sc-warn-actionable">
      <div class="sc-warn-text">
        <strong>⚠ Out of memory</strong>
        <div>Minecraft ${escapeHtml(s.version || "latest")} exceeded available heap. The platform will auto-fix this within 20 seconds.</div>
      </div>
      <button class="btn btn-primary btn-sm sc-fix-btn" onclick="autoFixOom('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
        🔧 Fix it now
      </button>
    </div>`;
  } else if (isOomCrash) {
    crashHint = `<div class="sc-warn">⚠ Server ran out of memory. Try a smaller view distance or upgrade your plan.</div>`;
  } else if (restartedRecently && restartCount > 0) {
    crashHint = `<div class="sc-warn sc-warn-healed">
      <strong>🔁 Auto-restarted</strong>
      <div>The server crashed unexpectedly and was restarted by the platform${restartCount > 1 ? ` (${restartCount}× recently)` : ""}. Check logs if this keeps happening.</div>
    </div>`;
  } else if (
    s.last_idle_stop_at &&
    Date.now() - s.last_idle_stop_at < 30 * 60_000 &&
    s.status === "offline"
  ) {
    // Auto-stopped from inactivity. World was saved before stop — clicking Start
    // resumes exactly where players left off. Pill visible for 30 min after stop.
    const mins = Math.max(
      1,
      Math.round((Date.now() - s.last_idle_stop_at) / 60_000),
    );
    crashHint = `<div class="sc-warn sc-warn-healed">
      <strong>💤 Auto-stopped (no players for ${idleStopMinutes} min)</strong>
      <div>World was saved before shutdown — click <strong>Start</strong> to resume. Player progress, builds, and inventories are intact (last stop: ${mins} min ago).</div>
    </div>`;
  }

  return `
  <div class="server-card" data-id="${escapeHtml(s.id)}">
    <div class="sc-head">
      <div class="sc-title">
        <div class="sc-icon" style="position:relative;">
          ${typeIcon(s.type)}
          ${s.user_slot ? `<span class="sc-slot">#${s.user_slot}</span>` : ""}
        </div>
        <div>
          <div class="sc-name">${escapeHtml(s.name)} ${slotBadge}</div>
          <div class="sc-type">${escapeHtml(typeLabel(s))} · ${publicBadge}</div>
        </div>
      </div>
      <div class="sc-status sc-status-${statusKey}" title="Server is ${statusLabel.toLowerCase()}">
        <span class="sc-status-dot"></span>${escapeHtml(statusLabel)}
      </div>
    </div>

    ${
      ip
        ? `
    <div class="sc-ip" title="Java Edition · click to copy" onclick="copyText('${escapeHtml(ip)}')" style="cursor:pointer;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
      <span style="flex:1;"><span style="font-weight:600;">Java:</span> ${escapeHtml(ip)}</span>
      <span class="sc-copy">Copy</span>
    </div>`
        : `
    <div class="sc-ip" title="Start the server to get its join address" style="opacity:0.7;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <span style="flex:1;"><span style="font-weight:600;">Java:</span> address appears after you press ▶ Start</span>
    </div>`
    }
    ${
      s.playit_host && s.playit_port
        ? `
    <div class="sc-ip" title="Bedrock Edition (mobile / console) · click to copy" onclick="copyText('${escapeHtml(s.playit_host + ":" + s.playit_port)}')" style="cursor:pointer;border-color:rgba(255,107,53,0.35);background:rgba(255,107,53,0.05);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff6b35" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>
      <span style="flex:1;"><span style="font-weight:600;">Bedrock:</span> ${escapeHtml(s.playit_host + ":" + s.playit_port)}</span>
      <span class="sc-copy">Copy</span>
    </div>`
        : s.playit_enabled
          ? `
    <div class="sc-ip" title="Bedrock cross-play is on — waiting for tunnel address" onclick="openBedrockModal('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')" style="cursor:pointer;border-color:rgba(255,107,53,0.35);background:rgba(255,107,53,0.05);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff6b35" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>
      <span style="flex:1;"><span style="font-weight:600;">Bedrock:</span> on — connecting…</span>
      <span class="sc-copy">Details</span>
    </div>`
          : [
                "paper",
                "spigot",
                "purpur",
                "vanilla",
                "fabric",
                "neoforge",
              ].includes((s.type || "").toLowerCase())
            ? `
    <div class="sc-ip sc-bedrock-enable" title="Enable Bedrock cross-play — mobile / Xbox / Switch / PS players" onclick="openBedrockModal('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')" style="cursor:pointer;border-style:dashed;border-color:rgba(255,107,53,0.5);background:rgba(255,107,53,0.04);">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff6b35" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>
      <span style="flex:1;"><span style="font-weight:600;">Enable Bedrock cross-play</span> <span style="opacity:.65;font-size:11px;">mobile / console</span></span>
      <span class="sc-copy" style="background:rgba(255,107,53,0.18);color:#ff6b35;">Enable →</span>
    </div>`
            : ""
    }
    ${motdLine}
    ${sampleLine}
    ${crashHint}

    <div class="sc-meta">
      <div class="sc-stat"><div class="v">${players}</div><div class="l">Players</div></div>
      <div class="sc-stat"><div class="v">${cpu}</div><div class="l">CPU</div></div>
      <div class="sc-stat"><div class="v">${uptime}</div><div class="l">Uptime</div></div>
    </div>

    ${renderTpsSparkline(stats.tps_history, stats.tps)}

    <div style="font-size:12px;color:var(--slate-400);margin-bottom:4px;display:flex;justify-content:space-between;">
      <span>RAM</span><span>${ramUsed >= 1024 ? (ramUsed / 1024).toFixed(1) + " GB" : ramUsed + " MB"} / ${(ramMax / 1024).toFixed(1)} GB</span>
    </div>
    <div class="sc-bar"><div style="width:${ramPct}%"></div></div>

    <div class="sc-actions">
      <div class="sc-primary-row">
        ${
          isOnline
            ? `<button class="btn btn-danger sc-primary" onclick="serverAction('${escapeHtml(s.id)}', 'stop')">■ Stop Server</button>
             <button class="btn btn-warning sc-icon-btn" onclick="serverAction('${escapeHtml(s.id)}', 'restart')" title="Restart server" aria-label="Restart server">⟳</button>`
            : `<button class="btn btn-primary sc-primary" onclick="serverAction('${escapeHtml(s.id)}', 'start')">▶ Start Server</button>`
        }
        <button class="btn btn-secondary sc-icon-btn sc-console-btn" onclick="goToConsole('${escapeHtml(s.id)}')" title="Open console" aria-label="Open console">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        </button>
        <button class="btn btn-secondary sc-icon-btn sc-menu-btn" onclick="toggleCardMenu(event, '${escapeHtml(s.id)}')" title="More actions" aria-label="More actions" aria-haspopup="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>
      <div class="sc-menu" id="sc-menu-${escapeHtml(s.id)}" role="menu">
        <button role="menuitem" onclick="closeCardMenu();openLogs('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">📜</span><span>View Logs</span>
        </button>
        <button role="menuitem" onclick="closeCardMenu();openSettings('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">⚙️</span><span>Settings</span>
        </button>
        <button role="menuitem" onclick="closeCardMenu();openSwapJar('${escapeHtml(s.id)}', '${escapeHtml(s.type)}', '${escapeHtml(s.version || "")}', '${escapeHtml(s.plan_id || "free")}')">
          <span class="sc-menu-icon">📦</span><span>Change JAR</span>
        </button>
        <button role="menuitem" onclick="closeCardMenu();copyText('${escapeHtml(ip)}')">
          <span class="sc-menu-icon">📋</span><span>Copy address</span>
        </button>
        ${
          [
            "paper",
            "spigot",
            "purpur",
            "vanilla",
            "fabric",
            "neoforge",
          ].includes((s.type || "").toLowerCase())
            ? `
        <button role="menuitem" onclick="closeCardMenu();openBedrockModal('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">📱</span><span>${s.playit_enabled ? "Bedrock cross-play (ON)" : "Enable Bedrock cross-play"}</span>
        </button>`
            : ""
        }
        ${
          !s.is_public
            ? `<button role="menuitem" onclick="closeCardMenu();promoteServer('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">🌍</span><span>Make Public</span>
        </button>`
            : ""
        }
        <button role="menuitem" onclick="closeCardMenu();openCloneDialog('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">📑</span><span>Clone server</span>
        </button>
        <button role="menuitem" onclick="closeCardMenu();openWorldImport('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">🌍</span><span>Import world.zip</span>
        </button>
        <button role="menuitem" onclick="closeCardMenu();openBackups('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">💾</span><span>Backups</span>
        </button>
        <div class="sc-menu-sep"></div>
        <button role="menuitem" class="sc-menu-danger" onclick="closeCardMenu();openDeleteConfirm('${escapeHtml(s.id)}', '${escapeHtml(s.name)}')">
          <span class="sc-menu-icon">🗑</span><span>Delete server</span>
        </button>
      </div>
    </div>
  </div>`;
}

// Custom delete confirmation modal (replaces browser confirm() so it's
// styled, has typed confirmation, and gives accurate consequence text).
function openDeleteConfirm(sid, name) {
  let modal = document.getElementById("delServerModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "delServerModal";
    modal.className = "modal-bg";
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:440px;">
      <div class="modal-head" style="border-bottom:1px solid var(--glass-border);">
        <h3 style="color:var(--red);">🗑 Delete server</h3>
        <button class="close-btn" onclick="document.getElementById('delServerModal').classList.remove('show')">✕</button>
      </div>
      <div class="modal-body">
        <p style="color:var(--slate-300);margin-bottom:12px;">
          You are about to <strong>permanently</strong> delete:
        </p>
        <div style="padding:12px 16px;background:var(--slate-800);border-radius:8px;font-weight:700;margin-bottom:14px;">
          ${escapeHtml(name)}
        </div>
        <p class="text-muted" style="font-size:13px;margin-bottom:14px;">
          This stops the JVM, removes the world data, releases the public tunnel, and erases all backups. There is no undo.
        </p>
        <div class="field">
          <label class="label">Type the server name to confirm</label>
          <input id="delConfirmInput" class="input" placeholder="${escapeHtml(name)}" autocomplete="off" />
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="document.getElementById('delServerModal').classList.remove('show')">Cancel</button>
        <button class="btn btn-danger" id="delServerGo" disabled>Delete forever</button>
      </div>
    </div>
  `;
  modal.classList.add("show");
  const input = document.getElementById("delConfirmInput");
  const btn = document.getElementById("delServerGo");
  input.addEventListener("input", () => {
    btn.disabled = input.value.trim() !== name;
  });
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "⏳ Deleting…";
    try {
      await api(`/api/servers/${sid}`, { method: "DELETE" });
      toast("Server deleted");
      modal.classList.remove("show");
      loadServers();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Delete forever";
    }
  };
}

// Inline logs viewer modal. Shows the last 200 lines from /api/servers/:id/logs
// so users can debug boot failures without going to /console.html.
async function openLogs(sid, name) {
  let modal = document.getElementById("logsModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "logsModal";
    modal.className = "modal-bg";
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:820px;width:95%;">
      <div class="modal-head">
        <h3>📜 Logs · ${escapeHtml(name)}</h3>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-ghost btn-sm" id="logsRefresh">↻ Refresh</button>
          <button class="close-btn" id="logsClose">✕</button>
        </div>
      </div>
      <div class="modal-body" style="padding:0;">
        <pre id="logsContent" style="margin:0;padding:16px 20px;font-family:var(--font-mono);font-size:12px;line-height:1.5;color:var(--slate-300);background:#000;height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word;">Loading…</pre>
      </div>
      <div class="modal-foot" style="border-top:1px solid var(--glass-border);">
        <span class="text-muted" style="font-size:12px;margin-right:auto;">Last 200 lines · auto-refreshes</span>
        <label class="flex items-center gap-2" style="font-size:13px;"><input type="checkbox" id="logsAuto" checked /> Auto-refresh</label>
      </div>
    </div>
  `;
  modal.classList.add("show");
  let autoTimer = null;
  async function refresh() {
    try {
      const r = await api(`/api/servers/${sid}/logs?lines=200`);
      const pre = document.getElementById("logsContent");
      if (!pre) return;
      pre.textContent = r.logs.length
        ? r.logs.join("\n")
        : r.note || "(no logs — server hasn't started yet)";
      pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      const pre = document.getElementById("logsContent");
      if (pre) pre.textContent = "Failed to load: " + err.message;
    }
  }
  function clearAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }
  function startAuto() {
    clearAuto();
    autoTimer = setInterval(refresh, 3000);
  }
  document.getElementById("logsRefresh").onclick = refresh;
  document.getElementById("logsAuto").onchange = (e) =>
    e.target.checked ? startAuto() : clearAuto();
  // ✕ must also stop the auto-refresh timer — before this it kept polling
  // /logs every 3s forever after the modal was closed.
  document.getElementById("logsClose").onclick = () => {
    clearAuto();
    modal.classList.remove("show");
  };
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      clearAuto();
      modal.classList.remove("show");
    }
  });
  refresh();
  startAuto();
}

window.openDeleteConfirm = openDeleteConfirm;
window.openLogs = openLogs;

// Card overflow menu — single-open. Click-outside / escape / scroll closes.
function closeCardMenu() {
  document
    .querySelectorAll(".sc-menu.show")
    .forEach((el) => el.classList.remove("show"));
  document
    .querySelectorAll(".sc-menu-btn.active")
    .forEach((el) => el.classList.remove("active"));
}
function toggleCardMenu(evt, sid) {
  evt.stopPropagation();
  const menu = document.getElementById(`sc-menu-${sid}`);
  if (!menu) return;
  const wasOpen = menu.classList.contains("show");
  closeCardMenu();
  if (!wasOpen) {
    menu.classList.add("show");
    evt.currentTarget.classList.add("active");
  }
}
window.closeCardMenu = closeCardMenu;
window.toggleCardMenu = toggleCardMenu;

// One-click OOM self-heal — wipes the heavy JAR and swaps to Paper 1.20.1.
// The platform also has a background auto-heal loop; this gives impatient users
// instant action without waiting for the next loop tick.
async function autoFixOom(sid, name) {
  if (
    !confirm(
      `Swap "${name}" to Paper 1.21.1 and restart now?\n\nThis fixes the out-of-memory crash. Your world data is preserved.`,
    )
  )
    return;
  try {
    toast(`🔧 Healing ${name}…`);
    await api(`/api/servers/${sid}/swap-jar`, {
      // force: the user just confirmed this recovery swap, and the crashed
      // version may be newer than 1.21.1 (which would trip the downgrade guard).
      method: "POST",
      body: { type: "paper", version: "1.21.1", force: true },
    });
    toast(`✓ ${name} restarted with Paper 1.21.1`);
    loadServers();
  } catch (err) {
    toast(err.message || "Auto-fix failed", "error");
  }
}
window.autoFixOom = autoFixOom;
document.addEventListener("click", (e) => {
  if (!e.target.closest(".sc-menu") && !e.target.closest(".sc-menu-btn"))
    closeCardMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCardMenu();
});

// ── Swap-JAR modal ─────────────────────────────────────────────────
async function openSwapJar(sid, curType, curVer, planId) {
  planId = planId || "free";
  const isFree = planId === "free";
  // Mirror isHeavyVersion from wizard.js (currently always false with 2GB plan).
  const heavy = (v) => {
    if (!v || v === "LATEST") return true;
    const m = String(v).match(/^1\.(\d+)/);
    return m ? parseInt(m[1], 10) >= 21 : false;
  };
  // Numeric MC version compare, mirrors the backend's downgrade guard
  // ("1.20.1" < "1.21" < "26.2"). True when `to` is strictly older.
  const isDowngrade = (from, to) => {
    const parse = (v) => {
      const m = String(v || "").match(/^(\d+(?:\.\d+)*)/);
      return m ? m[1].split(".").map(Number) : null;
    };
    const a = parse(from),
      b = parse(to);
    if (!a || !b) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0,
        y = b[i] || 0;
      if (y < x) return true;
      if (y > x) return false;
    }
    return false;
  };
  let modal = document.getElementById("swapJarModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "swapJarModal";
    modal.className = "modal-bg";
    document.body.appendChild(modal);
  }
  modal.classList.add("show");
  modal.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:520px;">
      <div class="modal-head">
        <h3>Change Server JAR</h3>
        <button class="close-btn" onclick="document.getElementById('swapJarModal').classList.remove('show')">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label">Server Type</label>
          <select class="select" id="sjType">
            ${["paper", "vanilla", "purpur", "fabric"].map((t) => `<option value="${t}" ${t === curType ? "selected" : ""}>${t[0].toUpperCase() + t.slice(1)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label class="label">Version (latest 10)</label>
          <select class="select" id="sjVersion"><option>Loading…</option></select>
        </div>
        <div id="sjWarn"></div>
        <div id="sjError"></div>
        <p class="text-muted" style="font-size:13px;">⚠ Server will stop, download new JAR (~30s), and restart automatically. Your world data is preserved.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="document.getElementById('swapJarModal').classList.remove('show')">Cancel</button>
        <button class="btn btn-primary" id="sjApply">Apply</button>
      </div>
    </div>
  `;
  function updateWarn() {
    const v = document.getElementById("sjVersion").value;
    const warn = document.getElementById("sjWarn");
    if (isFree && heavy(v)) {
      warn.innerHTML = `<div class="wiz-warn" role="alert">
        <strong>⚠ This version may OOM on the Free plan.</strong>
        <p>Minecraft ${v} may exceed your plan's heap on boot. Pick a lighter version if it crashes.</p>
      </div>`;
    } else {
      warn.innerHTML = "";
    }
  }
  async function loadVer() {
    const type = document.getElementById("sjType").value;
    const sel = document.getElementById("sjVersion");
    sel.innerHTML = "<option>Loading…</option>";
    try {
      const r = await fetch(
        `/api/versions/${encodeURIComponent(type)}?limit=50`,
        { credentials: "include" },
      );
      const d = await r.json();
      const vs = d.versions || [];
      // Pick the safest default for free plan: prefer current version if not heavy,
      // else first non-heavy in the list, else first item.
      const safeFor =
        planId === "free"
          ? vs.find((v) => v.id === curVer && !heavy(v.id))?.id ||
            vs.find((v) => !heavy(v.id))?.id ||
            vs[0]?.id
          : vs.find((v) => v.id === curVer)?.id || vs[0]?.id;
      // Group by major.minor (1.21.x, 1.20.x, ...) so a long list stays readable.
      const groups = {};
      for (const v of vs) {
        const m = String(v.id).match(/^(\d+\.\d+)/);
        const key = m ? m[1] + ".x" : "other";
        (groups[key] = groups[key] || []).push(v);
      }
      const groupKeys = Object.keys(groups).sort((a, b) => {
        const ax = a.split(".").map((n) => parseInt(n, 10) || 0);
        const bx = b.split(".").map((n) => parseInt(n, 10) || 0);
        return bx[0] - ax[0] || bx[1] - ax[1];
      });
      sel.innerHTML =
        groupKeys
          .map(
            (gk) =>
              `<optgroup label="Minecraft ${escapeHtml(gk)}">${groups[gk]
                .map((v) => {
                  const isCur = v.id === curVer;
                  const isSel = v.id === safeFor;
                  const tags = [];
                  if (isCur) tags.push("Current");
                  if (isDowngrade(curVer, v.id)) tags.push("⚠ older than current");
                  if (isFree && heavy(v.id)) tags.push("⚠ may OOM");
                  if (isFree && !heavy(v.id) && v.id === safeFor)
                    tags.push("✓ recommended");
                  const tag = tags.length ? ` — ${tags.join(" · ")}` : "";
                  return `<option value="${escapeHtml(v.id)}" ${isSel ? "selected" : ""}>${escapeHtml(v.id)}${tag}</option>`;
                })
                .join("")}</optgroup>`,
          )
          .join("") || "<option>(no versions)</option>";
      sel.onchange = () => {
        // New selection invalidates a pending downgrade confirmation.
        forceNext = false;
        document.getElementById("sjError").innerHTML = "";
        document.getElementById("sjApply").textContent = "Apply";
        updateWarn();
      };
      updateWarn();
    } catch {
      sel.innerHTML = "<option>Failed to fetch</option>";
    }
  }
  document.getElementById("sjType").onchange = () => {
    // Changing the picker invalidates a pending downgrade confirmation.
    forceNext = false;
    document.getElementById("sjError").innerHTML = "";
    document.getElementById("sjApply").textContent = "Apply";
    loadVer();
  };
  // Set after an unsafe_downgrade 409: the next Apply click resends with
  // force:true. Reset whenever the selection changes.
  let forceNext = false;
  const sjError = (html) => {
    document.getElementById("sjError").innerHTML = html
      ? `<div class="wiz-warn" role="alert">${html}</div>`
      : "";
  };
  document.getElementById("sjApply").onclick = async () => {
    const type = document.getElementById("sjType").value;
    const version = document.getElementById("sjVersion").value;
    const btn = document.getElementById("sjApply");
    btn.disabled = true;
    btn.textContent = "⏳ Swapping…";
    sjError("");
    try {
      await api(`/api/servers/${sid}/swap-jar`, {
        method: "POST",
        body: forceNext ? { type, version, force: true } : { type, version },
      });
      toast(`✓ Swapping to ${type} ${version} — restarting…`);
      document.getElementById("swapJarModal").classList.remove("show");
      // Flip the card to "Starting…" immediately and tight-poll until online,
      // same as serverAction — the backend marks it starting right away.
      const s = servers.find((x) => x.id === sid);
      if (s) {
        s.status = "starting";
        s.type = type;
        s.version = version;
      }
      renderServers();
      tightPollServerStatus(sid, "online");
      loadServers();
    } catch (err) {
      const code = err?.data?.code;
      if (code === "unsafe_downgrade") {
        forceNext = true;
        sjError(
          `<strong>⚠ Older version selected</strong><p>${escapeHtml(err.message)}</p>`,
        );
        btn.disabled = false;
        btn.textContent = "⚠ Downgrade anyway";
        return;
      }
      forceNext = false;
      if (code === "busy") {
        sjError(
          `<strong>⏳ Server is busy</strong><p>${escapeHtml(err.message)}</p>`,
        );
      } else if (code === "running_quota") {
        sjError(
          `<strong>Another server is running</strong><p>${escapeHtml(err.message)}</p>`,
        );
      } else if (code === "swap_failed") {
        sjError(
          `<strong>Version change failed — server restored</strong><p>${escapeHtml(err.message)}</p>`,
        );
        loadServers();
      } else {
        sjError(`<p>${escapeHtml(err.message || "Swap failed")}</p>`);
      }
      btn.disabled = false;
      btn.textContent = "Apply";
    }
  };
  loadVer();
}

// ── Backups modal ──────────────────────────────────────────────────
function fmtBackupSize(b) {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  if (b >= 1024) return Math.round(b / 1024) + " KB";
  return b + " B";
}

async function openBackups(sid, name) {
  let modal = document.getElementById("backupsModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "backupsModal";
    modal.className = "modal-bg";
    document.body.appendChild(modal);
  }
  modal.classList.add("show");
  modal.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:560px;">
      <div class="modal-head">
        <h3>💾 Backups — ${escapeHtml(name)}</h3>
        <button class="close-btn" onclick="document.getElementById('backupsModal').classList.remove('show')">✕</button>
      </div>
      <div class="modal-body">
        <div id="bkError"></div>
        <div id="bkList" class="text-muted">Loading…</div>
        <p class="text-muted" style="font-size:12px;margin-top:10px;">
          Snapshots include your worlds, server.properties, and player lists.
          A running server is stopped for a few seconds while the snapshot is taken, then restarted.
          Automatic backups are taken before risky changes (downgrades, engine swaps, world imports, restores).
        </p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="document.getElementById('backupsModal').classList.remove('show')">Close</button>
        <button class="btn btn-primary" id="bkCreate">📸 Back up now</button>
      </div>
    </div>
  `;
  const bkError = (html) => {
    document.getElementById("bkError").innerHTML = html
      ? `<div class="wiz-warn" role="alert">${html}</div>`
      : "";
  };
  const setBusy = (busy, text) => {
    const btn = document.getElementById("bkCreate");
    btn.disabled = busy;
    btn.textContent = busy ? text || "⏳ Working…" : "📸 Back up now";
    document
      .querySelectorAll("#bkList button")
      .forEach((b) => (b.disabled = busy));
  };
  const showErr = (err, fallback) => {
    const code = err?.data?.code;
    if (code === "busy") {
      bkError(`<strong>⏳ Server is busy</strong><p>${escapeHtml(err.message)}</p>`);
    } else {
      bkError(`<p>${escapeHtml(err.message || fallback)}</p>`);
    }
  };

  async function refresh() {
    const host = document.getElementById("bkList");
    try {
      const r = await api(`/api/servers/${sid}/backups`);
      const items = r.backups || [];
      if (!items.length) {
        host.innerHTML = `<div class="text-muted">No backups yet. Take one before making big changes!</div>`;
        return;
      }
      host.innerHTML = items
        .map((b) => {
          const when = new Date(b.created_at).toLocaleString();
          const badge = b.auto
            ? `<span class="badge" style="background:rgba(56,189,248,0.15);color:var(--blue);font-size:10px;">auto</span>`
            : `<span class="badge badge-emerald" style="font-size:10px;">manual</span>`;
          const label = b.label
            ? `<span class="text-muted" style="font-size:11px;"> · ${escapeHtml(b.label.replace(/^auto-/, "").replace(/-/g, " "))}</span>`
            : "";
          return `
          <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(148,163,184,0.12);">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;">${badge}${label}</div>
              <div class="text-muted" style="font-size:11px;">${escapeHtml(when)} · ${fmtBackupSize(b.size)}</div>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="restoreBackup('${escapeHtml(sid)}','${escapeHtml(b.id)}','${escapeHtml(name)}')">↩ Restore</button>
            <button class="btn btn-ghost btn-sm" onclick="window.open('/api/servers/${escapeHtml(sid)}/backups/${encodeURIComponent(b.id)}/download','_blank')" title="Download zip">⬇</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red,#f87171);" onclick="deleteBackup('${escapeHtml(sid)}','${escapeHtml(b.id)}','${escapeHtml(name)}')" title="Delete backup">🗑</button>
          </div>`;
        })
        .join("");
    } catch (err) {
      host.innerHTML = `<div class="text-muted">Could not load backups — ${escapeHtml(err.message)}</div>`;
    }
  }

  document.getElementById("bkCreate").onclick = async () => {
    bkError("");
    setBusy(true, "⏳ Snapshotting…");
    try {
      const r = await api(`/api/servers/${sid}/backups`, {
        method: "POST",
        body: {},
      });
      toast(`✓ Backup created (${fmtBackupSize(r.size)})`);
      if (r.was_running) {
        const s = servers.find((x) => x.id === sid);
        if (s) s.status = "starting";
        renderServers();
        tightPollServerStatus(sid, "online");
      }
      await refresh();
    } catch (err) {
      showErr(err, "Backup failed");
    } finally {
      setBusy(false);
    }
  };

  // Expose per-item handlers (inline onclick above).
  window.restoreBackup = async (sid2, bid, name2) => {
    if (
      !confirm(
        `Restore this backup on "${name2}"?\n\nYour CURRENT world will be replaced. A safety backup of it is taken first, so you can undo this restore.`,
      )
    )
      return;
    bkError("");
    setBusy(true, "⏳ Restoring…");
    try {
      const r = await api(`/api/servers/${sid2}/backups/${encodeURIComponent(bid)}/restore`, {
        method: "POST",
      });
      toast("✓ World restored" + (r.restarted ? " — restarting server" : ""));
      if (r.restarted) {
        const s = servers.find((x) => x.id === sid2);
        if (s) s.status = "starting";
        renderServers();
        tightPollServerStatus(sid2, "online");
      }
      await refresh();
    } catch (err) {
      showErr(err, "Restore failed");
    } finally {
      setBusy(false);
    }
  };
  window.deleteBackup = async (sid2, bid, name2) => {
    if (!confirm(`Delete this backup of "${name2}"? This cannot be undone.`)) return;
    bkError("");
    try {
      await api(`/api/servers/${sid2}/backups/${encodeURIComponent(bid)}`, {
        method: "DELETE",
      });
      toast("✓ Backup deleted");
      await refresh();
    } catch (err) {
      showErr(err, "Delete failed");
    }
  };

  refresh();
}
window.openBackups = openBackups;

async function promoteServer(sid, name) {
  if (
    !confirm(
      `Promote "${name}" to the public port? Any other public server will be demoted.`,
    )
  )
    return;
  try {
    const r = await api(`/api/servers/${sid}/promote`, { method: "POST" });
    toast(`✓ "${name}" is now public on ${r.public_host}:${r.mc_port}`);
    loadServers();
  } catch (err) {
    toast(err.message, "error");
  }
}

window.openSwapJar = openSwapJar;
window.promoteServer = promoteServer;

// ── Server Settings modal ─────────────────────────────────────────────
async function openSettings(sid, name) {
  let modal = document.getElementById("settingsModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "settingsModal";
    modal.className = "modal-bg";
    document.body.appendChild(modal);
  }
  modal.classList.add("show");
  modal.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:560px;">
      <div class="modal-head">
        <h3>⚙ Settings · ${escapeHtml(name)}</h3>
        <button class="close-btn" onclick="document.getElementById('settingsModal').classList.remove('show')">✕</button>
      </div>
      <div class="modal-body">
        <div id="setLoading" class="text-muted">Loading current settings…</div>
        <div id="setForm" style="display:none;">
          <div class="set-icon-row">
            <div class="set-icon-preview">
              <img id="set_icon_img" alt="Server icon" />
              <div id="set_icon_empty" class="set-icon-empty">No icon</div>
            </div>
            <div style="flex:1;min-width:0;">
              <div class="label" style="margin-bottom:6px;">Server icon</div>
              <p class="text-muted" style="font-size:11.5px;margin:0 0 8px;">PNG, 64×64 recommended. Shown to players in their server list.</p>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <input type="file" id="set_icon_file" accept="image/png" style="display:none;" />
                <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('set_icon_file').click()">📁 Choose PNG</button>
                <button type="button" class="btn btn-ghost btn-sm" id="set_icon_remove" style="display:none;">Remove</button>
              </div>
              <div id="set_icon_status" style="font-size:12px;margin-top:6px;color:var(--slate-400);"></div>
            </div>
          </div>
          <div class="field"><label class="label">MOTD <span class="text-muted" style="font-weight:400;font-size:11.5px;">(use &amp;X color codes)</span></label><input class="input" id="set_motd" maxlength="120" /></div>
          <div class="motd-colors" id="motdColors"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
            <div class="field"><label class="label">Gamemode</label>
              <select class="select" id="set_gamemode"><option value="survival">Survival</option><option value="creative">Creative</option><option value="adventure">Adventure</option><option value="spectator">Spectator</option></select>
            </div>
            <div class="field"><label class="label">Difficulty</label>
              <select class="select" id="set_difficulty"><option value="peaceful">Peaceful</option><option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option></select>
            </div>
            <div class="field"><label class="label">Max Players</label><input class="input" type="number" id="set_max_players" min="1" max="999" /></div>
            <div class="field"><label class="label">View Distance</label><input class="input" type="number" id="set_view_distance" min="3" max="32" /></div>
            <div class="field"><label class="label">Simulation Distance</label><input class="input" type="number" id="set_simulation_distance" min="3" max="32" /></div>
            <div class="field"><label class="label">Spawn Protection <span class="text-muted" style="font-weight:400;font-size:11.5px;">(blocks, 0=off)</span></label><input class="input" type="number" id="set_spawn_protection" min="0" max="64" /></div>
          </div>
          <div style="display:flex;gap:14px 18px;flex-wrap:wrap;margin-top:6px;">
            <label class="flex items-center gap-2"><input type="checkbox" id="set_pvp" /> Enable PvP</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_hardcore" /> Hardcore</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_whitelist" /> Whitelist</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_allow_flight" /> Allow flight</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_allow_nether" /> Allow Nether</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_command_blocks" /> Command blocks</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_force_gamemode" /> Force gamemode</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_spawn_monsters" /> Spawn monsters</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_spawn_animals" /> Spawn animals</label>
            <label class="flex items-center gap-2"><input type="checkbox" id="set_spawn_npcs" /> Spawn villagers</label>
          </div>
          <div class="field" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--glass-border);">
            <label class="label">⏰ Scheduled daily restart <span class="text-muted" style="font-weight:400;font-size:11.5px;">(UTC — clears memory leaks)</span></label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="time" id="set_schedrestart" class="input" style="max-width:140px;" placeholder="HH:MM" />
              <button type="button" class="btn btn-ghost btn-sm" onclick="document.getElementById('set_schedrestart').value=''">Disable</button>
              <span class="text-muted" style="font-size:12px;">Empty = off</span>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <label class="flex items-center gap-2" style="margin-right:auto;"><input type="checkbox" id="set_restart" checked /> Restart to apply</label>
        <button class="btn btn-ghost" onclick="document.getElementById('settingsModal').classList.remove('show')">Cancel</button>
        <button class="btn btn-primary" id="set_save" disabled>Save</button>
      </div>
    </div>
  `;
  function applyProps(p) {
    document.getElementById("setLoading").style.display = "none";
    document.getElementById("setForm").style.display = "block";
    document.getElementById("set_save").disabled = false;
    document.getElementById("set_motd").value =
      p["motd"] != null ? p["motd"] : "";
    document.getElementById("set_gamemode").value = p["gamemode"] || "survival";
    document.getElementById("set_difficulty").value =
      p["difficulty"] || "normal";
    document.getElementById("set_max_players").value = p["max-players"] || "10";
    document.getElementById("set_view_distance").value =
      p["view-distance"] || "10";
    document.getElementById("set_simulation_distance").value =
      p["simulation-distance"] || "10";
    document.getElementById("set_spawn_protection").value =
      p["spawn-protection"] != null ? p["spawn-protection"] : "16";
    // Booleans — fall back to Minecraft's own defaults when the key is absent
    // (brand-new server whose properties file hasn't been generated yet).
    const boolOn = (key, def) => String(p[key] ?? def).toLowerCase() === "true";
    document.getElementById("set_pvp").checked = boolOn("pvp", "true");
    document.getElementById("set_hardcore").checked = boolOn(
      "hardcore",
      "false",
    );
    document.getElementById("set_whitelist").checked = boolOn(
      "white-list",
      "false",
    );
    document.getElementById("set_allow_flight").checked = boolOn(
      "allow-flight",
      "false",
    );
    document.getElementById("set_allow_nether").checked = boolOn(
      "allow-nether",
      "true",
    );
    document.getElementById("set_command_blocks").checked = boolOn(
      "enable-command-block",
      "false",
    );
    document.getElementById("set_force_gamemode").checked = boolOn(
      "force-gamemode",
      "false",
    );
    document.getElementById("set_spawn_monsters").checked = boolOn(
      "spawn-monsters",
      "true",
    );
    document.getElementById("set_spawn_animals").checked = boolOn(
      "spawn-animals",
      "true",
    );
    document.getElementById("set_spawn_npcs").checked = boolOn(
      "spawn-npcs",
      "true",
    );
    // Scheduled restart isn't in server.properties — pull from the cached
    // server row that the dashboard list keeps in `servers`.
    const row = (servers || []).find((x) => x.id === sid);
    document.getElementById("set_schedrestart").value =
      row?.scheduled_restart_at || "";
  }
  try {
    const r = await api(`/api/servers/${sid}/properties`);
    applyProps(r.properties || {});
  } catch (err) {
    // Brand-new server — properties file not generated yet. Show form with
    // sane defaults so the user can save initial settings; the backend will
    // create the file on PATCH.
    applyProps({});
    const note = document.createElement("div");
    note.className = "text-muted";
    note.style.cssText =
      "font-size:12px;margin-top:10px;color:var(--slate-400);";
    note.textContent = `Server hasn't been started yet — saving will create the initial config.`;
    document.getElementById("setForm").appendChild(note);
  }
  // ── Server icon ───────────────────────────────────────────────────────────
  const iconImg = document.getElementById("set_icon_img");
  const iconEmpty = document.getElementById("set_icon_empty");
  const iconRemoveBtn = document.getElementById("set_icon_remove");
  function setIconState(hasIcon) {
    if (hasIcon) {
      iconImg.src = `/api/servers/${sid}/icon?_=${Date.now()}`;
      iconImg.style.display = "block";
      iconEmpty.style.display = "none";
      iconRemoveBtn.style.display = "";
    } else {
      iconImg.style.display = "none";
      iconImg.removeAttribute("src");
      iconEmpty.style.display = "flex";
      iconRemoveBtn.style.display = "none";
    }
  }
  // Probe whether an icon exists
  try {
    const probe = await fetch(`/api/servers/${sid}/icon`, {
      credentials: "include",
    });
    setIconState(probe.ok);
  } catch {
    setIconState(false);
  }

  document
    .getElementById("set_icon_file")
    .addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const status = document.getElementById("set_icon_status");
      if (file.size > 256 * 1024) {
        status.textContent = "✗ PNG too large (max 256 KB)";
        status.style.color = "var(--red, #ef4444)";
        return;
      }
      if (!/^image\/png$/i.test(file.type) && !/\.png$/i.test(file.name)) {
        status.textContent = "✗ Must be a PNG";
        status.style.color = "var(--red, #ef4444)";
        return;
      }
      status.style.color = "var(--slate-300)";
      status.textContent = "Uploading…";
      const fd = new FormData();
      fd.append("icon", file, file.name);
      try {
        const r = await fetch(`/api/servers/${sid}/icon`, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok && body.ok) {
          status.style.color = "var(--emerald)";
          status.textContent = `✓ Saved (${(body.size / 1024).toFixed(1)} KB) — restart to apply`;
          setIconState(true);
        } else {
          status.style.color = "var(--red, #ef4444)";
          status.textContent = "✗ " + (body.error || `HTTP ${r.status}`);
        }
      } catch (err) {
        status.style.color = "var(--red, #ef4444)";
        status.textContent = "✗ " + err.message;
      }
    });
  iconRemoveBtn.addEventListener("click", async () => {
    const status = document.getElementById("set_icon_status");
    try {
      const r = await api(`/api/servers/${sid}/icon`, { method: "DELETE" });
      if (r.ok) {
        setIconState(false);
        status.style.color = "var(--emerald)";
        status.textContent = "✓ Icon removed — restart to apply";
      }
    } catch (err) {
      status.style.color = "var(--red, #ef4444)";
      status.textContent = "✗ " + err.message;
    }
  });

  // ── MOTD color picker ────────────────────────────────────────────────────
  // The 16 Minecraft colors + 6 formatting codes. Clicking a swatch inserts
  // the code at the cursor position in the MOTD field.
  const MC_COLORS = [
    { code: "0", name: "black", hex: "#000000" },
    { code: "1", name: "dark blue", hex: "#0000AA" },
    { code: "2", name: "dark green", hex: "#00AA00" },
    { code: "3", name: "dark aqua", hex: "#00AAAA" },
    { code: "4", name: "dark red", hex: "#AA0000" },
    { code: "5", name: "dark purple", hex: "#AA00AA" },
    { code: "6", name: "gold", hex: "#FFAA00" },
    { code: "7", name: "gray", hex: "#AAAAAA" },
    { code: "8", name: "dark gray", hex: "#555555" },
    { code: "9", name: "blue", hex: "#5555FF" },
    { code: "a", name: "green", hex: "#55FF55" },
    { code: "b", name: "aqua", hex: "#55FFFF" },
    { code: "c", name: "red", hex: "#FF5555" },
    { code: "d", name: "light purple", hex: "#FF55FF" },
    { code: "e", name: "yellow", hex: "#FFFF55" },
    { code: "f", name: "white", hex: "#FFFFFF" },
  ];
  const MC_FORMATS = [
    { code: "l", name: "bold", label: "B" },
    { code: "o", name: "italic", label: "I" },
    { code: "n", name: "underline", label: "U" },
    { code: "m", name: "strikethrough", label: "S" },
    { code: "k", name: "obfuscated", label: "▓" },
    { code: "r", name: "reset", label: "⤺" },
  ];
  const motdInput = document.getElementById("set_motd");
  const colorRow = document.getElementById("motdColors");
  colorRow.innerHTML = `
    <div class="motd-swatches">
      ${MC_COLORS.map((c) => `<button type="button" class="motd-sw" data-code="${c.code}" style="background:${c.hex};" title="${c.name} (&amp;${c.code})"></button>`).join("")}
    </div>
    <div class="motd-formats">
      ${MC_FORMATS.map((f) => `<button type="button" class="motd-fmt" data-code="${f.code}" title="${f.name} (&amp;${f.code})">${f.label}</button>`).join("")}
    </div>
    <div class="motd-preview" id="motdPreview"></div>
  `;
  function insertCode(code) {
    const i = motdInput.selectionStart ?? motdInput.value.length;
    const j = motdInput.selectionEnd ?? motdInput.value.length;
    const before = motdInput.value.slice(0, i);
    const after = motdInput.value.slice(j);
    motdInput.value = before + "&" + code + after;
    const pos = i + 2;
    motdInput.focus();
    motdInput.setSelectionRange(pos, pos);
    renderMotdPreview();
  }
  function renderMotdPreview() {
    const text = motdInput.value || "";
    // Convert & codes into colored spans. Section/§ codes also work.
    const codes = Object.fromEntries(
      MC_COLORS.map((c) => [c.code, { type: "color", hex: c.hex }]),
    );
    for (const f of MC_FORMATS)
      codes[f.code] = { type: "format", code: f.code };
    let html = "";
    let cur = {
      color: "#aaaaaa",
      bold: false,
      italic: false,
      underline: false,
      strike: false,
    };
    const re = /[&§]([0-9a-fk-or])/gi;
    let lastIdx = 0;
    let match;
    function span(text) {
      if (!text) return "";
      const styles = [`color:${cur.color}`];
      if (cur.bold) styles.push("font-weight:bold");
      if (cur.italic) styles.push("font-style:italic");
      const deco = [];
      if (cur.underline) deco.push("underline");
      if (cur.strike) deco.push("line-through");
      if (deco.length) styles.push("text-decoration:" + deco.join(" "));
      return `<span style="${styles.join(";")}">${text.replace(/</g, "&lt;")}</span>`;
    }
    while ((match = re.exec(text))) {
      html += span(text.slice(lastIdx, match.index));
      const c = match[1].toLowerCase();
      const def = codes[c];
      if (def?.type === "color") {
        cur.color = def.hex;
        cur.bold = cur.italic = cur.underline = cur.strike = false;
      } else if (def?.code === "l") cur.bold = true;
      else if (def?.code === "o") cur.italic = true;
      else if (def?.code === "n") cur.underline = true;
      else if (def?.code === "m") cur.strike = true;
      else if (def?.code === "r")
        cur = {
          color: "#aaaaaa",
          bold: false,
          italic: false,
          underline: false,
          strike: false,
        };
      lastIdx = re.lastIndex;
    }
    html += span(text.slice(lastIdx));
    document.getElementById("motdPreview").innerHTML =
      html ||
      '<span style="color:var(--slate-500);">Preview appears here</span>';
  }
  colorRow.querySelectorAll(".motd-sw, .motd-fmt").forEach((btn) => {
    btn.addEventListener("click", () => insertCode(btn.dataset.code));
  });
  motdInput.addEventListener("input", renderMotdPreview);
  renderMotdPreview();

  document.getElementById("set_save").onclick = async () => {
    const body = {
      motd: document.getElementById("set_motd").value,
      max_players: parseInt(
        document.getElementById("set_max_players").value,
        10,
      ),
      gamemode: document.getElementById("set_gamemode").value,
      difficulty: document.getElementById("set_difficulty").value,
      view_distance: parseInt(
        document.getElementById("set_view_distance").value,
        10,
      ),
      simulation_distance: parseInt(
        document.getElementById("set_simulation_distance").value,
        10,
      ),
      spawn_protection: parseInt(
        document.getElementById("set_spawn_protection").value,
        10,
      ),
      pvp: document.getElementById("set_pvp").checked,
      hardcore: document.getElementById("set_hardcore").checked,
      whitelist: document.getElementById("set_whitelist").checked,
      allow_flight: document.getElementById("set_allow_flight").checked,
      allow_nether: document.getElementById("set_allow_nether").checked,
      command_blocks: document.getElementById("set_command_blocks").checked,
      force_gamemode: document.getElementById("set_force_gamemode").checked,
      spawn_monsters: document.getElementById("set_spawn_monsters").checked,
      spawn_animals: document.getElementById("set_spawn_animals").checked,
      spawn_npcs: document.getElementById("set_spawn_npcs").checked,
      // Empty string means "disable scheduled restart"; non-empty must match HH:MM
      scheduled_restart_at:
        document.getElementById("set_schedrestart").value || "",
      restart: document.getElementById("set_restart").checked,
    };
    const btn = document.getElementById("set_save");
    btn.disabled = true;
    btn.textContent = "⏳ Saving…";
    try {
      const r = await api(`/api/servers/${sid}`, { method: "PATCH", body });
      toast(
        r.restarted
          ? "✓ Saved + restarting"
          : "✓ Saved (restart needed to apply some settings)",
      );
      document.getElementById("settingsModal").classList.remove("show");
      loadServers();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Save";
    }
  };
}
window.openSettings = openSettings;

// Last rendered HTML per card id — lets renderServers skip cards whose
// content didn't change. Rebuilding the whole grid every poll tick made
// cards flicker/jump (and closed open menus) right after pressing Start.
const lastCardHtml = new Map();

function renderServers() {
  const grid = document.getElementById("serversGrid");
  if (!servers.length) {
    lastCardHtml.clear();
    grid.innerHTML = `
      <div class="empty" style="grid-column:1/-1;padding:60px 20px;text-align:center;">
        <div style="font-size:48px;margin-bottom:8px;">🎮</div>
        <h3>No servers yet</h3>
        <p class="text-muted" style="margin:8px 0 18px;">Spin up your first Minecraft server in under 60 seconds.</p>
        <button class="btn btn-primary" onclick="openWizard()">+ Create your first server</button>
      </div>`;
    updateSummary();
    return;
  }
  const emptyEl = grid.querySelector(".empty");
  if (emptyEl) emptyEl.remove();
  const ids = new Set(servers.map((s) => String(s.id)));
  grid.querySelectorAll(".server-card[data-id]").forEach((el) => {
    if (!ids.has(el.dataset.id)) {
      lastCardHtml.delete(el.dataset.id);
      el.remove();
    }
  });
  servers.forEach((s) => {
    const id = String(s.id);
    const html = renderServer(s);
    if (lastCardHtml.get(id) === html) return;
    lastCardHtml.set(id, html);
    const existing = grid.querySelector(
      `.server-card[data-id="${CSS.escape(id)}"]`,
    );
    if (existing) patchCard(existing, html);
    else grid.insertAdjacentHTML("beforeend", html);
  });
  updateSummary();
}

// Replace only the top-level sections of a card that actually changed instead
// of swapping the whole card's outerHTML. Stats (uptime/CPU/RAM) tick every
// few seconds, and a full swap destroyed the action buttons mid-click, killed
// hover states, and closed the ⋯ menu — the "glitchy buttons" bug. With this,
// the Start/Stop row is only rebuilt when the server's status truly changes.
function patchCard(existing, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const next = tpl.content.firstElementChild;
  if (!next) return;
  const oldKids = Array.from(existing.children);
  const newKids = Array.from(next.children);
  // Structure changed (section added/removed, e.g. crash banner appeared or
  // tunnel address row toggled) — full swap is correct there.
  if (
    oldKids.length !== newKids.length ||
    oldKids.some(
      (el, i) =>
        el.tagName !== newKids[i].tagName ||
        el.className !== newKids[i].className,
    )
  ) {
    if (window.__patchDebug)
      window.__patchDebug.push(
        "FULL " +
          oldKids.map((k) => k.className || k.tagName).join("|") +
          "  →  " +
          newKids.map((k) => k.className || k.tagName).join("|"),
      );
    existing.replaceWith(next);
    return;
  }
  // Same structure — swap only the children whose markup differs. Keep the
  // actions row untouched while its menu is open so the menu doesn't snap shut.
  oldKids.forEach((el, i) => {
    if (el.outerHTML === newKids[i].outerHTML) return;
    if (
      el.classList.contains("sc-actions") &&
      el.querySelector(".sc-menu.show")
    )
      return;
    el.replaceWith(newKids[i]);
  });
}

function updateSummary() {
  const online = servers.filter(
    (s) => s.status === "online" || s.status === "starting",
  );
  const totalPlayers = servers.reduce((a, s) => a + (s.stats?.players || 0), 0);
  const tps = online.length
    ? (
        online.reduce((a, s) => a + (s.stats?.tps || 19.8), 0) / online.length
      ).toFixed(1)
    : "—";
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("statServers", servers.length);
  set("statServersDelta", online.length + " online");
  set("statPlayers", totalPlayers);
  set("statTps", tps);
  if (!online.length) set("statTpsDelta", "no servers running");

  // Side-foot plan badge — show top plan among the user's servers
  const topPlanId =
    servers
      .map((s) => s.plan_id)
      .sort(
        (a, b) =>
          (({ free: 0, dirt: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 })[
            b
          ] || 0) -
          ({ free: 0, dirt: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }[
            a
          ] || 0),
      )[0] || "free";
  const planLabel =
    {
      free: "Free",
      dirt: "Dirt",
      stone: "Stone",
      iron: "Iron",
      diamond: "Diamond",
      netherite: "Netherite",
    }[topPlanId] || "Free";
  set("planName", planLabel);
  set(
    "planUsage",
    `${servers.length} server${servers.length === 1 ? "" : "s"}`,
  );
}

async function loadMe() {
  try {
    const me = await api("/api/auth/me");
    if (me?.user) {
      const n = me.user.username || "";
      const nameEl = document.getElementById("userName");
      if (nameEl) nameEl.textContent = n;
      const av = document.getElementById("avatar");
      if (av) av.textContent = (n[0] || "U").toUpperCase();
    }
  } catch {}
}

async function loadServers() {
  // Wait for auth state to settle so we don't race the /api/servers call.
  try {
    if (window.authReady) await window.authReady;
  } catch {}
  try {
    const r = await api("/api/servers");
    // Build the refreshed list OFF-GLOBALS first. Publishing it before the
    // per-server stats fetches resolved let concurrent render ticks draw
    // stat-less cards (sparkline/MOTD vanish, then reappear) — a full DOM
    // swap of every card twice per cycle, i.e. the flickering buttons.
    const next = r.servers || [];
    if (r.public_host) publicHost = r.public_host;
    if (r.idle_stop_minutes) idleStopMinutes = r.idle_stop_minutes;
    isDemo = false;
    // Also fetch /api/health to get the real public mc port
    try {
      const h = await api("/api/health");
      if (h.public_mc_port) publicMcPort = h.public_mc_port;
    } catch {}
    // Fetch live stats for each running server; keep the previous stats if a
    // fetch hiccups so the card doesn't blank out for one tick.
    await Promise.all(
      next.map(async (s) => {
        const prev = servers.find((x) => x.id === s.id);
        if (s.status === "online" || s.status === "starting") {
          try {
            const st = await api(`/api/servers/${s.id}/status`);
            s.stats = st.stats || prev?.stats || {};
          } catch {
            if (prev?.stats) s.stats = prev.stats;
          }
        }
      }),
    );
    servers = next;
  } catch (err) {
    // 401 = truly not signed in → show demo cards.
    // Any other error (5xx, network blip) when the user IS signed in: keep
    // them in "signed-in but empty" state and offer a retry instead of
    // demoting them to Visitor.
    if (err?.status === 401 || !window.isSignedIn) {
      isDemo = true;
      servers = DEMO_SERVERS;
      const nameEl = document.getElementById("userName");
      if (nameEl) nameEl.textContent = "Visitor";
      toast("Showing demo servers — sign in to manage real ones.", "warn");
    } else {
      isDemo = false;
      servers = [];
      // Best-effort retry once after a short delay (covers cold-start latency).
      toast("Could not load your servers — retrying…", "warn");
      setTimeout(() => {
        loadServers().catch(() => {});
      }, 2500);
    }
  }
  renderServers();
}

async function serverAction(id, action) {
  if (isDemo) {
    toast("Sign in to control real servers", "warn");
    return;
  }
  const verb = action[0].toUpperCase() + action.slice(1) + "ing";
  toast(`${verb} server…`);
  try {
    await api(`/api/servers/${id}/${action}`, { method: "POST" });
    // Optimistic update so the status pill flips instantly without waiting
    // for the next poll cycle.
    const s = servers.find((x) => x.id === id);
    if (s) s.status = action === "stop" ? "offline" : "starting";
    renderServers();
    // Then tight-poll the actual status every 2s up to 60s so the dot
    // catches the real transition (yellow → green for start/restart, any →
    // grey for stop) the moment the JVM reports it.
    const target = action === "stop" ? "offline" : "online";
    tightPollServerStatus(id, target);
  } catch (err) {
    // Running-cap conflict: another server holds the single running slot.
    // Offer to stop it and start this one, instead of a dead-end error toast.
    if (
      action === "start" &&
      err?.status === 409 &&
      err?.data?.code === "running_quota" &&
      err?.data?.conflict?.id
    ) {
      const other = err.data.conflict;
      if (
        confirm(
          `"${other.name}" is already running and your plan allows one running server at a time.\n\nStop "${other.name}" and start this one?`,
        )
      ) {
        try {
          await api(`/api/servers/${other.id}/stop`, { method: "POST" });
          const o = servers.find((x) => x.id === other.id);
          if (o) o.status = "offline";
          await serverAction(id, "start");
        } catch (e2) {
          toast(e2.message, "error");
        }
      }
      return;
    }
    toast(err.message, "error");
  }
}

// Aggressively poll one server's status until it reaches the target state
// (or we give up after 60s). On each tick we refresh just that one server
// and re-render the card so the indicator flips the instant the backend
// reports the new state — no waiting for the global 6s polling tick.
function tightPollServerStatus(serverId, targetStatus) {
  const start = Date.now();
  const MAX_MS = 60_000;
  const TICK_MS = 2000;
  const tick = async () => {
    if (Date.now() - start > MAX_MS) return;
    try {
      const r = await api(`/api/servers/${serverId}/status`);
      const s = servers.find((x) => x.id === serverId);
      if (s) {
        if (r.status) s.status = r.status;
        if (r.stats) s.stats = r.stats;
        renderServers();
        if (s.status === targetStatus) return;
      }
    } catch {}
    setTimeout(tick, TICK_MS);
  };
  setTimeout(tick, TICK_MS);
}

async function deleteServer(id, name) {
  if (isDemo) {
    toast("Sign in to delete real servers", "warn");
    return;
  }
  if (!confirm(`Delete "${name}"? This removes the server and all its data.`))
    return;
  try {
    await api(`/api/servers/${id}`, { method: "DELETE" });
    toast("Server deleted");
    loadServers();
  } catch (err) {
    toast(err.message, "error");
  }
}

function goToConsole(id) {
  localStorage.setItem("crafthost.currentServerId", id);
  location.href = "/console.html";
}

window.serverAction = serverAction;
window.deleteServer = deleteServer;
window.goToConsole = goToConsole;

// Quick-deploy presets — bypass the wizard for the most common server kinds.
// Each preset maps to a full POST /api/servers body. After the create returns,
// we reuse the wizard's live progress modal so the user sees the same phase UI.
const QUICK_PRESETS = {
  survival: {
    type: "paper",
    version: "1.21.1",
    motd: "Survival server — bring your axe",
    difficulty: "normal",
    gamemode: "survival",
    whitelist: false,
    namePrefix: "Survival",
  },
  creative: {
    type: "paper",
    version: "1.21.1",
    motd: "Creative — build anything",
    difficulty: "peaceful",
    gamemode: "creative",
    whitelist: false,
    namePrefix: "Creative",
  },
  skyblock: {
    type: "paper",
    version: "1.21.1",
    motd: "Skyblock — survive on an island",
    difficulty: "hard",
    gamemode: "survival",
    whitelist: false,
    namePrefix: "Skyblock",
  },
  modded: {
    type: "fabric",
    version: "1.21.1",
    motd: "Modded adventure — Fabric",
    difficulty: "normal",
    gamemode: "survival",
    whitelist: false,
    namePrefix: "Modded",
  },
};

async function quickDeploy(presetId) {
  const preset = QUICK_PRESETS[presetId];
  if (!preset) return;
  // Auto-name: "<Type>-<6 random hex>" so users don't collide and get unique cards
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const name = `${preset.namePrefix}-${rand}`;
  const body = {
    name,
    type: preset.type,
    version: preset.version,
    plan: "free",
    region: "eu",
    motd: preset.motd,
    difficulty: preset.difficulty,
    gamemode: preset.gamemode,
    whitelist: preset.whitelist,
  };
  // Ensure the wizardModal element exists (wizard.js creates it on openWizard;
  // for quick deploy we open it directly with the live-progress screen).
  let modal = document.getElementById("wizardModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "wizardModal";
    modal.className = "modal-bg";
    document.body.appendChild(modal);
  }
  modal.classList.add("show");
  // Surface a tiny loading state while POST is in flight
  modal.innerHTML = `
    <div class="modal wiz-modal" onclick="event.stopPropagation()" style="max-width:520px;">
      <div class="modal-head"><h3>🚀 Creating ${escapeHtml(name)}…</h3></div>
      <div class="modal-body"><p class="text-muted">Reserving resources…</p></div>
    </div>`;
  try {
    const r = await api("/api/servers", { method: "POST", body });
    if (r?.id) localStorage.setItem("crafthost.currentServerId", r.id);
    // Hand off to the wizard's progress renderer. Ensure wizState.name is set
    // so the modal heading shows the right server name.
    if (typeof window.wizState !== "undefined") window.wizState.name = name;
    else window.wizState = { name };
    window.renderDeployProgress(r);
  } catch (err) {
    toast(err.message || "Quick deploy failed", "error");
    modal.classList.remove("show");
  }
}
window.quickDeploy = quickDeploy;

// ── Health Check modal ────────────────────────────────────────────────────────
// Polls /api/servers/health-check every 10s while the modal is open. Each server
// gets a card with a health pill, an issue list, and a recent-log tail. Reuses
// the same styling vocabulary as the dashboard server cards (.sc-warn*).
let healthTimer = null;
async function openHealthCheck() {
  let modal = document.getElementById("healthModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "healthModal";
    modal.className = "modal show";
    modal.innerHTML = `
      <div class="modal-card" style="max-width: 880px; width: 100%; max-height: 90vh; display: flex; flex-direction: column;">
        <div class="modal-head">
          <h3 style="margin:0;font-size:18px;display:flex;align-items:center;gap:8px;">
            🩺 <span data-i18n="health_check">Health Check</span>
            <span id="hcSummary" class="hc-summary"></span>
          </h3>
          <button class="modal-close" onclick="closeHealthCheck()" aria-label="Close">✕</button>
        </div>
        <div id="hcBody" class="modal-body" style="overflow-y:auto;flex:1;padding:18px 20px;">
          <div class="hc-loading">Checking your servers…</div>
        </div>
        <div class="modal-foot" style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:1px solid var(--glass-border);font-size:12px;color:var(--slate-400);">
          <span id="hcStatus">Polling every 10s · last refresh: —</span>
          <button class="btn btn-ghost btn-sm" onclick="refreshHealthCheck()">↻ Refresh</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    // Click backdrop to close
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeHealthCheck();
    });
  } else {
    modal.classList.add("show");
  }
  await refreshHealthCheck();
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(refreshHealthCheck, 10000);
}
function closeHealthCheck() {
  const m = document.getElementById("healthModal");
  if (m) m.classList.remove("show");
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}
async function refreshHealthCheck() {
  const body = document.getElementById("hcBody");
  const status = document.getElementById("hcStatus");
  const sumEl = document.getElementById("hcSummary");
  if (!body) return;
  try {
    const data = await api("/api/servers/health-check");
    sumEl.innerHTML = `
      ${data.summary.good ? `<span class="hc-pill hc-good">✓ ${data.summary.good} healthy</span>` : ""}
      ${data.summary.warn ? `<span class="hc-pill hc-warn">! ${data.summary.warn} warning${data.summary.warn > 1 ? "s" : ""}</span>` : ""}
      ${data.summary.error ? `<span class="hc-pill hc-error">✗ ${data.summary.error} error${data.summary.error > 1 ? "s" : ""}</span>` : ""}
      ${!data.summary.total ? `<span class="hc-pill">No servers yet</span>` : ""}
    `;
    if (!data.servers.length) {
      body.innerHTML = `<div class="hc-empty">You haven't created a server yet. Hit <strong>+ Create Server</strong> to spin one up.</div>`;
    } else {
      body.innerHTML = data.servers.map(renderHealthCard).join("");
    }
    status.textContent = `Polling every 10s · last refresh: ${new Date(data.checked_at).toLocaleTimeString()}`;
  } catch (err) {
    body.innerHTML = `<div class="hc-empty hc-error-text">Failed to load health check: ${escapeHtmlD(err.message || "unknown error")}</div>`;
    status.textContent = `Error · retrying in 10s`;
  }
}
function renderHealthCard(s) {
  const pillClass =
    s.health === "error"
      ? "hc-error"
      : s.health === "warn"
        ? "hc-warn"
        : "hc-good";
  const pillIcon = s.health === "error" ? "✗" : s.health === "warn" ? "!" : "✓";
  const pillLabel =
    s.health === "error"
      ? "Needs attention"
      : s.health === "warn"
        ? "Has warnings"
        : "Healthy";
  const ramPct = s.stats?.ram_max
    ? Math.round((s.stats.ram_used / s.stats.ram_max) * 100)
    : 0;
  return `
    <div class="hc-card hc-card-${s.health}">
      <div class="hc-card-head">
        <div>
          <div class="hc-name">${escapeHtmlD(s.name)} <span class="hc-meta">${s.type || ""} ${s.version || ""}</span></div>
          ${s.address ? `<div class="hc-addr">${escapeHtmlD(s.address)}</div>` : ""}
        </div>
        <span class="hc-pill ${pillClass}">${pillIcon} ${pillLabel}</span>
      </div>
      ${
        s.online && s.stats
          ? `
        <div class="hc-stats">
          <div><span class="hc-stat-label">CPU</span><span>${s.stats.cpu}%</span></div>
          <div><span class="hc-stat-label">RAM</span><span>${s.stats.ram_used}/${s.stats.ram_max} MB (${ramPct}%)</span></div>
          <div><span class="hc-stat-label">Players</span><span>${s.stats.players}/${s.stats.players_max || "?"}</span></div>
          <div><span class="hc-stat-label">Uptime</span><span>${fmtUptimeD(s.stats.uptime)}</span></div>
        </div>`
          : `
        <div class="hc-stats hc-stats-offline">Server is offline · no live stats</div>`
      }
      ${
        s.issues.length
          ? `
        <ul class="hc-issues">
          ${s.issues.map((i) => `<li class="hc-issue hc-issue-${i.severity}"><span class="hc-issue-dot"></span>${escapeHtmlD(i.message)}</li>`).join("")}
        </ul>`
          : ""
      }
      ${
        s.recent_logs?.length
          ? `
        <details class="hc-logs">
          <summary>Recent log (${s.recent_logs.length} lines)</summary>
          <pre>${s.recent_logs.map((l) => escapeHtmlD(l)).join("\n")}</pre>
        </details>`
          : ""
      }
    </div>`;
}
function escapeHtmlD(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function fmtUptimeD(sec) {
  if (!sec || sec < 60) return (sec || 0) + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400)
    return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
  return Math.floor(sec / 86400) + "d";
}
window.openHealthCheck = openHealthCheck;
window.closeHealthCheck = closeHealthCheck;
window.refreshHealthCheck = refreshHealthCheck;

// ── Clone server dialog ──────────────────────────────────────────────────────
async function openCloneDialog(sourceId, sourceName) {
  let modal = document.getElementById("cloneModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "cloneModal";
    modal.className = "modal show";
    modal.innerHTML = `
      <div class="modal-card" style="max-width: 460px;width:100%;">
        <div class="modal-head">
          <h3 style="margin:0;font-size:17px;">📑 Clone server</h3>
          <button class="modal-close" onclick="closeCloneDialog()" aria-label="Close">✕</button>
        </div>
        <div class="modal-body" style="padding:18px 20px;">
          <p style="margin:0 0 14px;color:var(--slate-300);font-size:13.5px;line-height:1.5;">
            Creates a new server with the same type, version, plan, world, and plugins.
            The fresh server.jar is downloaded on first start.
          </p>
          <label class="label" for="cloneName">New server name</label>
          <input class="input" id="cloneName" maxlength="40" />
          <div style="display:grid;gap:8px;margin-top:14px;">
            <label class="clone-opt"><input type="checkbox" id="cloneWorld" checked /> <span>Copy world (saves & terrain)</span></label>
            <label class="clone-opt"><input type="checkbox" id="clonePlugins" checked /> <span>Copy plugins folder</span></label>
          </div>
          <div id="cloneStatus" style="margin-top:14px;font-size:13px;color:var(--slate-400);display:none;"></div>
        </div>
        <div class="modal-foot" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--glass-border);">
          <button class="btn btn-ghost" onclick="closeCloneDialog()">Cancel</button>
          <button class="btn btn-primary" id="cloneSubmit">📑 Clone now</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeCloneDialog();
    });
  } else {
    modal.classList.add("show");
  }
  document.getElementById("cloneName").value = `Copy of ${sourceName}`.slice(
    0,
    40,
  );
  document.getElementById("cloneWorld").checked = true;
  document.getElementById("clonePlugins").checked = true;
  document.getElementById("cloneStatus").style.display = "none";
  document.getElementById("cloneSubmit").disabled = false;
  document.getElementById("cloneSubmit").innerHTML = "📑 Clone now";
  document.getElementById("cloneSubmit").onclick = async () => {
    const btn = document.getElementById("cloneSubmit");
    const status = document.getElementById("cloneStatus");
    btn.disabled = true;
    btn.innerHTML = '<span class="ed-spin"></span> Cloning…';
    status.style.display = "block";
    status.style.color = "var(--slate-300)";
    status.textContent = "Creating server row & copying files…";
    try {
      const body = {
        source_id: sourceId,
        name:
          document.getElementById("cloneName").value.trim() ||
          `Copy of ${sourceName}`,
        skipWorld: !document.getElementById("cloneWorld").checked,
        skipPlugins: !document.getElementById("clonePlugins").checked,
      };
      const r = await api("/api/servers/clone", { method: "POST", body });
      const kb = Math.round((r.copy_stats?.bytes || 0) / 1024);
      status.style.color = "var(--emerald)";
      status.textContent = `✓ Cloned · ${r.copy_stats?.files || 0} file(s), ${kb} KB · ${r.auto_started ? "starting" : "created (manual start)"}`;
      toast("✓ Server cloned");
      setTimeout(() => {
        closeCloneDialog();
        loadServers();
      }, 1200);
    } catch (err) {
      status.style.color = "var(--red, #ef4444)";
      status.textContent = "✗ " + (err.message || "Clone failed");
      btn.disabled = false;
      btn.innerHTML = "📑 Retry";
    }
  };
}
function closeCloneDialog() {
  const m = document.getElementById("cloneModal");
  if (m) m.classList.remove("show");
}
window.openCloneDialog = openCloneDialog;
window.closeCloneDialog = closeCloneDialog;

// ── Import world.zip dialog ──────────────────────────────────────────────────
async function openWorldImport(sid, sname) {
  let modal = document.getElementById("worldModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "worldModal";
    modal.className = "modal show";
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:100%;">
        <div class="modal-head">
          <h3 style="margin:0;font-size:17px;">🌍 Import world</h3>
          <button class="modal-close" onclick="closeWorldImport()" aria-label="Close">✕</button>
        </div>
        <div class="modal-body" style="padding:18px 20px;">
          <p style="margin:0 0 14px;color:var(--slate-300);font-size:13.5px;line-height:1.5;">
            Upload a <strong>.zip</strong> of your single-player world (or one downloaded from Planet Minecraft).
            We accept both layouts: a wrapper folder (<code>world/</code>) at root, or world internals at root (<code>level.dat</code>, <code>region/</code>).
          </p>
          <p id="wiTargetLine" style="margin:0 0 12px;color:var(--slate-400);font-size:12.5px;"></p>
          <div class="wi-drop" id="wiDrop">
            <input type="file" id="wiFile" accept=".zip,application/zip" style="display:none;" />
            <div class="wi-drop-empty">
              <div style="font-size:32px;line-height:1;margin-bottom:8px;">📦</div>
              <div><strong>Click to choose</strong> or drop a .zip here</div>
              <div style="font-size:12px;color:var(--slate-500);margin-top:4px;">Max 500 MB · server will be stopped & restarted</div>
            </div>
            <div class="wi-drop-file" style="display:none;">
              <div style="font-size:24px;margin-bottom:6px;">📦</div>
              <div id="wiFileName" style="font-weight:600;"></div>
              <div id="wiFileSize" style="font-size:12px;color:var(--slate-400);"></div>
            </div>
          </div>
          <div id="wiProgress" style="display:none;margin-top:14px;">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--slate-400);margin-bottom:4px;">
              <span id="wiProgLabel">Uploading…</span>
              <span id="wiProgPct">0%</span>
            </div>
            <div style="height:6px;background:var(--slate-800);border-radius:3px;overflow:hidden;">
              <div id="wiProgBar" style="height:100%;width:0;background:var(--emerald);transition:width .2s;"></div>
            </div>
          </div>
          <div id="wiStatus" style="margin-top:14px;font-size:13px;display:none;"></div>
          <p style="margin:14px 0 0;color:#fbbf24;font-size:11.5px;line-height:1.5;">
            ⚠ This replaces your current world. There's no undo — consider clicking "Back up world" first via the file manager.
          </p>
        </div>
        <div class="modal-foot" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--glass-border);">
          <button class="btn btn-ghost" onclick="closeWorldImport()">Cancel</button>
          <button class="btn btn-primary" id="wiSubmit" disabled>🌍 Upload & restart</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeWorldImport();
    });

    // Drag-and-drop wiring (one-time)
    const drop = document.getElementById("wiDrop");
    const input = document.getElementById("wiFile");
    drop.addEventListener("click", () => input.click());
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add("drag");
      }),
    );
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove("drag");
      }),
    );
    drop.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) wiSetFile(f);
    });
    input.addEventListener("change", () => {
      if (input.files[0]) wiSetFile(input.files[0]);
    });
  } else {
    modal.classList.add("show");
  }
  document.getElementById("wiTargetLine").textContent = `Target: ${sname}`;
  document.getElementById("wiSubmit").dataset.sid = sid;
  document.getElementById("wiSubmit").dataset.sname = sname;
  // Reset state
  document.getElementById("wiSubmit").disabled = true;
  document.getElementById("wiSubmit").innerHTML = "🌍 Upload & restart";
  document.querySelector(".wi-drop-empty").style.display = "";
  document.querySelector(".wi-drop-file").style.display = "none";
  document.getElementById("wiProgress").style.display = "none";
  document.getElementById("wiStatus").style.display = "none";
  document.getElementById("wiFile").value = "";
  window._wiFile = null;

  document.getElementById("wiSubmit").onclick = async () => {
    const file = window._wiFile;
    if (!file) return;
    const sid = document.getElementById("wiSubmit").dataset.sid;
    const btn = document.getElementById("wiSubmit");
    btn.disabled = true;
    btn.innerHTML = '<span class="ed-spin"></span> Uploading…';
    document.getElementById("wiProgress").style.display = "block";
    document.getElementById("wiStatus").style.display = "none";

    const fd = new FormData();
    fd.append("world", file, file.name);

    // Use XHR so we can show real upload progress
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/servers/${encodeURIComponent(sid)}/import-world`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        document.getElementById("wiProgBar").style.width = pct + "%";
        document.getElementById("wiProgPct").textContent = pct + "%";
        if (pct >= 100)
          document.getElementById("wiProgLabel").textContent =
            "Extracting on server…";
      };
      xhr.onload = () => {
        const status = document.getElementById("wiStatus");
        status.style.display = "block";
        try {
          const r = JSON.parse(xhr.responseText || "{}");
          if (xhr.status >= 200 && xhr.status < 300 && r.ok) {
            const dims = Object.keys(r.restored || {}).join(", ");
            status.style.color = "var(--emerald)";
            status.textContent = `✓ World imported (${dims || "world"}) — server restarting`;
            toast("✓ World imported, restarting");
            setTimeout(() => {
              closeWorldImport();
              loadServers();
            }, 1500);
          } else {
            status.style.color = "var(--red, #ef4444)";
            status.textContent = "✗ " + (r.error || `HTTP ${xhr.status}`);
            btn.disabled = false;
            btn.innerHTML = "🌍 Retry";
          }
        } catch {
          status.style.color = "var(--red, #ef4444)";
          status.textContent = `✗ HTTP ${xhr.status}`;
          btn.disabled = false;
          btn.innerHTML = "🌍 Retry";
        }
        resolve();
      };
      xhr.onerror = () => {
        const status = document.getElementById("wiStatus");
        status.style.display = "block";
        status.style.color = "var(--red, #ef4444)";
        status.textContent = "✗ Network error";
        btn.disabled = false;
        btn.innerHTML = "🌍 Retry";
        resolve();
      };
      xhr.send(fd);
    });
  };
}
function closeWorldImport() {
  const m = document.getElementById("worldModal");
  if (m) m.classList.remove("show");
  window._wiFile = null;
}
function wiSetFile(file) {
  if (!/\.zip$/i.test(file.name)) {
    toast("Please choose a .zip file", "error");
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    toast("Zip exceeds 500 MB cap", "error");
    return;
  }
  window._wiFile = file;
  document.querySelector(".wi-drop-empty").style.display = "none";
  document.querySelector(".wi-drop-file").style.display = "";
  document.getElementById("wiFileName").textContent = file.name;
  document.getElementById("wiFileSize").textContent = fmtBytes(file.size);
  document.getElementById("wiSubmit").disabled = false;
}
window.openWorldImport = openWorldImport;
window.closeWorldImport = closeWorldImport;

// ── Bedrock cross-play modal (playit.gg agent) ─────────────────────────────
let bedrockPollTimer = null;

async function openBedrockModal(sid, sname) {
  // Inject the modal markup if it's not already in the DOM
  if (!document.getElementById("bedrockModal")) {
    const div = document.createElement("div");
    div.id = "bedrockModal";
    div.className = "modal-host";
    div.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.65);display:none;align-items:center;justify-content:center;z-index:1000;backdrop-filter:blur(4px);padding:16px;";
    div.innerHTML = `
      <div class="modal" style="max-width:520px;width:100%;background:var(--slate-800);border:1px solid var(--glass-border);border-radius:14px;overflow:hidden;">
        <div class="modal-head" style="padding:16px 20px;border-bottom:1px solid var(--glass-border);display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:16px;font-weight:700;">📱 Bedrock cross-play</h3>
          <button class="close-btn" onclick="closeBedrockModal()" style="background:none;border:none;color:var(--slate-400);cursor:pointer;padding:4px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body" id="bedrockBody" style="padding:18px 20px;font-size:13px;line-height:1.55;"></div>
      </div>`;
    document.body.appendChild(div);
  }
  const modal = document.getElementById("bedrockModal");
  modal.style.display = "flex";
  modal.dataset.sid = sid;
  modal.dataset.sname = sname;
  modal.onclick = (e) => {
    if (e.target === modal) closeBedrockModal();
  };
  renderBedrockStatus(sid, sname);
}

function closeBedrockModal() {
  const modal = document.getElementById("bedrockModal");
  if (modal) modal.style.display = "none";
  if (bedrockPollTimer) {
    clearInterval(bedrockPollTimer);
    bedrockPollTimer = null;
  }
}

async function renderBedrockStatus(sid, sname) {
  const body = document.getElementById("bedrockBody");
  if (!body) return;
  body.innerHTML = `<div style="color:var(--slate-400);text-align:center;padding:16px 0;">Loading…</div>`;
  try {
    // Get server (for playit_enabled + host/port)
    const list = await api("/api/servers");
    const srv = (list.servers || []).find((s) => s.id === sid);
    if (!srv) {
      body.innerHTML =
        '<div style="color:var(--rose);">Server not found.</div>';
      return;
    }
    const status = await api(`/api/servers/${sid}/playit/claim/status`).catch(
      () => ({ status: "none" }),
    );

    if (srv.playit_enabled && srv.playit_host && srv.playit_port) {
      // Connected + agent running with assigned address
      const bp = status.bedrock_plugins || {};
      const pluginsReady = bp.geyser && bp.floodgate;
      const pluginsRow = pluginsReady
        ? `<div style="font-size:12px;color:var(--emerald);margin-bottom:14px;">✓ Geyser + Floodgate installed</div>`
        : bp.installing
          ? `<div style="font-size:12px;color:var(--slate-300);margin-bottom:14px;">⏳ Installing Geyser + Floodgate from cache…</div>`
          : `<div style="font-size:12px;color:var(--slate-400);margin-bottom:14px;">Geyser ${bp.geyser ? "✓" : "○"} · Floodgate ${bp.floodgate ? "✓" : "○"}</div>`;
      const restartHint = status.restart_required
        ? `<div style="background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.3);border-radius:9px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#fbbf24;">
             ⟳ ${escapeHtml(status.restart_reason || "Restart the server to apply changes.")}
           </div>`
        : "";
      body.innerHTML = `
        <div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.3);border-radius:9px;padding:12px;margin-bottom:14px;">
          <div style="font-weight:700;color:var(--emerald);margin-bottom:4px;">✓ Bedrock cross-play active</div>
          <div style="font-size:12px;color:var(--slate-400);">Mobile / Xbox / Switch / PS players can connect using:</div>
        </div>
        <div class="sc-ip" onclick="copyText('${escapeHtml(srv.playit_host + ":" + srv.playit_port)}')" style="cursor:pointer;margin-bottom:14px;border-color:rgba(255,107,53,0.4);">
          <span style="flex:1;font-family:monospace;font-size:14px;">📱 ${escapeHtml(srv.playit_host)}:${escapeHtml(String(srv.playit_port))}</span>
          <span class="sc-copy">Copy</span>
        </div>
        ${pluginsRow}
        ${restartHint}
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          ${status.restart_required ? `<button class="btn btn-warning btn-sm" onclick="serverAction('${escapeHtml(sid)}', 'restart'); closeBedrockModal();">⟳ Restart now</button>` : ""}
          <button class="btn btn-secondary btn-sm" onclick="closeBedrockModal()">Close</button>
          <button class="btn btn-danger btn-sm" onclick="disableBedrock('${escapeHtml(sid)}')">Disable</button>
        </div>`;
      return;
    }

    if (srv.playit_enabled) {
      // Secret set but no address yet — agent is connecting
      body.innerHTML = `
        <div style="text-align:center;padding:18px 0;">
          <div style="font-weight:700;margin-bottom:8px;">⏳ Connecting to playit.gg…</div>
          <div style="color:var(--slate-400);font-size:12px;">The agent is starting. Address will appear here within ~20s.</div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="renderBedrockStatus('${escapeHtml(sid)}', '${escapeHtml(sname)}')">↻ Refresh</button>
          <button class="btn btn-secondary btn-sm" onclick="closeBedrockModal()">Close</button>
        </div>`;
      // Auto-refresh every 3s
      if (bedrockPollTimer) clearInterval(bedrockPollTimer);
      bedrockPollTimer = setInterval(
        () => renderBedrockStatus(sid, sname),
        3000,
      );
      return;
    }

    if (status.status === "pending" && status.claim_url) {
      // Claim in progress — show the URL + poll
      body.innerHTML = `
        <div style="margin-bottom:14px;">
          <strong>Step 1 of 2: Link your playit.gg account</strong>
          <div style="color:var(--slate-400);font-size:12px;margin-top:4px;">Free signup. Lets Bedrock players (mobile / Xbox / Switch / PS) connect to this server.</div>
        </div>
        <a href="${escapeHtml(status.claim_url)}" target="_blank" rel="noopener" class="btn btn-primary" style="display:block;text-align:center;text-decoration:none;margin-bottom:10px;">
          🔗 Open playit.gg to approve
        </a>
        <div style="font-size:11px;color:var(--slate-500);text-align:center;margin-bottom:14px;font-family:monospace;">
          ${escapeHtml(status.claim_url)}
        </div>
        <div id="bedrockPoll" style="text-align:center;color:var(--slate-400);font-size:12px;padding:8px 0;">
          <span class="ed-spin" style="display:inline-block;width:12px;height:12px;border:2px solid var(--slate-600);border-top-color:var(--emerald);border-radius:50%;animation:ed-spin 0.7s linear infinite;vertical-align:middle;margin-right:6px;"></span>
          Waiting for approval… (${status.elapsed_sec || 0}s)
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
          <button class="btn btn-secondary btn-sm" onclick="cancelBedrockClaim('${escapeHtml(sid)}', '${escapeHtml(sname)}')">Cancel</button>
        </div>`;
      if (bedrockPollTimer) clearInterval(bedrockPollTimer);
      bedrockPollTimer = setInterval(async () => {
        const s2 = await api(`/api/servers/${sid}/playit/claim/status`).catch(
          () => null,
        );
        if (!s2) return;
        if (s2.status === "connected") {
          clearInterval(bedrockPollTimer);
          bedrockPollTimer = null;
          toast("✓ Bedrock cross-play connected");
          renderBedrockStatus(sid, sname);
        } else if (s2.status === "expired" || s2.status === "failed") {
          clearInterval(bedrockPollTimer);
          bedrockPollTimer = null;
          const node = document.getElementById("bedrockPoll");
          if (node)
            node.innerHTML = `<span style="color:var(--rose);">✗ Claim ${s2.status}. Click "Connect" to try again.</span>`;
        } else {
          const node = document.getElementById("bedrockPoll");
          if (node)
            node.innerHTML = `<span class="ed-spin" style="display:inline-block;width:12px;height:12px;border:2px solid var(--slate-600);border-top-color:var(--emerald);border-radius:50%;animation:ed-spin 0.7s linear infinite;vertical-align:middle;margin-right:6px;"></span>Waiting for approval… (${s2.elapsed_sec || 0}s)`;
        }
      }, 2500);
      return;
    }

    // Not connected, no claim — show the initial "Enable" prompt.
    // One click tries the operator's shared playit secret (auto, zero setup).
    // Only if that's not configured does it fall back to the per-server claim flow.
    body.innerHTML = `
      <div style="margin-bottom:16px;">
        Bedrock Edition players (mobile / Xbox / Switch / PlayStation) need a <strong>UDP-capable tunnel</strong> to connect.
        One click turns it on — no signup, no extra tabs.
      </div>
      <div style="background:var(--slate-700);border-radius:9px;padding:12px;margin-bottom:14px;font-size:12px;color:var(--slate-300);">
        Click <em>Enable</em> and CraftHost provisions a <code>xxx.gl.ply.gg:&lt;port&gt;</code> address, then
        auto-installs Geyser + Floodgate so Java and Bedrock players share the same world.
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-secondary btn-sm" onclick="closeBedrockModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" id="bedrockEnableBtn" onclick="enableBedrock('${escapeHtml(sid)}', '${escapeHtml(sname)}')">⚡ Enable Bedrock cross-play</button>
      </div>`;
  } catch (err) {
    body.innerHTML = `<div style="color:var(--rose);">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// One-click enable. Tries the operator's shared playit secret first (no signup,
// no extra tabs). Only if the operator hasn't configured PLAYIT_SHARED_SECRET
// (backend replies 503) do we fall back to the per-server playit.gg claim flow.
async function enableBedrock(sid, sname) {
  const btn = document.getElementById("bedrockEnableBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Enabling…";
  }
  return doEnableBedrock(sid, sname, false);
}

// The single shared playit tunnel serves one server at a time. The backend is
// authoritative: it returns 409 (code: bedrock_in_use) if another server holds
// it. We surface that and offer a take-over, which re-calls with takeover:true
// and the backend disables the other holder so state never goes inconsistent.
async function doEnableBedrock(sid, sname, takeover) {
  const btn = document.getElementById("bedrockEnableBtn");
  try {
    const r = await api(`/api/servers/${sid}/playit/auto-enable`, {
      method: "POST",
      body: { takeover },
    });
    toast("✓ Bedrock cross-play enabled");
    if (r.restart_required)
      toast(
        r.restart_reason || "Restart the server to load the new plugins.",
        "info",
      );
    renderBedrockStatus(sid, sname); // re-renders into the "connecting → address" view
  } catch (err) {
    if (err?.status === 503) {
      // No shared secret on this deployment — use the manual claim flow instead.
      return startBedrockClaim(sid, sname);
    }
    if (err?.status === 409) {
      const other = err.data?.conflict;
      const move = confirm(
        `${err.message}\n\nMove Bedrock to "${sname}" now? This turns it off on "${other?.name || "the other server"}".`,
      );
      if (move) return doEnableBedrock(sid, sname, true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "⚡ Enable Bedrock cross-play";
      }
      return;
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = "⚡ Enable Bedrock cross-play";
    }
    toast(err.message, "error");
  }
}

async function startBedrockClaim(sid, sname) {
  try {
    await api(`/api/servers/${sid}/playit/claim/start`, { method: "POST" });
    renderBedrockStatus(sid, sname);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function cancelBedrockClaim(sid, sname) {
  try {
    await api(`/api/servers/${sid}/playit/claim/cancel`, { method: "POST" });
  } catch {}
  if (bedrockPollTimer) {
    clearInterval(bedrockPollTimer);
    bedrockPollTimer = null;
  }
  renderBedrockStatus(sid, sname);
}

async function disableBedrock(sid) {
  if (
    !confirm(
      "Disable Bedrock cross-play? The playit tunnel will close. Your Java address (bore.pub) stays unchanged.",
    )
  )
    return;
  try {
    await api(`/api/servers/${sid}/playit`, {
      method: "POST",
      body: { secret: null },
    });
    toast("Bedrock cross-play disabled");
    closeBedrockModal();
    if (typeof loadServers === "function") loadServers();
  } catch (err) {
    toast(err.message, "error");
  }
}

window.openBedrockModal = openBedrockModal;
window.closeBedrockModal = closeBedrockModal;
window.renderBedrockStatus = renderBedrockStatus;
window.enableBedrock = enableBedrock;
window.startBedrockClaim = startBedrockClaim;
window.cancelBedrockClaim = cancelBedrockClaim;
window.disableBedrock = disableBedrock;

// Logout
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("logoutBtn");
  if (btn)
    btn.onclick = async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch {}
      location.href = "/";
    };
});

// Boot
(async () => {
  await Promise.all([loadMe(), loadServers()]);
  // Full reload every 6s — picks up new/deleted servers, IP/port changes.
  pollTimer = setInterval(() => {
    if (!document.hidden) loadServers();
  }, 6000);
  // Light stats-only refresh every 3s for online servers — keeps CPU/RAM/
  // players/uptime/TPS feeling live without re-rendering the whole list.
  setInterval(refreshLiveStats, 3000);
})();

// Per-server stats refresh — touches only the value text nodes inside each
// card so we don't tear down + re-render the DOM every 3s.
async function refreshLiveStats() {
  if (document.hidden || isDemo) return;
  const live = servers.filter(
    (s) => s.status === "online" || s.status === "starting",
  );
  if (!live.length) return;
  await Promise.all(
    live.map(async (s) => {
      try {
        const r = await api(`/api/servers/${s.id}/status`);
        if (r.stats) s.stats = r.stats;
        if (r.status && r.status !== s.status) s.status = r.status;
      } catch {}
    }),
  );
  // Re-render only the affected cards' inner stats sections rather than the
  // whole grid. Simplest correct thing for now: full re-render but only when
  // something actually changed and the page is foreground.
  renderServers();
}
