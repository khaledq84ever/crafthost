// CraftHost landing page — real live data from /api/servers/public

// Floating Minecraft blocks
const blockHost = document.getElementById('heroBlocks');
if (blockHost) {
  const COLORS = ['#10B981', '#F59E0B', '#7CB342', '#01579B', '#6A1B9A'];
  for (let i = 0; i < 14; i++) {
    const b = document.createElement('div');
    b.className = 'block';
    b.style.left = Math.random() * 100 + '%';
    b.style.top = Math.random() * 100 + '%';
    b.style.background = `linear-gradient(135deg, ${COLORS[i % COLORS.length]}, ${COLORS[(i + 2) % COLORS.length]})`;
    b.style.animationDelay = (Math.random() * 5) + 's';
    b.style.animationDuration = (5 + Math.random() * 5) + 's';
    const size = 30 + Math.random() * 50;
    b.style.width = size + 'px';
    b.style.height = size + 'px';
    blockHost.appendChild(b);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function colorFor(name) {
  const palette = ['#10B981','#F59E0B','#A855F7','#3B82F6','#EF4444','#01579B','#7CB342','#FF6F00','#06B6D4','#EC4899'];
  let h = 0; for (const c of (name || '?')) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

async function loadLivePublic() {
  try {
    const r = await fetch('/api/servers/public', { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const servers = data.servers || [];

    // Update top stats row
    const totalPlayers = servers.reduce((a, s) => a + (s.players_online || 0), 0);
    const avgTps = servers.length ? (servers.reduce((a, s) => a + (s.tps || 20), 0) / servers.length).toFixed(1) : '—';
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('liveServersOnline', String(servers.length));
    setText('livePlayersConnected', String(totalPlayers));
    setText('liveAvgTps', avgTps);
    setText('livePublicHost', `${data.public_host}:${data.public_mc_port}`);

    // Render grid
    const grid = document.getElementById('livePublicGrid');
    if (!grid) return;
    if (!servers.length) {
      // No live public servers — show ready-to-deploy templates instead so the
      // page never looks empty. Each card links to /register.html so click-through
      // is the conversion path.
      const templates = [
        { name: 'Survival', icon: '⛏️',  c: '#10B981', type: 'Paper 1.20.1', desc: 'Classic Minecraft survival with friends. Difficulty: normal, PvP on.' },
        { name: 'Creative', icon: '🏛️', c: '#3B82F6', type: 'Paper 1.21.1', desc: 'Build freely with infinite resources. Flight enabled, no monsters.' },
        { name: 'Skyblock', icon: '☁️', c: '#06B6D4', type: 'Paper 1.20.1', desc: 'Survive on a floating island. Stretch every resource, expand carefully.' },
        { name: 'PvP Arena', icon: '⚔️', c: '#EF4444', type: 'Paper 1.20.4', desc: 'Hardcore PvP. Diamond gear in 3 commands. Last team standing wins.' },
        { name: 'Vanilla Anarchy', icon: '🔥', c: '#F59E0B', type: 'Vanilla 1.20.6', desc: 'No rules, no whitelist. Pure chaos. Bring backup.' },
        { name: 'Modded Adventure', icon: '🐲', c: '#A855F7', type: 'Fabric 1.21.1', desc: 'Curated mods: Sodium, JEI, Iris Shaders pre-installed. Drop in mods.' },
      ];
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;margin-bottom:18px;">
          <div style="font-size:13px;color:var(--emerald);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">★ Starter Templates</div>
          <h3 style="font-size:22px;font-weight:800;margin-bottom:4px;color:var(--text-strong);">Deploy one of these in 60 seconds</h3>
          <p style="color:var(--text-muted);font-size:14px;">Pre-configured, tested, ready to invite friends. Click any to start.</p>
        </div>
        ${templates.map(t => `
          <a href="/register.html" class="card card-hover" style="text-decoration:none;color:inherit;position:relative;transition:transform .15s, border-color .15s;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
              <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg, ${t.c}, ${t.c}aa);display:grid;place-items:center;font-size:24px;flex-shrink:0;">${t.icon}</div>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:800;font-size:15px;color:var(--text-strong);">${t.name}</div>
                <div style="color:var(--text-muted);font-size:12px;">${t.type}</div>
              </div>
              <span class="badge badge-emerald" style="font-size:10px;">FREE</span>
            </div>
            <p style="color:var(--text-muted);font-size:13px;line-height:1.5;margin-bottom:14px;">${t.desc}</p>
            <div class="btn btn-secondary btn-block btn-sm" style="font-weight:700;">Deploy template →</div>
          </a>
        `).join('')}
        <div class="card" style="padding:24px;text-align:center;grid-column:1/-1;background:linear-gradient(135deg, rgba(16,185,129,0.08), rgba(16,185,129,0.02));border-color:rgba(16,185,129,0.25);">
          <div style="font-size:14px;color:var(--text-muted);margin-bottom:10px;">Want to bring your own JAR or modpack?</div>
          <a href="/register.html" class="btn btn-primary" style="font-weight:700;">Custom server — sign up free</a>
        </div>`;
      return;
    }
    const joinAddr = `${data.public_host}:${data.public_mc_port}`;
    grid.innerHTML = servers.map(s => {
      const c = colorFor(s.name);
      const motd = (s.motd || 'A CraftHost server').slice(0, 60);
      const sample = (s.player_sample || []).slice(0, 4).map(escapeHtml).join(', ');
      return `
        <div class="card card-hover" style="position:relative;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
            <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,${c},${c}99);display:grid;place-items:center;color:white;font-weight:800;font-size:20px;">${escapeHtml((s.name || '?')[0].toUpperCase())}</div>
            <div style="overflow:hidden;flex:1;">
              <div style="font-weight:700;font-size:15px;color:var(--text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name)}</div>
              <div style="color:var(--text-muted);font-size:12px;">${escapeHtml((s.type || 'paper').charAt(0).toUpperCase() + (s.type || 'paper').slice(1))} ${escapeHtml(s.mc_version || s.version || '')}</div>
            </div>
            <span class="badge badge-emerald" style="font-size:10px;"><span class="dot online"></span>LIVE</span>
          </div>
          <div style="font-style:italic;color:var(--text-muted);font-size:13px;margin-bottom:12px;min-height:18px;">"${escapeHtml(motd)}"</div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--text-muted);margin-bottom:14px;">
            <span>👥 <strong style="color:var(--text-strong);">${s.players_online}/${s.players_max}</strong></span>
            <span>⚡ ${(s.tps || 20).toFixed(1)} TPS</span>
          </div>
          ${sample ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">Playing: ${sample}</div>` : ''}
          <button class="btn btn-secondary btn-block btn-sm" onclick="copyJoin('${escapeHtml(joinAddr)}', this)">📋 Copy join address</button>
        </div>
      `;
    }).join('');
  } catch (err) {
    const grid = document.getElementById('livePublicGrid');
    if (grid) grid.innerHTML = `<div class="card" style="padding:40px;text-align:center;color:var(--text-muted);grid-column:1/-1;">Could not load live servers (${err.message}).</div>`;
  }
}

window.copyJoin = (addr, btn) => {
  navigator.clipboard?.writeText(addr);
  const orig = btn.textContent;
  btn.textContent = '✓ Copied!';
  setTimeout(() => { btn.textContent = orig; }, 1800);
};

loadLivePublic();
setInterval(loadLivePublic, 15_000);
