// CraftHost — shared client helpers

// ── i18n: English ↔ Arabic ─────────────────────────────────────────────────
// Strings are referenced via [data-i18n="key"] on HTML nodes, or window.t(key).
// Language preference persists in localStorage.
window.I18N = {
  en: {
    // Navigation
    nav_servers: "Servers",
    nav_plugins: "Plugins",
    nav_files: "Files",
    nav_console: "Console",
    nav_settings: "Settings",
    nav_jars: "JAR Library",
    nav_account: "Account",
    // Common actions
    sign_in: "Sign in",
    sign_up: "Sign up",
    sign_out: "Sign out",
    create_server: "Create Server",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    delete: "Delete",
    cancel: "Cancel",
    save: "Save",
    apply: "Apply",
    loading: "Loading…",
    confirm: "Confirm",
    back: "Back",
    next: "Next",
    upload: "Upload",
    download: "Download",
    edit: "Edit",
    search: "Search",
    install: "Install",
    refresh: "Refresh",
    send: "Send",
    copy: "Copy",
    close: "Close",
    // Status
    online: "Online",
    offline: "Offline",
    starting: "Starting…",
    stopped: "Stopped",
    // Stats
    players: "Players",
    uptime: "Uptime",
    cpu: "CPU",
    ram: "RAM",
    tps: "TPS",
    address: "Address",
    mc_version: "MC version",
    host_port: "Host port",
    exit_code: "Exit code",
    msPT: "MSPT",
    // Landing page
    hero_title: "Your Minecraft Server.",
    hero_title_line2: "Live in 60 Seconds.",
    hero_sub:
      "Deploy vanilla, modded, or custom-JAR servers in a click. Real hardware. Zero throttling. DDoS-protected.",
    hero_sub_free:
      "Deploy vanilla, modded, or custom-JAR Minecraft servers in one click. Completely free.",
    hero_cta_trial: "Start Free 7-Day Trial →",
    hero_cta_plans: "View Plans",
    hero_cta_deploy: "Deploy My Server →",
    hero_cta_pricing: "View pricing",
    landing_systems_ok: "All systems operational · 99.98% uptime",
    landing_stats_servers: "Servers Online Now",
    landing_stats_players: "Players Connected",
    landing_stats_tps: "Average TPS",
    landing_stats_host: "Public Join Address",
    landing_live_badge: "🟢 Live Right Now",
    landing_live_title: "Real servers, real players",
    landing_live_sub:
      "Every card below is an actual Minecraft server running on CraftHost. Click Copy and paste into your client.",
    landing_features_badge: "Features",
    landing_features_title: "Everything you need to run a thriving server.",
    landing_features_sub:
      "Built on bare metal. Tuned for low MSPT. Designed for builders, not bureaucrats.",
    landing_pricing_badge: "Pricing",
    landing_pricing_title: "Plans that scale with your community.",
    landing_faq_badge: "FAQ",
    landing_faq_title: "Common questions, straight answers.",
    // Dashboard
    welcome_back: "Welcome back",
    your_servers: "Your Servers",
    manage_sub: "Manage your Minecraft servers, plugins, and worlds.",
    stat_active: "Active servers",
    stat_players_online: "Players online",
    stat_avg_tps: "Avg. TPS",
    stat_plan: "Plan",
    health_check: "Health Check",
    quick_deploy: "⚡ Quick Deploy",
    quick_deploy_sub:
      "Click any template to spin up a pre-configured server in seconds — no wizard.",
    qd_survival: "Survival",
    qd_creative: "Creative",
    qd_skyblock: "Skyblock",
    qd_modded: "Modded",
    // Auth pages
    auth_email: "Email",
    auth_password: "Password",
    auth_username: "Username",
    auth_signin_title: "Welcome back",
    auth_signin_sub: "Sign in to your CraftHost account",
    auth_signup_title: "Create your account",
    auth_signup_sub: "Start hosting in 60 seconds",
    auth_forgot: "Forgot password?",
    auth_no_account: "Don't have an account?",
    auth_have_account: "Already have an account?",
    auth_remember: "Keep me signed in for 30 days",
    auth_reset_title: "Reset password",
    // Marketplace
    market_title: "Plugins & Mods",
    market_sub:
      "200,000+ from Modrinth & CurseForge. One-click install on your server.",
    market_featured: "🔥 Featured Modpacks",
    market_featured_sub: "Live from Modrinth",
    market_top_picks: "⭐ Top Plugins · One-Click",
    market_top_sub: "Curated by CraftHost · paper/spigot/purpur",
    market_all: "All Plugins & Mods",
    market_search_ph: "Search 200,000+ plugins & mods...",
    market_load_more: "Load more →",
    // Files
    files_title: "File Manager",
    files_sub: "Browse, edit, upload, and download files inside your server.",
    files_new_folder: "New folder",
    files_upload_btn: "Upload",
    files_settings_tab: "Settings",
    files_backups_tab: "Backups",
    files_files_tab: "Files",
    // Console
    console_title: "Live Console",
    console_send_ph: "Type a command and press Enter...",
    // Billing
    billing_title: "Billing & Plan",
    billing_balance: "Balance",
    billing_plan: "Current plan",
    billing_invoices: "Invoices",
    // Settings page
    settings_title: "Account Settings",
    settings_change_password: "Change password",
    settings_delete_account: "Delete account",
    // JAR Library
    jars_title: "JAR Library",
    jars_sub: "Your custom JARs and the latest official builds.",
    // Footer / Chrome
    footer_credit: "Programmed by",
    free_plan: "Free",
    upgrade: "Upgrade",
    // Pricing page
    nav_features: "Features",
    nav_pricing: "Pricing",
    nav_faq: "FAQ",
    get_started: "Get Started",
    open_dashboard: "Dashboard",
    home: "Home",
    pricing_title: "Simple, transparent pricing.",
    pricing_sub:
      "All plans include DDoS protection, automatic backups, NVMe storage, and 24/7 support.",
    start_free: "Start free",
    choose: "Choose",
    popular: "Popular",
    feature: "Feature",
    cpu_cores: "CPU cores",
    nvme: "NVMe storage",
    player_slots: "Player slots",
    plugin_slots: "Plugin slots",
    backup_retention: "Backup retention",
    backup_interval: "Backup interval",
    custom_jar: "Custom JAR upload",
    dedicated_ip: "Dedicated IP",
    priority_support: "Priority support",
    ddos: "DDoS protection",
    bedrock_java: "Bedrock & Java",
  },
  ar: {
    nav_servers: "السيرفرات",
    nav_plugins: "الإضافات",
    nav_files: "الملفات",
    nav_console: "الكونسول",
    nav_settings: "الإعدادات",
    nav_jars: "مكتبة JAR",
    nav_account: "الحساب",
    sign_in: "تسجيل الدخول",
    sign_up: "إنشاء حساب",
    sign_out: "تسجيل الخروج",
    create_server: "إنشاء سيرفر",
    start: "تشغيل",
    stop: "إيقاف",
    restart: "إعادة",
    delete: "حذف",
    cancel: "إلغاء",
    save: "حفظ",
    apply: "تطبيق",
    loading: "جارٍ التحميل…",
    confirm: "تأكيد",
    back: "رجوع",
    next: "التالي",
    upload: "رفع",
    download: "تنزيل",
    edit: "تعديل",
    search: "بحث",
    install: "تثبيت",
    refresh: "تحديث",
    send: "إرسال",
    copy: "نسخ",
    close: "إغلاق",
    online: "متصل",
    offline: "متوقف",
    starting: "يبدأ التشغيل…",
    stopped: "متوقف",
    players: "اللاعبون",
    uptime: "مدة التشغيل",
    cpu: "المعالج",
    ram: "الذاكرة",
    tps: "TPS",
    address: "العنوان",
    mc_version: "إصدار اللعبة",
    host_port: "منفذ الاتصال",
    exit_code: "كود الخروج",
    msPT: "MSPT",
    hero_title: "سيرفر ماين كرافت الخاص بك.",
    hero_title_line2: "جاهز خلال ٦٠ ثانية.",
    hero_sub:
      "انشر سيرفرات فانيلا أو مودات أو JAR مخصص بضغطة. أجهزة حقيقية، بدون اختناقات، حماية من DDoS.",
    hero_sub_free:
      "انشر سيرفرات ماين كرافت — فانيلا أو مودات أو JAR مخصص — بضغطة واحدة. مجاناً تماماً.",
    hero_cta_trial: "ابدأ تجربة مجانية ٧ أيام ←",
    hero_cta_plans: "عرض الخطط",
    hero_cta_deploy: "انشر سيرفري ←",
    hero_cta_pricing: "عرض الأسعار",
    landing_systems_ok: "كل الأنظمة تعمل · جاهزية ٩٩.٩٨٪",
    landing_stats_servers: "سيرفرات تعمل الآن",
    landing_stats_players: "لاعبون متصلون",
    landing_stats_tps: "متوسط TPS",
    landing_stats_host: "عنوان الانضمام العام",
    landing_live_badge: "🟢 يعمل الآن",
    landing_live_title: "سيرفرات حقيقية، لاعبون حقيقيون",
    landing_live_sub:
      "كل كرت بالأسفل هو سيرفر ماين كرافت فعلي يعمل على CraftHost. اضغط نسخ وألصقه في عميل اللعبة.",
    landing_features_badge: "المميزات",
    landing_features_title: "كل ما تحتاجه لإدارة مجتمع ناجح.",
    landing_features_sub: "مبني على أجهزة فعلية. مضبوط لأداء MSPT منخفض.",
    landing_pricing_badge: "الخطط",
    landing_pricing_title: "خطط تنمو مع مجتمعك.",
    landing_faq_badge: "الأسئلة الشائعة",
    landing_faq_title: "أسئلة شائعة وإجابات مباشرة.",
    welcome_back: "مرحباً بعودتك",
    your_servers: "سيرفراتك",
    manage_sub: "أدر سيرفرات ماين كرافت والإضافات والعوالم.",
    stat_active: "السيرفرات النشطة",
    stat_players_online: "اللاعبون المتصلون",
    stat_avg_tps: "متوسط TPS",
    stat_plan: "الخطة",
    health_check: "فحص الحالة",
    auth_email: "البريد الإلكتروني",
    auth_password: "كلمة المرور",
    auth_username: "اسم المستخدم",
    auth_signin_title: "مرحباً بعودتك",
    auth_signin_sub: "سجّل دخولك إلى حساب CraftHost",
    auth_signup_title: "أنشئ حسابك",
    auth_signup_sub: "ابدأ الاستضافة خلال ٦٠ ثانية",
    auth_forgot: "نسيت كلمة المرور؟",
    auth_no_account: "لا تملك حساباً؟",
    auth_have_account: "تملك حساباً بالفعل؟",
    auth_remember: "إبقني مسجلاً ٣٠ يوماً",
    auth_reset_title: "إعادة تعيين كلمة المرور",
    market_title: "الإضافات والمودات",
    market_sub:
      "أكثر من ٢٠٠ ألف من Modrinth و CurseForge. تثبيت بضغطة على سيرفرك.",
    market_featured: "🔥 مودباكس مميزة",
    market_featured_sub: "مباشرة من Modrinth",
    market_top_picks: "⭐ أفضل الإضافات · تثبيت بضغطة",
    market_top_sub: "مختارة من CraftHost · paper/spigot/purpur",
    market_all: "كل الإضافات والمودات",
    quick_deploy: "⚡ نشر سريع",
    quick_deploy_sub:
      "اضغط على أي قالب لتشغيل سيرفر جاهز خلال ثوانٍ — بدون معالج.",
    qd_survival: "البقاء",
    qd_creative: "الإبداع",
    qd_skyblock: "سكاي بلوك",
    qd_modded: "مودات",
    market_search_ph: "ابحث في أكثر من ٢٠٠ ألف إضافة ومود...",
    market_load_more: "تحميل المزيد ←",
    files_title: "مدير الملفات",
    files_sub: "تصفّح وعدّل وارفع وحمّل الملفات داخل سيرفرك.",
    files_new_folder: "مجلد جديد",
    files_upload_btn: "رفع",
    files_settings_tab: "الإعدادات",
    files_backups_tab: "النسخ الاحتياطية",
    files_files_tab: "الملفات",
    console_title: "الكونسول المباشر",
    console_send_ph: "اكتب أمراً واضغط Enter...",
    billing_title: "الفواتير والخطة",
    billing_balance: "الرصيد",
    billing_plan: "الخطة الحالية",
    billing_invoices: "الفواتير",
    settings_title: "إعدادات الحساب",
    settings_change_password: "تغيير كلمة المرور",
    settings_delete_account: "حذف الحساب",
    jars_title: "مكتبة JAR",
    jars_sub: "ملفات JAR المخصصة وأحدث الإصدارات الرسمية.",
    footer_credit: "برمجة",
    free_plan: "مجاني",
    upgrade: "ترقية",
    nav_features: "المميزات",
    nav_pricing: "الأسعار",
    nav_faq: "الأسئلة الشائعة",
    get_started: "ابدأ الآن",
    open_dashboard: "لوحة التحكم",
    home: "الرئيسية",
    pricing_title: "أسعار بسيطة وواضحة.",
    pricing_sub:
      "كل الخطط تتضمن حماية DDoS ونسخاً احتياطية تلقائية وتخزين NVMe ودعماً ٢٤/٧.",
    start_free: "ابدأ مجاناً",
    choose: "اختر",
    popular: "الأكثر شعبية",
    feature: "الميزة",
    cpu_cores: "أنوية المعالج",
    nvme: "تخزين NVMe",
    player_slots: "عدد اللاعبين",
    plugin_slots: "عدد الإضافات",
    backup_retention: "مدة حفظ النسخ",
    backup_interval: "تكرار النسخ",
    custom_jar: "رفع JAR مخصص",
    dedicated_ip: "IP مخصص",
    priority_support: "دعم ذو أولوية",
    ddos: "حماية DDoS",
    bedrock_java: "Bedrock و Java",
  },
};
window.t = (key) => {
  const lang = localStorage.getItem("crafthost.lang") || "en";
  return (
    (window.I18N[lang] && window.I18N[lang][key]) || window.I18N.en[key] || key
  );
};
window.applyLang = (lang) => {
  lang = lang === "ar" ? "ar" : "en";
  localStorage.setItem("crafthost.lang", lang);
  document.documentElement.setAttribute("lang", lang);
  document.documentElement.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  document.body && document.body.classList.toggle("lang-ar", lang === "ar");
  document.body && document.body.classList.toggle("lang-en", lang === "en");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (k && window.I18N[lang] && window.I18N[lang][k])
      el.textContent = window.I18N[lang][k];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (k && window.I18N[lang] && window.I18N[lang][k])
      el.setAttribute("placeholder", window.I18N[lang][k]);
  });
  // Update the language toggle button label to show the OTHER language
  document.querySelectorAll("[data-lang-toggle]").forEach((btn) => {
    btn.textContent = lang === "ar" ? "EN" : "عربي";
  });
};

// Inject PWA manifest + favicon + Open Graph / Twitter tags + theme color into
// every page. Pages can override by defining their own tags (this script only
// adds if not already present). Idempotent — safe to call from anywhere.
(function injectMetaAndManifest() {
  if (typeof document === "undefined") return;
  function add(tag, attrs) {
    // Skip if already present with the same key attr
    const keyAttr = attrs.property
      ? "property"
      : attrs.name
        ? "name"
        : attrs.rel
          ? "rel"
          : null;
    if (
      keyAttr &&
      document.head.querySelector(`${tag}[${keyAttr}="${attrs[keyAttr]}"]`)
    )
      return;
    const el = document.createElement(tag);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    document.head.appendChild(el);
  }
  // Favicon (SVG works in all modern browsers, scales perfectly)
  add("link", { rel: "icon", type: "image/svg+xml", href: "/icon.svg" });
  add("link", { rel: "apple-touch-icon", href: "/icon.svg" });
  // PWA manifest — Chromium will offer "Install app" once visited twice
  add("link", { rel: "manifest", href: "/manifest.json" });
  // Theme color (Chrome/Android address bar + iOS Safari tab color)
  add("meta", { name: "theme-color", content: "#0f172a" });
  add("meta", {
    name: "apple-mobile-web-app-status-bar-style",
    content: "black-translucent",
  });
  add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
  add("meta", { name: "apple-mobile-web-app-title", content: "CraftHost" });
  // SEO description (most pages already have a <meta name="description">, but
  // pages without one will get this default)
  add("meta", {
    name: "description",
    content:
      "Free Minecraft server hosting. One-click Paper deploy in 60 seconds. Plugins, world import, custom JARs, real public IP — all free.",
  });
  // Open Graph — share previews on Discord/Twitter/Slack/Facebook
  const url = location.origin + location.pathname;
  add("meta", { property: "og:type", content: "website" });
  add("meta", { property: "og:site_name", content: "CraftHost" });
  add("meta", {
    property: "og:title",
    content: document.title || "CraftHost — Free Minecraft Server Hosting",
  });
  add("meta", {
    property: "og:description",
    content:
      "Free Minecraft server hosting. One-click Paper deploy in 60 seconds. Plugins, world import, custom JARs — all free.",
  });
  add("meta", { property: "og:url", content: url });
  add("meta", { property: "og:image", content: location.origin + "/og.svg" });
  add("meta", { property: "og:image:width", content: "1200" });
  add("meta", { property: "og:image:height", content: "630" });
  add("meta", {
    property: "og:locale",
    content: (document.documentElement.lang || "en").startsWith("ar")
      ? "ar_KW"
      : "en_US",
  });
  // Twitter card
  add("meta", { name: "twitter:card", content: "summary_large_image" });
  add("meta", {
    name: "twitter:title",
    content: document.title || "CraftHost",
  });
  add("meta", {
    name: "twitter:description",
    content: "Free Minecraft server hosting. Deploy in 60 seconds.",
  });
  add("meta", { name: "twitter:image", content: location.origin + "/og.svg" });
})();

// Inject Google Fonts (Inter for EN, Tajawal for AR — both load once).
(function loadFonts() {
  if (typeof document === "undefined") return;
  if (document.getElementById("ch-fonts")) return;
  const pre1 = document.createElement("link");
  pre1.rel = "preconnect";
  pre1.href = "https://fonts.googleapis.com";
  document.head.appendChild(pre1);
  const pre2 = document.createElement("link");
  pre2.rel = "preconnect";
  pre2.href = "https://fonts.gstatic.com";
  pre2.crossOrigin = "anonymous";
  document.head.appendChild(pre2);
  const link = document.createElement("link");
  link.id = "ch-fonts";
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Tajawal:wght@400;500;700;900&display=swap";
  document.head.appendChild(link);
})();

// Inject credit footer + language toggle into every page.
(function injectChrome() {
  if (typeof document === "undefined") return;
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(() => {
    // Credit footer — single shared element across every page, links to
    // the author's X/Twitter account.
    if (!document.querySelector(".site-credit, .ft-credit")) {
      const f = document.createElement("div");
      f.className = "site-credit";
      f.innerHTML = `<span data-i18n="footer_credit">Programmed by</span> <a href="https://x.com/KhaledQ84Ever" target="_blank" rel="noopener noreferrer" aria-label="@KhaledQ84Ever on X">@KhaledQ84Ever</a>`;
      // On dashboard-style pages the .dash grid is min-height:100vh, so a
      // body-appended credit lands below the fold with a huge empty gap.
      // Append it inside the content column so it follows the page content.
      const dashMain = document.querySelector(".dash main.main");
      if (dashMain) {
        f.style.marginTop = "28px";
        f.style.background = "transparent";
        dashMain.appendChild(f);
      } else {
        document.body.appendChild(f);
      }
    }
    // Home icon — fixed top-left circular button on every page so users can
    // always return to the marketing homepage with one tap. Idempotent —
    // skips injection if the page already has a brand-link to "/" visible
    // OR if a previous app.js run already added one.
    if (!document.querySelector(".ch-home-btn")) {
      const existingBrand = document.querySelector('a.brand[href="/"]');
      // On dashboard pages the brand lives in the collapsing sidebar, so add
      // the home icon to the topbar regardless. On marketing/auth pages the
      // brand is in the nav already, but a small home icon is still helpful
      // mobile-side.
      const a = document.createElement("a");
      a.href = "/";
      a.className = "ch-home-btn";
      a.setAttribute("aria-label", "CraftHost — Home");
      a.title = "Home";
      // Match the index brand: [C] CraftHost. This way every page has the same
      // recognizable brand element users can click to return to the homepage.
      a.innerHTML =
        '<span class="brand-mark">C</span><span class="ch-home-label">CraftHost</span>';
      document.body.appendChild(a);
    }
    // Auth-aware nav + instant user-info hydration. After login the user object
    // is cached in localStorage.crafthost.user (set by login.html / register.html).
    // On every page load we synchronously read it and apply to UI elements
    // BEFORE any API round-trip — no flash of "Visitor" / "Sign in" state.
    // Then asynchronously verify the session via /api/auth/me; if invalid, clear
    // the cached info.
    (function hydrateUserFromCache() {
      let cached = null;
      try {
        const raw = localStorage.getItem("crafthost.user");
        if (raw) cached = JSON.parse(raw);
      } catch {}
      if (cached?.username) {
        // Hide Sign-in button on landing
        const signIn = document.getElementById("navSignIn");
        if (signIn) signIn.style.display = "none";
        // Pre-fill dashboard greeting + avatar synchronously (before loadMe runs)
        const nameEl = document.getElementById("userName");
        if (nameEl) nameEl.textContent = cached.username;
        const av = document.getElementById("avatar");
        if (av) av.textContent = (cached.username[0] || "U").toUpperCase();
        // Any element with [data-user-name] / [data-user-email] gets filled
        document.querySelectorAll("[data-user-name]").forEach((el) => {
          el.textContent = cached.username;
        });
        document.querySelectorAll("[data-user-email]").forEach((el) => {
          el.textContent = cached.email || "";
        });
      }
    })();
    // Global signed-in signal — other modules (dashboard.js loadServers,
    // useServerPicker) read window.isSignedIn / await window.authReady before
    // deciding whether to show "demo" mode. Fixes the bug where a transient
    // network blip on /api/servers made a logged-in user look like a visitor.
    // Optimistic seed from cache so deploy buttons work immediately on a fresh
    // page load; the /api/auth/me call below corrects it within ~100ms.
    window.isSignedIn = !!(() => {
      try {
        return JSON.parse(localStorage.getItem("crafthost.user") || "null");
      } catch {
        return null;
      }
    })();
    window.currentUser = null;
    try {
      const raw = localStorage.getItem("crafthost.user");
      if (raw) window.currentUser = JSON.parse(raw);
    } catch {}
    window.authReady = (async function reflectAuth() {
      try {
        const r = await fetch("/api/auth/me", { credentials: "include" });
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          const u = data?.user || data;
          if (u?.username) {
            window.isSignedIn = true;
            window.currentUser = u;
            // Refresh cache (covers username/email changes from /settings)
            try {
              localStorage.setItem("crafthost.user", JSON.stringify(u));
            } catch {}
            const signIn = document.getElementById("navSignIn");
            if (signIn) signIn.style.display = "none";
          }
        } else if (r.status === 401) {
          // Session expired or revoked — clear cache so the next page load
          // doesn't show stale identity.
          window.isSignedIn = false;
          window.currentUser = null;
          try {
            localStorage.removeItem("crafthost.user");
          } catch {}
        }
        // 5xx / network failure: leave optimistic isSignedIn untouched so a
        // server hiccup doesn't kick the user out of their dashboard.
      } catch {
        // Network failure — keep optimistic state from cache.
      }
      return window.isSignedIn;
    })();
    // Global logout — any element with id=logoutBtn / id=logoutLink /
    // class=logout-link triggers a full sign-out (clear cache + DELETE
    // session + redirect to /login.html). Page-specific handlers can
    // pre-empt by stopping propagation if they want different behavior.
    document
      .querySelectorAll("#logoutBtn, #logoutLink, .logout-link")
      .forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          try {
            localStorage.removeItem("crafthost.user");
          } catch {}
          try {
            await fetch("/api/auth/logout", {
              method: "POST",
              credentials: "include",
            });
          } catch {}
          location.href = "/login.html";
        });
      });

    // Inject Sign out into the sidebar of every .dash page that doesn't
    // already have one. Appears under Settings.
    (function injectSidebarSignOut() {
      const sideNav = document.querySelector(".side-nav");
      if (!sideNav) return;
      if (sideNav.querySelector("#logoutLink, .logout-link")) return;
      const a = document.createElement("a");
      a.href = "#";
      a.id = "logoutLink";
      a.className = "logout-link";
      a.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span data-i18n="sign_out">' +
        (window.t ? window.t("sign_out") : "Sign out") +
        "</span>";
      // Re-bind global handler since this element didn't exist when the
      // outer forEach ran.
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          localStorage.removeItem("crafthost.user");
        } catch {}
        try {
          await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "include",
          });
        } catch {}
        location.href = "/login.html";
      });
      sideNav.appendChild(a);
    })();

    // Sidebar icons — auto-inject the same SVGs the dashboard uses into the
    // sidebar of every .dash page (billing/settings/files/etc), keyed by href.
    // This way I don't have to copy-paste 8 SVGs across 8 HTML files. Also
    // sets the `active` class on the link matching the current pathname.
    (function injectSidebarIcons() {
      const SIDEBAR_ICONS = {
        "/dashboard.html":
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
        "/marketplace.html":
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
        "/files.html":
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        "/jars.html":
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        "/console.html":
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        "/settings.html":
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
      };
      const sideNav = document.querySelector(".side-nav");
      if (!sideNav) return;
      const currentPath =
        location.pathname.replace(/\/$/, "") || "/dashboard.html";
      sideNav.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href");
        // Add the active class if this link matches the current page
        if (href === currentPath || href === location.pathname)
          a.classList.add("active");
        const icon = SIDEBAR_ICONS[href];
        if (!icon) return;
        // Don't double-inject if the page's HTML already has an inline SVG
        if (a.querySelector("svg")) return;
        // Prepend the SVG so the text stays in place
        a.insertAdjacentHTML("afterbegin", icon);
      });
    })();
    // Language toggle — float top-right (fixed) if no topbar exists, otherwise
    // append to topbar/header. Button shows the OTHER language as the call-to-action.
    if (!document.querySelector("[data-lang-toggle]")) {
      const btn = document.createElement("button");
      btn.setAttribute("data-lang-toggle", "1");
      btn.className = "lang-toggle";
      btn.type = "button";
      btn.setAttribute("aria-label", "Switch language");
      btn.addEventListener("click", () => {
        const cur = localStorage.getItem("crafthost.lang") || "en";
        window.applyLang(cur === "ar" ? "en" : "ar");
      });
      // Prefer placing the lang toggle inside an existing nav so it doesn't float
      // over CTAs. nav.nav is the landing/marketing nav (index.html, pricing.html).
      // .nav-cta is the right-side CTA cluster — append there so it sits inline
      // with the dashboard / sign-in buttons.
      const cta = document.querySelector(".nav .nav-cta");
      const actions = document.querySelector(".topbar-actions");
      const topbar =
        cta ||
        actions ||
        document.querySelector(".topbar") ||
        document.querySelector("header") ||
        document.querySelector("nav.main-nav") ||
        document.querySelector("nav.nav");
      if (topbar) topbar.appendChild(btn);
      else document.body.appendChild(btn);
    }
    // Apply the saved language (or detect from browser on first visit)
    const saved = localStorage.getItem("crafthost.lang");
    const lang =
      saved ||
      ((navigator.language || "en").toLowerCase().startsWith("ar")
        ? "ar"
        : "en");
    window.applyLang(lang);
  });
})();

window.api = async (path, opts = {}) => {
  const init = {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    credentials: "include",
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(path, init);
  let data;
  try {
    data = await r.json();
  } catch {
    data = {};
  }
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status; // 401 = unauth, 5xx = server, etc.
    err.transient = r.status >= 500; // server-side issue, retry is reasonable
    err.data = data; // full response body (e.g. conflict details)
    throw err;
  }
  return data;
};

window.toast = (msg, type = "success") => {
  const host =
    document.getElementById("toasts") ||
    (() => {
      const h = document.createElement("div");
      h.className = "toast-host";
      h.id = "toasts";
      document.body.appendChild(h);
      return h;
    })();
  const t = document.createElement("div");
  t.className =
    "toast " + (type === "error" ? "error" : type === "warn" ? "warn" : "");
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transform = "translateX(50px)";
    setTimeout(() => t.remove(), 300);
  }, 3500);
};

window.fmtBytes = (b) => {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + " " + u[i];
};

window.fmtTime = (sec) => {
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
};

window.copyText = (text) => {
  navigator.clipboard.writeText(text);
  toast("Copied!");
};

// Auto-inject the unified mobile bottom nav on EVERY page (not just dashboard).
// Uses professional Lucide-style stroke SVG icons (no cartoon emoji).
(function injectMobileNav() {
  if (typeof document === "undefined") return;
  // Lucide-derived stroke icons — uniform 24x24 viewBox, currentColor, 1.8 stroke.
  const ICONS = {
    server:
      '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/></svg>',
    plugin:
      '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v3M15 2v3M9 19v3M15 19v3"/><path d="M2 9h3M2 15h3M19 9h3M19 15h3"/><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
    folder:
      '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>',
    package:
      '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    terminal:
      '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    card: '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    settings:
      '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    help: '<svg class="mn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };
  document.addEventListener("DOMContentLoaded", () => {
    if (document.querySelector(".mobile-nav")) return;
    const HIDE_PATHS = [
      "/",
      "/index",
      "/login",
      "/register",
      "/forgot",
      "/reset",
      "/status",
      "/pricing",
    ];
    const pathNorm =
      location.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";
    if (HIDE_PATHS.includes(pathNorm)) return;
    const here = pathNorm === "/" ? "/dashboard" : pathNorm;
    const items = [
      { href: "/dashboard.html", label: "nav_servers", icon: ICONS.server },
      { href: "/marketplace.html", label: "nav_plugins", icon: ICONS.plugin },
      { href: "/files.html", label: "nav_files", icon: ICONS.folder },
      { href: "/jars.html", label: "nav_jars", icon: ICONS.package },
      { href: "/console.html", label: "nav_console", icon: ICONS.terminal },
      { href: "/settings.html", label: "nav_settings", icon: ICONS.settings },
    ];
    const nav = document.createElement("nav");
    nav.className = "mobile-nav";
    nav.innerHTML = `<div class="mobile-nav-inner">${items
      .map((i) => {
        const active =
          here === i.href.replace(/\.html$/, "") ? ' class="active"' : "";
        return `<a href="${i.href}"${active}>${i.icon}<div data-i18n="${i.label}">${window.I18N?.en?.[i.label] || i.label}</div></a>`;
      })
      .join("")}</div>`;
    document.body.appendChild(nav);

    // Hamburger to open the side nav as a drawer on small screens
    const side = document.querySelector(".side");
    if (side && !document.querySelector(".menu-btn")) {
      const topbar = document.querySelector(".topbar");
      if (topbar) {
        const btn = document.createElement("button");
        btn.className = "btn btn-ghost btn-sm menu-btn";
        btn.innerHTML = "☰";
        btn.setAttribute("aria-label", "Menu");
        btn.style.cssText =
          "display:none;font-size:18px;margin-right:8px;flex-shrink:0;";
        btn.onclick = () => side.classList.toggle("open");
        // If the page uses a .topbar-title block, put the hamburger INSIDE it
        // so [☰ Title] stays grouped on the left, instead of floating as a
        // third flex child that confuses justify-content:space-between.
        const titleBlock = topbar.querySelector(".topbar-title");
        if (titleBlock) {
          titleBlock.insertBefore(btn, titleBlock.firstChild);
        } else {
          topbar.insertBefore(btn, topbar.firstChild);
        }
      }
      const bd = document.createElement("div");
      bd.className = "side-backdrop";
      bd.onclick = () => side.classList.remove("open");
      document.body.appendChild(bd);
    }
  });
})();

// Fetch user's servers and populate a <select>. Persists selection across pages.
// Returns { servers, current, demo, empty, signedIn, onChange(cb) }.
//   demo     — true only when /api/servers errors (i.e. visitor not signed in)
//   empty    — true when signed in but has no servers yet
//   signedIn — true when API call succeeded
window.useServerPicker = async (selectEl) => {
  const KEY = "crafthost.currentServerId";
  let servers = [];
  let demo = false;
  let signedIn = false;
  // Wait for /api/auth/me to settle so we know whether the user is really
  // logged in. Without this, a slow /api/servers response could race ahead and
  // demote a logged-in user to "demo" mode.
  try {
    if (window.authReady) await window.authReady;
  } catch {}
  try {
    const r = await api("/api/servers");
    servers = r.servers || [];
    signedIn = true;
  } catch (err) {
    // Only show demo placeholders when the user is genuinely not signed in
    // (401). Network blips, 5xx, or any other failure should NOT kick a logged-
    // in user back to demo — that was the bug where users got "Visitor" after
    // they had just logged in.
    if (err?.status === 401 || !window.isSignedIn) {
      demo = true;
      servers = [
        {
          id: "demo-survival",
          name: "Survival World (demo)",
          type: "paper",
          version: "1.21.1",
          status: "online",
          port: 25565,
        },
        {
          id: "demo-creative",
          name: "Creative Build (demo)",
          type: "vanilla",
          version: "1.21",
          status: "offline",
          port: 25566,
        },
      ];
    } else {
      // Signed in but the API call failed transiently. Keep signed-in state
      // and show an empty list rather than demo cards.
      signedIn = true;
      servers = [];
      try {
        window.toast?.("Could not load your servers — retrying…", "warn");
      } catch {}
    }
  }
  const empty = signedIn && servers.length === 0;
  if (empty) {
    servers = [
      {
        id: "no-server",
        name: "No servers yet — create one in the dashboard",
        type: "",
        version: "",
        status: "offline",
        port: 0,
      },
    ];
  }
  const savedId = localStorage.getItem(KEY);
  let current = servers.find((s) => s.id === savedId) || servers[0];

  if (selectEl) {
    selectEl.innerHTML = servers
      .map((s) => {
        const dot =
          s.status === "online" || s.status === "starting" ? "🟢" : "🔴";
        const label = `${dot} ${s.name}${s.version ? " — " + (s.type ? s.type[0].toUpperCase() + s.type.slice(1) : "") + " " + s.version : ""}`;
        return `<option value="${s.id}"${s.id === current.id ? " selected" : ""}>${label}</option>`;
      })
      .join("");
  }

  const listeners = [];
  if (selectEl) {
    selectEl.addEventListener("change", () => {
      current = servers.find((s) => s.id === selectEl.value) || current;
      localStorage.setItem(KEY, current.id);
      listeners.forEach((fn) => fn(current));
    });
  }

  return {
    get current() {
      return current;
    },
    servers,
    demo,
    empty,
    signedIn,
    onChange: (fn) => listeners.push(fn),
  };
};
