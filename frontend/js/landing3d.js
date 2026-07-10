// CraftHost landing — 3D voxel grass block scene.
// One InstancedMesh of 64 cubes morphs through the scroll story:
//   hero (assembled block) → engines (5 colored clusters) → cross-play
//   (Java + Bedrock twin blocks) → deploy (block by terminal) → CTA (ignite).
// Clicking the block bursts it apart; it reassembles on its own.
// Fails closed: no WebGL / any error → static page keeps working.
import * as THREE from "/js/vendor/three.module.min.js";

(() => {
  const canvas = document.getElementById("gl3d");
  if (!canvas) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    return; // no WebGL — leave the static page alone
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  document.body.classList.add("gl-on");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 60);
  camera.position.set(0, 0, 10);

  scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 7, 6);
  scene.add(key);
  const rim = new THREE.PointLight(0x34d399, 1.4, 30);
  rim.position.set(-5, -2, 4);
  scene.add(rim);
  const ember = new THREE.PointLight(0xf59e0b, 0.25, 18); // CTA ignition
  scene.add(ember);

  // ---- voxel block -------------------------------------------------------
  const N = 4,
    CELL = 0.62,
    COUNT = N * N * N;
  const geo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.5,
    metalness: 0.12,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  const group = new THREE.Group();
  group.add(mesh);
  scene.add(group);

  const rnd = (seed) => {
    // deterministic per-index jitter so every load looks the same
    let s = Math.sin(seed * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const C = (hex) => new THREE.Color(hex);
  // grass block: emerald turf on amber dirt — the brand palette, literally
  const TOP = [C("#34d399"), C("#10b981"), C("#059669"), C("#3ddc97")];
  const DIRT = [C("#b45309"), C("#92400e"), C("#a16207"), C("#7c4a12")];
  const ENGINE = [C("#e8ecf3"), C("#a78bfa"), C("#f59e0b"), C("#22d3ee"), C("#fb923c")];
  const BEDROCK = [C("#22d3ee"), C("#60a5fa"), C("#38bdf8"), C("#0ea5e9")];

  // keyframe patterns: positions + colors per phase
  const P = 4; // hero, engines, cross, ignite (deploy reuses hero pose)
  const pos = Array.from({ length: P }, () => new Float32Array(COUNT * 3));
  const col = Array.from({ length: P }, () => new Float32Array(COUNT * 3));
  const put = (arr, i, x, y, z) => {
    arr[i * 3] = x;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = z;
  };
  const tint = (arr, i, c) => {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  };

  let i = 0;
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++)
      for (let z = 0; z < N; z++, i++) {
        const cx = (x - (N - 1) / 2) * CELL,
          cy = (y - (N - 1) / 2) * CELL,
          cz = (z - (N - 1) / 2) * CELL;
        // phase 0 — assembled grass block
        put(pos[0], i, cx, cy, cz);
        const top = y === N - 1;
        const base = top ? TOP[i % TOP.length] : DIRT[(i * 7) % DIRT.length];
        const jit = base.clone().multiplyScalar(0.92 + rnd(i) * 0.16);
        tint(col[0], i, jit);

        // phase 1 — five engine clusters on a ring (reads from any Y rotation)
        const k = i % 5;
        const ci = Math.floor(i / 5);
        const ang = (k / 5) * Math.PI * 2;
        // wider ring + tighter jitter so the 5 clusters read as distinct
        // towers instead of one blob (and never drift into the heading text)
        put(
          pos[1],
          i,
          Math.cos(ang) * 2.2 + (rnd(i + 9) - 0.5) * 0.28,
          ((ci % 4) - 1.5) * 0.45 + (rnd(i + 3) - 0.5) * 0.22,
          Math.sin(ang) * 2.2 + (rnd(i + 5) - 0.5) * 0.28,
        );
        tint(col[1], i, ENGINE[k].clone().multiplyScalar(0.8 + rnd(i + 2) * 0.3));

        // phase 2 — twin blocks: Java (natural) | Bedrock (cyan)
        const right = i >= COUNT / 2;
        const li = i % (COUNT / 2);
        const gx = li % 3,
          gy = Math.floor(li / 3) % 3,
          gz = Math.floor(li / 9);
        put(
          pos[2],
          i,
          (right ? 1.4 : -1.4) + (gx - 1) * CELL,
          (right ? 0.6 : -0.6) + (gy - 1) * CELL + (gz > 2 ? CELL : 0),
          (Math.min(gz, 2) - 1) * CELL,
        );
        tint(col[2], i, right ? BEDROCK[i % 4].clone().multiplyScalar(0.85 + rnd(i) * 0.25) : jit);

        // phase 3 — reassembled, running hot (amber ignition)
        put(pos[3], i, cx, cy, cz);
        tint(col[3], i, jit.clone().lerp(C("#f59e0b"), top ? 0.15 : 0.45));
      }
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);

  // ---- particle field ----------------------------------------------------
  const isMobile = matchMedia("(max-width: 768px)").matches;
  const PN = isMobile ? 110 : 260;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(PN * 3);
  const pCol = new Float32Array(PN * 3);
  const pSpd = new Float32Array(PN);
  for (let j = 0; j < PN; j++) {
    pPos[j * 3] = (Math.random() - 0.5) * 16;
    pPos[j * 3 + 1] = (Math.random() - 0.5) * 10;
    pPos[j * 3 + 2] = -2 - Math.random() * 4;
    const c = Math.random() < 0.7 ? C("#34d399") : C("#f59e0b");
    pCol[j * 3] = c.r;
    pCol[j * 3 + 1] = c.g;
    pCol[j * 3 + 2] = c.b;
    pSpd[j] = 0.1 + Math.random() * 0.35;
  }
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  const points = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({
      size: 0.045,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  scene.add(points);

  // ---- scroll choreography ----------------------------------------------
  // segment s ∈ [0..4]: 0 hero, 1 engines, 2 cross, 3 deploy(=hero pose), 4 cta
  const anchors = ["s-hero", "s-engines", "s-cross", "s-deploy", "s-cta"].map(
    (id) => document.getElementById(id),
  );
  const PATTERN = [0, 1, 2, 0, 3]; // pattern per segment
  let seg = 0,
    segT = 0,
    scrollProg = 0;
  const mids = [];
  function measure() {
    for (let a = 0; a < anchors.length; a++) {
      const el = anchors[a];
      const r = el ? el.getBoundingClientRect() : { top: 0, height: 0 };
      mids[a] = r.top + scrollY + r.height * 0.5;
    }
  }
  function updateScroll() {
    const view = scrollY + innerHeight * 0.5;
    let a = 0;
    while (a < mids.length - 2 && view > mids[a + 1]) a++;
    const span = Math.max(1, mids[a + 1] - mids[a]);
    seg = a;
    segT = Math.min(1, Math.max(0, (view - mids[a]) / span));
    segT = segT * segT * (3 - 2 * segT); // smoothstep
    const total = Math.max(1, mids[mids.length - 1] - mids[0]);
    scrollProg = Math.min(1, Math.max(0, (view - mids[0]) / total));
  }

  // per-segment group offsets (fractions of visible half-width)
  const XOFF = [0.5, -0.38, 0.35, -0.42, 0];
  const YOFF = [0, 0.25, 0.3, 0, 1.45]; // cta raised so grass top clears the glass band
  const SCALE = [1, 0.72, 0.8, 0.9, 1.02];
  const rtl = () => document.documentElement.getAttribute("dir") === "rtl";

  // ---- interaction -------------------------------------------------------
  let mx = 0,
    my = 0;
  addEventListener("pointermove", (e) => {
    mx = (e.clientX / innerWidth) * 2 - 1;
    my = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  const burst = new Float32Array(COUNT * 3);
  const burstVel = new Float32Array(COUNT * 3);
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  addEventListener("pointerdown", (e) => {
    if (reduced) return;
    if (e.target.closest("a,button,input,select,textarea,label,summary")) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.intersectObject(mesh).length) return;
    for (let j = 0; j < COUNT; j++) {
      const a = Math.random() * Math.PI * 2,
        b = Math.random() * Math.PI - Math.PI / 2,
        v = 0.10 + Math.random() * 0.22;
      burstVel[j * 3] += Math.cos(a) * Math.cos(b) * v;
      burstVel[j * 3 + 1] += Math.sin(b) * v + 0.05;
      burstVel[j * 3 + 2] += Math.sin(a) * Math.cos(b) * v;
    }
    spinKick = 0.12;
  });
  let spinKick = 0;

  // ---- render loop -------------------------------------------------------
  const dummy = new THREE.Object3D();
  const cur = new Float32Array(COUNT * 3); // eased positions
  cur.set(pos[0]);
  const cc = new THREE.Color();

  function resize() {
    const w = innerWidth,
      h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    measure();
    updateScroll();
  }

  let raf = 0,
    t0 = performance.now();
  function frame(now) {
    raf = 0;
    const t = (now - t0) / 1000;
    updateScroll();

    const pa = PATTERN[seg],
      pb = PATTERN[Math.min(seg + 1, PATTERN.length - 1)];
    const A = pos[pa], B = pos[pb], CA = col[pa], CB = col[pb];
    const igniteBlend =
      (pa === 3 ? 1 - segT : 0) + (pb === 3 ? segT : 0);

    for (let j = 0; j < COUNT; j++) {
      for (let ax = 0; ax < 3; ax++) {
        const q = j * 3 + ax;
        const target = A[q] + (B[q] - A[q]) * segT;
        burstVel[q] *= 0.92;
        burst[q] = (burst[q] + burstVel[q]) * 0.94;
        cur[q] += (target - cur[q]) * 0.09;
        dummy.position.setComponent(ax, cur[q] + burst[q]);
      }
      const s = 1 + 0.04 * Math.sin(t * 2 + j) * igniteBlend;
      dummy.scale.setScalar(s);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(j, dummy.matrix);
      cc.setRGB(
        CA[j * 3] + (CB[j * 3] - CA[j * 3]) * segT,
        CA[j * 3 + 1] + (CB[j * 3 + 1] - CA[j * 3 + 1]) * segT,
        CA[j * 3 + 2] + (CB[j * 3 + 2] - CA[j * 3 + 2]) * segT,
      );
      mesh.setColorAt(j, cc);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;

    // group placement
    const halfW = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect;
    const mirror = rtl() ? -1 : 1;
    const gx = (XOFF[seg] + (XOFF[Math.min(seg + 1, 4)] - XOFF[seg]) * segT) * halfW * mirror;
    const gy = YOFF[seg] + (YOFF[Math.min(seg + 1, 4)] - YOFF[seg]) * segT;
    const gs = (SCALE[seg] + (SCALE[Math.min(seg + 1, 4)] - SCALE[seg]) * segT) * (isMobile ? 0.62 : 1);
    group.position.x += (gx * (isMobile ? 0 : 1) - group.position.x) * 0.08;
    group.position.y += ((isMobile ? gy + 2.3 : gy) - group.position.y) * 0.08;
    group.scale.setScalar(group.scale.x + (gs - group.scale.x) * 0.08);

    spinKick *= 0.95;
    group.rotation.y = t * 0.22 + scrollProg * Math.PI * 1.2 + mx * 0.22 + spinKick * 10;
    group.rotation.x = 0.12 + my * 0.12;

    ember.position.copy(group.position);
    ember.intensity = 0.25 + igniteBlend * 2.6;
    rim.intensity = 1.4 - igniteBlend * 0.6;

    // particle drift
    const pp = pGeo.attributes.position.array;
    for (let j = 0; j < PN; j++) {
      pp[j * 3 + 1] += pSpd[j] * 0.006;
      if (pp[j * 3 + 1] > 5.5) pp[j * 3 + 1] = -5.5;
    }
    pGeo.attributes.position.needsUpdate = true;
    points.rotation.y = scrollProg * 0.4;

    renderer.render(scene, camera);
    if (!reduced && !document.hidden) raf = requestAnimationFrame(frame);
  }

  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  document.addEventListener("visibilitychange", kick);
  addEventListener("resize", resize, { passive: true });
  if (reduced) {
    // static: render on scroll only, one frame at a time
    addEventListener("scroll", kick, { passive: true });
  }
  // re-measure once fonts/images settle layout
  addEventListener("load", () => {
    measure();
    updateScroll();
  });
  resize();
  kick();
})();
