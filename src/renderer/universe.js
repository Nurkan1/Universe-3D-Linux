// 3D universe renderer: shows every desktop app as a glowing "planet"
// arranged in selectable layouts (galaxy / sphere / rings / grid).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as sfx from './sfx.js';
import { universe } from './tauri-bridge.js';

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05060f, 0.0035);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 60, 170);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 30;
controls.maxDistance = 600;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;

scene.add(new THREE.AmbientLight(0x8890ff, 0.7));
const sun = new THREE.PointLight(0xfff3d0, 2.2, 0, 1.4);
scene.add(sun);

// Deep-space gradient background plane (drawn behind everything)
scene.background = new THREE.Color(0x05060f);

// ---------------------------------------------------------------------------
// Visual settings: tunable from the in-app Settings panel, persisted in prefs
// ---------------------------------------------------------------------------
const SETTINGS_DEFAULTS = {
  bloomStrength: 0.45,
  bloomRadius: 0.4,
  bloomThreshold: 0.4,
  sunGlow: 0.6,
  planetGlow: 0.8,
  starBrightness: 0.55,
  nebulaOpacity: 0.55,
  rotateSpeed: 0.35,
  warpSpeed: 1.6,
  sfxVolume: 0.5,
};
let settings = { ...SETTINGS_DEFAULTS };

// Post-processing: real bloom for the premium glow look
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  settings.bloomStrength, settings.bloomRadius, settings.bloomThreshold,
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Starfield + nebula dust
// ---------------------------------------------------------------------------
function makeStarfield(count, spread, size, color) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) positions[i] = (Math.random() - 0.5) * spread;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color, size, sizeAttenuation: true, transparent: true, opacity: 0.8,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}
const starLayers = [
  makeStarfield(3500, 1400, 1.2, 0xffffff),
  makeStarfield(1200, 1000, 2.2, 0x7c8cff),
  makeStarfield(800, 900, 1.8, 0x5eead4),
];
for (const layer of starLayers) scene.add(layer);

// Soft volumetric-looking nebulas (big additive gradient sprites)
function makeNebula(color, size, pos) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  const col = new THREE.Color(color);
  g.addColorStop(0, `rgba(${col.r * 255 | 0}, ${col.g * 255 | 0}, ${col.b * 255 | 0}, 0.16)`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  sp.scale.set(size, size, 1);
  sp.position.copy(pos);
  scene.add(sp);
  return sp;
}
const nebulas = [
  makeNebula(0x7c8cff, 420, new THREE.Vector3(-220, 60, -260)),
  makeNebula(0xf472b6, 360, new THREE.Vector3(260, -40, -200)),
  makeNebula(0x5eead4, 300, new THREE.Vector3(60, 140, -320)),
];

// Central "sun" core with glow sprite
const core = new THREE.Mesh(
  new THREE.SphereGeometry(6, 48, 48),
  new THREE.MeshBasicMaterial({ color: 0xffe9b0 }),
);
scene.add(core);

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255, 235, 180, 0.9)');
  g.addColorStop(0.3, 'rgba(255, 200, 120, 0.35)');
  g.addColorStop(1, 'rgba(255, 200, 120, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
const glow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(), transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending,
}));
glow.scale.set(60, 60, 1);
scene.add(glow);

// ---------------------------------------------------------------------------
// App planets
// ---------------------------------------------------------------------------
const PALETTE = [0x7c8cff, 0x5eead4, 0xf472b6, 0xfbbf24, 0x60a5fa, 0xa78bfa, 0x34d399, 0xfb7185];
const planetGroup = new THREE.Group();
scene.add(planetGroup);

const textureLoader = new THREE.TextureLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-10, -10);

let allApps = [];
let planets = []; // { mesh, label, ring, halo, app, target:Vector3, baseScale }
let hovered = null;
let focused = null; // keyboard-selected planet
let visibleSorted = []; // visible planets in layout order (for keyboard nav)
let currentLayout = 'focus';
let showHidden = true;
let favOnly = false;
let categoryFilter = ''; // '' = all categories
let query = '';
let warp = null; // { planet, t } active launch animation
let sunMode = 'normal'; // 'normal' | 'absorbing' | 'absorbed' (black-hole toggle)
const SUN_CENTER = new THREE.Vector3(0, 0, 0);
// Where the sun parks in the focus layout: behind and below the front grid,
// so it lights the scene without being drawn over the readable rows.
const FOCUS_SUN_POS = new THREE.Vector3(0, -62, -190);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
let sunScale = 1; // eased visual scale of the sun while it holds the planets

// Persisted preferences: favorites pin apps near the sun, recents come next
let prefs = { favorites: [], recents: [], launchCounts: {}, cmdHistory: [] };
const isFav = (app) => prefs.favorites.includes(app.id);

// ---------------------------------------------------------------------------
// Fuzzy matching: a query matches when its characters appear in order (not
// necessarily adjacent), so "gimp" finds "GNU Image Manipulation Program".
// Returns a score (lower is better) or -1 when there is no match at all.
// ---------------------------------------------------------------------------
function fuzzyScore(text, q) {
  if (!q) return 0;
  const hay = text.toLowerCase();
  // A straight substring hit is always the strongest match; rank it by how
  // early it appears so "files" beats "Recent Files" for a leading match.
  const direct = hay.indexOf(q);
  if (direct !== -1) return direct;

  // Subsequence walk. Gaps between matched characters cost score, so tightly
  // packed matches (an acronym like "gimp") outrank scattered ones.
  let ti = 0;
  let gaps = 0;
  let lastHit = -1;
  for (const ch of q) {
    const hit = hay.indexOf(ch, ti);
    if (hit === -1) return -1;
    if (lastHit !== -1) gaps += hit - lastHit - 1;
    lastHit = hit;
    ti = hit + 1;
  }
  // Offset past every substring score so direct hits always win.
  return 1000 + gaps;
}

/** Best (lowest) fuzzy score across an app's searchable fields, or -1. */
function appScore(app, q) {
  if (!q) return 0;
  const fields = [app.name, app.comment, app.categories.join(' ')];
  let best = -1;
  for (let i = 0; i < fields.length; i++) {
    const score = fuzzyScore(fields[i] || '', q);
    // Later fields are weaker signals than the name itself.
    if (score !== -1) {
      const weighted = score + i * 5000;
      if (best === -1 || weighted < best) best = weighted;
    }
  }
  return best;
}

async function toggleFavorite(p) {
  const id = p.app.id;
  const adding = !isFav(p.app);
  sfx.playFavorite(adding);
  prefs.favorites = adding
    ? [...prefs.favorites, id]
    : prefs.favorites.filter((f) => f !== id);
  p.halo.visible = isFav(p.app);
  await universe.setPrefs(prefs);
  applyLayout();
  updateTooltip();
}

async function recordRecent(app) {
  prefs.recents = [app.id, ...prefs.recents.filter((r) => r !== app.id)].slice(0, 12);
  prefs.launchCounts = prefs.launchCounts || {};
  prefs.launchCounts[app.id] = (prefs.launchCounts[app.id] || 0) + 1;
  await universe.setPrefs(prefs);
}

/** Golden halo sprite shown around favorite planets. */
function makeHaloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 30, 64, 64, 64);
  g.addColorStop(0, 'rgba(255, 200, 80, 0)');
  g.addColorStop(0.7, 'rgba(255, 200, 80, 0.55)');
  g.addColorStop(1, 'rgba(255, 200, 80, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const haloTexture = makeHaloTexture();

/** Push the current settings values into every affected scene object. */
function applySettings() {
  bloomPass.strength = settings.bloomStrength;
  bloomPass.radius = settings.bloomRadius;
  bloomPass.threshold = settings.bloomThreshold;
  controls.autoRotateSpeed = settings.rotateSpeed;
  if (currentLayout === 'focus') controls.autoRotate = false;
  for (const layer of starLayers) layer.material.opacity = settings.starBrightness;
  for (const n of nebulas) n.material.opacity = settings.nebulaOpacity;
  for (const p of planets) {
    p.mesh.material.emissiveIntensity = p.mesh.userData.baseEmissive * settings.planetGlow;
  }
  sfx.setVolume(settings.sfxVolume);
}

/** Round-rect label sprite showing the app icon + name. */
async function makeLabelSprite(app) {
  const W = 256, H = 96;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Glass pill background
  ctx.fillStyle = 'rgba(10, 14, 30, 0.72)';
  ctx.strokeStyle = 'rgba(124, 140, 255, 0.5)';
  ctx.lineWidth = 3;
  const r = 28;
  ctx.beginPath();
  ctx.roundRect(4, 4, W - 8, H - 8, r);
  ctx.fill();
  ctx.stroke();

  // Icon (if resolvable)
  if (app.icon) {
    const dataUrl = await universe.iconData(app.icon);
    if (dataUrl) {
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
        ctx.drawImage(img, 16, 18, 60, 60);
      } catch { /* broken icon: skip */ }
    }
  }

  // Name (truncated)
  ctx.fillStyle = '#e6e9ff';
  ctx.font = '600 26px Inter, Ubuntu, sans-serif';
  let name = app.name;
  while (ctx.measureText(name).width > W - 110 && name.length > 3) name = name.slice(0, -1);
  if (name !== app.name) name += '…';
  ctx.fillText(name, 90, H / 2 + 9);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  sprite.scale.set(13, 13 * (H / W), 1);
  return sprite;
}

/** Create a planet (sphere + ring + label) for one app. */
async function makePlanet(app, index) {
  const color = PALETTE[index % PALETTE.length];
  const radius = 2.2 + (app.name.length % 3) * 0.35;

  const baseEmissive = app.noDisplay ? 0.55 : 0.25;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 32),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: baseEmissive * settings.planetGlow,
      roughness: 0.35,
      metalness: 0.4,
      transparent: app.noDisplay,
      opacity: app.noDisplay ? 0.92 : 1,
    }),
  );
  mesh.userData.app = app;
  mesh.userData.baseEmissive = baseEmissive;

  // Hidden apps get a thin ring so they are visually distinct
  let ring = null;
  if (app.noDisplay) {
    ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.7, 0.12, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.7 }),
    );
    ring.rotation.x = Math.PI / 2.4;
    mesh.add(ring);
  }

  const label = await makeLabelSprite(app);
  label.position.y = radius + 3.2;
  mesh.add(label);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(radius * 4.2);
  halo.visible = isFav(app);
  mesh.add(halo);

  planetGroup.add(mesh);
  return { mesh, label, ring, halo, app, target: new THREE.Vector3(), baseScale: 1 };
}

// ---------------------------------------------------------------------------
// Layouts: compute a target position per visible planet
// ---------------------------------------------------------------------------
const LAYOUTS = {
  /** Spiral galaxy: apps along 4 arms. */
  galaxy(items) {
    const arms = 4;
    items.forEach((p, i) => {
      const arm = i % arms;
      const t = Math.floor(i / arms) / Math.max(1, Math.ceil(items.length / arms));
      const angle = arm * (Math.PI * 2 / arms) + t * Math.PI * 2.2;
      const radius = 22 + t * 130;
      p.target.set(
        Math.cos(angle) * radius,
        (Math.random() - 0.5) * 0, // keep deterministic: flat-ish handled below
        Math.sin(angle) * radius,
      );
      // Deterministic vertical wobble from index, keeps layout stable
      p.target.y = Math.sin(i * 2.39996) * 7;
    });
  },

  /** Fibonacci sphere: evenly spread on a shell. */
  sphere(items) {
    const R = 28 + items.length * 0.55;
    const golden = Math.PI * (3 - Math.sqrt(5));
    items.forEach((p, i) => {
      const y = 1 - (i / Math.max(1, items.length - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      p.target.set(Math.cos(theta) * r * R, y * R * 0.8, Math.sin(theta) * r * R);
    });
  },

  /** Concentric rings grouped by first category. */
  rings(items) {
    const groups = new Map();
    for (const p of items) {
      const key = p.app.categories[0] || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    let ringIdx = 0;
    for (const members of groups.values()) {
      const R = 30 + ringIdx * 24;
      members.forEach((p, i) => {
        const a = (i / members.length) * Math.PI * 2;
        p.target.set(Math.cos(a) * R, Math.sin(ringIdx * 1.7) * 6, Math.sin(a) * R);
      });
      ringIdx++;
    }
  },

  /** Flat grid facing the camera start position. */
  grid(items) {
    const cols = Math.ceil(Math.sqrt(items.length * 1.6));
    const spacing = 16;
    items.forEach((p, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      p.target.set(
        (col - (cols - 1) / 2) * spacing,
        ((Math.ceil(items.length / cols) - 1) / 2 - row) * spacing,
        0,
      );
    });
  },

  /**
   * Focus: depth carries meaning instead of decoration.
   *
   * The other layouts arrange apps by geometry and leave the third axis as an
   * aesthetic. Here Z encodes *relevance*: the apps you actually use sit in a
   * readable grid at the front, and everything else recedes into the
   * background, shrinking and dimming with distance. Viewed head-on it reads
   * as an ordered launcher; the depth is what tells you, at a glance, which
   * of several hundred apps matter.
   *
   * Front tier  : a legible grid, full size, labels readable.
   * Back tiers  : progressively further, smaller and dimmer -- still there,
   *               still clickable, still found by search, just not competing.
   */
  focus(items) {
    // How many apps earn a place in the readable front grid. Kept near 24 so
    // the grid stays scannable at a glance rather than becoming a wall.
    const FRONT_COUNT = Math.min(24, items.length);
    const front = items.slice(0, FRONT_COUNT);
    const back = items.slice(FRONT_COUNT);

    // --- front tier: an ordered, evenly spaced grid facing the camera ---
    const cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(front.length))));
    const rows = Math.ceil(front.length / cols);
    const spacingX = 30;
    const spacingY = 21;
    // Centre the grid vertically: biasing it upward pushed the top row behind
    // the floating top bar. The sun is moved aside instead (see sunOffset).
    front.forEach((p, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      p.target.set(
        (col - (cols - 1) / 2) * spacingX,
        ((rows - 1) / 2 - row) * spacingY - 6,
        // Slight stagger per row so the grid still reads as 3D when orbited,
        // without breaking the flat, readable head-on view.
        row * -1.5,
      );
      p.depthTier = 0;
    });

    // --- back tiers: a wide field receding behind the grid ---
    // Scattered deterministically rather than placed on rings: concentric
    // rings read as spokes pointing at the centre, which drags the eye exactly
    // where it should not go. A hash-based jitter keeps it looking like
    // ambient depth instead of structure.
    const PER_SHELL = 45;
    back.forEach((p, i) => {
      const shell = Math.floor(i / PER_SHELL) + 1;
      const n = i % PER_SHELL;
      // Cheap deterministic pseudo-random in [0,1) from the index.
      const rand = (seed) => {
        const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
        return x - Math.floor(x);
      };
      const spread = 150 + shell * 30;
      p.target.set(
        (rand(1) - 0.5) * spread * 2,
        (rand(2) - 0.5) * spread * 1.1,
        -90 - shell * 40 - rand(3) * 30,
      );
      // Push anything that would land behind the front grid out to the sides,
      // so the readable area stays clear.
      const clearance = 95;
      if (Math.abs(p.target.x) < clearance && Math.abs(p.target.y - 20) < clearance) {
        const push = p.target.x >= 0 ? clearance : -clearance;
        p.target.x = push + (rand(4) - 0.5) * 60;
      }
      p.depthTier = shell;
      void n;
    });
  },
};

/**
 * Size multiplier for a depth tier in the focus layout.
 *
 * Perspective alone is not a strong enough cue at these distances, so the
 * further tiers are also scaled down. The falloff is deliberately gentle after
 * the first step: everything must stay clickable, just clearly secondary.
 */
function depthScale(tier = 0) {
  if (!tier) return 1;
  return Math.max(0.4, 1 - tier * 0.18);
}

/**
 * Fade a planet's material to match its depth tier.
 *
 * Dimming is what makes the front grid read as "the ones that matter" rather
 * than merely "the ones that are nearer". Hovered and focused planets always
 * return to full strength so exploring the background stays comfortable.
 */
function applyDepthFade(p, tierScale) {
  const highlighted = hovered === p || focused === p;
  const target = currentLayout === 'focus' && !highlighted
    ? 0.25 + 0.75 * tierScale
    : 1;
  const mat = p.mesh.material;
  // Hidden apps carry their own translucency; never make them more opaque.
  const ceiling = p.app.noDisplay ? 0.92 : 1;
  mat.opacity = Math.min(ceiling, target);
  mat.transparent = mat.opacity < 1 || p.app.noDisplay;
  mat.emissiveIntensity = p.mesh.userData.baseEmissive * settings.planetGlow * target;
  if (p.label) p.label.material.opacity = target;
}

/**
 * Sort key: favorites innermost, then frequently/recently used, then the rest.
 *
 * Frequency and recency are blended so an app you open every day keeps its
 * inner orbit even when you have not touched it today, while something you
 * just launched still moves inward. Lower sorts closer to the sun.
 */
function sortRank(p) {
  if (isFav(p.app)) return -1000 + prefs.favorites.indexOf(p.app.id);
  const recentIdx = prefs.recents.indexOf(p.app.id);
  const count = prefs.launchCounts?.[p.app.id] || 0;
  if (recentIdx === -1 && count === 0) return coldStartRank(p.app);
  // Recency contributes its position (0 = most recent); frequency pulls
  // inward with diminishing returns so one busy app cannot dominate.
  const recency = recentIdx === -1 ? 20 : recentIdx;
  const frequency = Math.min(15, Math.log2(count + 1) * 4);
  return -100 + recency - frequency;
}

// Categories that tend to hold the applications people actually open, versus
// the ones that hold configuration dialogs and helper entries.
const PROMINENT_CATEGORIES = new Set([
  'WebBrowser', 'TerminalEmulator', 'TextEditor', 'IDE', 'Development',
  'FileManager', 'AudioVideo', 'Player', 'Graphics', 'Office', 'Game',
  'Network', 'Email', 'InstantMessaging', 'Security',
]);
const BACKGROUND_CATEGORIES = new Set([
  'Settings', 'System', 'Accessibility', 'HardwareSettings', 'DesktopSettings',
  'PackageManager', 'Documentation', 'Core',
]);

/**
 * Ordering for apps with no usage history yet.
 *
 * Without this the first run has nothing to rank by, so everything ties at
 * zero and falls back to alphabetical -- which fills the front grid with
 * whatever starts with "A" and makes the layout's whole premise look false.
 * These are weak signals read from the desktop entry, only ever used until
 * real usage data exists.
 */
function coldStartRank(app) {
  let score = 0;
  // Hidden entries are helpers and almost never what someone wants up front.
  if (app.noDisplay) score += 40;
  // Terminal programs are usually invoked from a shell, not a launcher.
  if (app.terminal) score += 12;
  if (app.categories.some((c) => BACKGROUND_CATEGORIES.has(c))) score += 18;
  if (app.categories.some((c) => PROMINENT_CATEGORIES.has(c))) score -= 22;
  // A description suggests a real, packaged application rather than a stub.
  if (app.comment) score -= 4;
  // Entries whose name is a bare command tend to be CLI tools shipped with a
  // desktop file; ones with spaces and capitals are usually GUI apps.
  if (/^[a-z0-9._-]+$/.test(app.name)) score += 8;
  return score;
}

/** Re-apply visibility filter + layout targets. */
function applyLayout() {
  // Any relayout (search, filters, layout switch) releases the black hole
  if (sunMode !== 'normal') sunMode = 'normal';
  const q = query.toLowerCase();
  const visible = [];
  for (const p of planets) {
    const score = appScore(p.app, q);
    p.searchScore = score;
    const matches = score !== -1;
    const allowed = showHidden || !p.app.noDisplay;
    const favOk = !favOnly || isFav(p.app);
    const catOk = !categoryFilter || p.app.categories.includes(categoryFilter);
    p.mesh.visible = matches && allowed && favOk && catOk;
    if (p.mesh.visible) visible.push(p);
  }
  // While searching, match quality leads; otherwise use the favorites/usage
  // ranking so the inner orbits stay meaningful.
  visible.sort((a, b) => (
    q
      ? a.searchScore - b.searchScore || sortRank(a) - sortRank(b)
      : sortRank(a) - sortRank(b)
  ) || a.app.name.localeCompare(b.app.name));
  visibleSorted = visible;
  if (focused && !focused.mesh.visible) focused = null;
  LAYOUTS[currentLayout](visible);
}

// ---------------------------------------------------------------------------
// Warp launch: camera dives toward the planet, bloom flares, then the app
// starts and the window hides (daemon keeps it resident for instant reopen).
// ---------------------------------------------------------------------------
const HOME_POS = camera.position.clone();

/** Double-click on the sun: absorb every planet into it, or expel them back. */
function toggleSun() {
  // The absorb effect belongs to the orbital layouts. In focus the sun sits
  // far behind the grid, so pulling the apps into it would drag them out of
  // view for a purely decorative animation.
  if (currentLayout === 'focus') return;
  if (sunMode === 'normal') {
    sfx.playAbsorb();
    sunMode = 'absorbing';
    focused = null;
  } else if (sunMode === 'absorbed') {
    sfx.playExpel();
    expelPlanets();
  }
}

function expelPlanets() {
  applyLayout(); // resets sunMode and recomputes targets/visibility
  for (const p of planets) {
    if (!p.mesh.visible) continue;
    // Burst out of the core from a tiny random offset, then fly to targets
    p.mesh.position.set(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 6,
    );
    p.baseScale = 0.05;
    p.mesh.scale.setScalar(0.05);
  }
}

/**
 * Launch an app and stay visible if it fails.
 *
 * The window used to hide the instant the launch was requested, without
 * waiting for the result, so an app that never started failed in complete
 * silence -- the launcher simply vanished and nothing appeared.
 */
async function launchAndReport(app) {
  try {
    await universe.launchApp(app);
    universe.closeWindow(); // hides; daemon keeps it warm
  } catch (err) {
    // Stay on screen: the message is the only clue the user gets.
    showToast(`${app.name} failed to start: ${err}`);
  }
}

function launchWithWarp(p) {
  if (warp) return;
  sfx.playWarp();
  warp = { p, t: 0, from: camera.position.clone() };
  recordRecent(p.app);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
const tooltip = document.getElementById('tooltip');
const tooltipIcon = document.getElementById('tooltip-icon');
const tooltipName = document.getElementById('tooltip-name');
const tooltipComment = document.getElementById('tooltip-comment');

canvas.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  tooltip.style.left = `${e.clientX + 18}px`;
  tooltip.style.top = `${e.clientY + 18}px`;
});

let downPos = null;
canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', async (e) => {
  // Treat as click only if the pointer barely moved (not an orbit drag)
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 6 || !hovered) return;
  launchWithWarp(hovered);
});

// Double-click on the sun toggles the black-hole absorb/expel effect
canvas.addEventListener('dblclick', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.intersectObject(core, false).length) toggleSun();
});

// Right-click toggles favorite
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (hovered) toggleFavorite(hovered);
});

async function updateTooltip() {
  if (!hovered) { tooltip.classList.add('hidden'); return; }
  const app = hovered.mesh.userData.app;
  const flags = [isFav(app) ? '★ favorite' : '', app.noDisplay ? 'hidden' : ''].filter(Boolean);
  tooltipName.textContent = app.name + (flags.length ? `  · ${flags.join(' · ')}` : '');
  tooltipComment.textContent = (app.comment || app.categories.join(' · '))
    + '  ·  right-click: favorite';
  if (app.icon) {
    const data = await universe.iconData(app.icon);
    if (data) { tooltipIcon.src = data; tooltipIcon.style.display = ''; }
    else tooltipIcon.style.display = 'none';
  } else {
    tooltipIcon.style.display = 'none';
  }
  tooltip.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
document.getElementById('btn-close').addEventListener('click', () => universe.closeWindow());
document.getElementById('btn-min').addEventListener('click', () => universe.minimizeWindow());

// Maximize/restore. The double-click on the bar competes with dragging -- a
// slight movement between clicks makes the gesture register as a drag instead,
// so the button is the reliable way to do it and the gesture is a shortcut.
const btnMax = document.getElementById('btn-max');
async function toggleMaximize() {
  await universe.toggleMaximize();
  // Reflect the new state in the glyph: □ offers "maximize", ❐ offers
  // "restore down".
  const maximized = await universe.isMaximized();
  btnMax.textContent = maximized ? '❐' : '□';
  btnMax.title = maximized ? 'Restore down' : 'Maximize';
}
btnMax.addEventListener('click', () => {
  sfx.playClick();
  toggleMaximize();
});

document.getElementById('topbar').addEventListener('dblclick', (e) => {
  // Ignore double-clicks that land on a control rather than the bar itself.
  if (e.target.closest('input, button, label, select')) return;
  toggleMaximize();
});

// Send the window to the next monitor. Dragging works too, but on a multi-head
// setup this is quicker than un-maximize -> drag -> re-maximize.
async function moveToNextMonitor() {
  const moved = await universe.nextMonitor();
  if (!moved) showToast('Only one monitor detected');
}

const searchInput = document.getElementById('search');
searchInput.addEventListener('input', () => {
  query = searchInput.value.trim();
  applyLayout();
  // Fly the camera to the best match while typing
  focused = query && visibleSorted.length ? visibleSorted[0] : null;
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && focused) {
    e.preventDefault();
    launchWithWarp(focused);
  }
});

function cycleFocus(dir) {
  if (!visibleSorted.length) return;
  const idx = focused ? visibleSorted.indexOf(focused) : -1;
  focused = visibleSorted[(idx + dir + visibleSorted.length) % visibleSorted.length];
}

window.addEventListener('keydown', (e) => {
  const typing = document.activeElement === searchInput
    || document.activeElement === cmdInput;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (e.key === '`' && !typing) {
    e.preventDefault();
    toggleCmdPanel();
    return;
  }
  if (e.key === 'Escape') {
    if (!actionsMenu.classList.contains('hidden')) {
      hideActionsMenu();
      return;
    }
    if (typing && searchInput.value) {
      searchInput.value = '';
      query = '';
      focused = null;
      applyLayout();
    } else if (typing) {
      searchInput.blur();
    } else {
      universe.closeWindow();
    }
    return;
  }
  if (typing) return;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault();
      cycleFocus(1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      cycleFocus(-1);
      break;
    case 'Enter':
      if (focused) launchWithWarp(focused);
      break;
    case 'f':
      if (focused) toggleFavorite(focused);
      break;
    case 'a': {
      const target = focused || hovered;
      if (target) showActionsMenu(target);
      break;
    }
    case 'M':
      // Shift+M: move the window to the next screen.
      if (e.shiftKey) {
        e.preventDefault();
        moveToNextMonitor();
      }
      break;
    default:
  }
});

/**
 * Move the camera to the vantage a layout is designed to be seen from.
 *
 * Focus is the one layout that only works head-on: its whole premise is that
 * the front grid reads as an ordered launcher, which an orbiting camera
 * destroys. So entering it squares the camera up and stops the idle spin,
 * while leaving it restores the default orbit view.
 */
function applyLayoutViewpoint(layout) {
  if (layout === 'focus') {
    controls.autoRotate = false;
    controls.target.set(0, 0, 0);
    camera.position.set(0, 0, 150);
  } else {
    controls.autoRotate = true;
    camera.position.copy(HOME_POS);
    controls.target.set(0, 0, 0);
  }
  controls.update();
}

document.querySelectorAll('#layouts button').forEach((btn) => {
  btn.addEventListener('click', () => {
    sfx.playClick();
    document.querySelectorAll('#layouts button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentLayout = btn.dataset.layout;
    applyLayoutViewpoint(currentLayout);
    applyLayout();
  });
});

document.getElementById('show-hidden').addEventListener('change', (e) => {
  showHidden = e.target.checked;
  applyLayout();
});

// Favorites-only filter
document.getElementById('fav-only').addEventListener('change', (e) => {
  favOnly = e.target.checked;
  applyLayout();
});

// Category filter dropdown — populated from scanned apps in boot()
const categorySelect = document.getElementById('category-filter');
function populateCategories() {
  const counts = new Map();
  for (const app of allApps) {
    for (const cat of app.categories) counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cat, n] of sorted) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = `${cat} (${n})`;
    categorySelect.appendChild(opt);
  }
}
categorySelect.addEventListener('change', () => {
  categoryFilter = categorySelect.value;
  applyLayout();
});

// ---------------------------------------------------------------------------
// Themes: swap the color palette + CSS accent variables
// ---------------------------------------------------------------------------
const THEMES = {
  cosmic:  { palette: [0x7c8cff, 0x5eead4, 0xf472b6, 0xfbbf24, 0x60a5fa, 0xa78bfa, 0x34d399, 0xfb7185], accent: '#7c8cff', accent2: '#5eead4', bg: 0x05060f, fog: 0x05060f },
  emerald: { palette: [0x34d399, 0x10b981, 0x6ee7b7, 0xa7f3d0, 0x059669, 0x2dd4bf, 0x14b8a6, 0x5eead4], accent: '#34d399', accent2: '#a7f3d0', bg: 0x031310, fog: 0x031310 },
  sunset:  { palette: [0xfb7185, 0xfbbf24, 0xf97316, 0xef4444, 0xf472b6, 0xfacc15, 0xfb923c, 0xe879f9], accent: '#fb7185', accent2: '#fbbf24', bg: 0x14060a, fog: 0x14060a },
  mono:    { palette: [0xe5e7eb, 0xcbd5e1, 0x94a3b8, 0xf8fafc, 0xd1d5db, 0xa3a3a3, 0xe2e8f0, 0xb0b8c4], accent: '#cbd5e1', accent2: '#f8fafc', bg: 0x0a0a0c, fog: 0x0a0a0c },
  matrix:  { palette: [0x22c55e, 0x16a34a, 0x4ade80, 0x86efac, 0x15803d, 0x65a30d, 0x84cc16, 0xbbf7d0], accent: '#22c55e', accent2: '#86efac', bg: 0x020805, fog: 0x020805 },
};
let currentTheme = 'cosmic';

function applyTheme(name) {
  const theme = THEMES[name] || THEMES.cosmic;
  currentTheme = name;
  // Update CSS accent variables for the glass UI
  document.documentElement.style.setProperty('--accent', theme.accent);
  document.documentElement.style.setProperty('--accent-2', theme.accent2);
  // Scene background + fog
  scene.background = new THREE.Color(theme.bg);
  scene.fog.color.setHex(theme.fog);
  // Recolor every planet from the new palette
  PALETTE.length = 0;
  PALETTE.push(...theme.palette);
  planets.forEach((p, i) => {
    const color = PALETTE[i % PALETTE.length];
    p.mesh.material.color.setHex(color);
    p.mesh.material.emissive.setHex(color);
  });
  document.querySelectorAll('#theme-picker button').forEach((b) =>
    b.classList.toggle('active', b.dataset.theme === name));
}

document.querySelectorAll('#theme-picker button').forEach((btn) => {
  btn.addEventListener('click', () => {
    sfx.playClick();
    applyTheme(btn.dataset.theme);
    prefs.theme = currentTheme;
    universe.setPrefs(prefs);
  });
});

// ---------------------------------------------------------------------------
// System monitor: poll the Rust backend and paint live bars
// ---------------------------------------------------------------------------
const monitorPanel = document.getElementById('monitor-panel');
const monCpuFill = document.getElementById('mon-cpu-fill');
const monCpuVal = document.getElementById('mon-cpu-val');
const monCores = document.getElementById('mon-cores');
const monMemFill = document.getElementById('mon-mem-fill');
const monMemVal = document.getElementById('mon-mem-val');
const monSwapFill = document.getElementById('mon-swap-fill');
const monSwapVal = document.getElementById('mon-swap-val');
const monRx = document.getElementById('mon-rx');
const monTx = document.getElementById('mon-tx');
const monUptime = document.getElementById('mon-uptime');
const monLoad = document.getElementById('mon-load');
let monitorTimer = null;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function pollMonitor() {
  let s;
  try { s = await universe.systemStats(); } catch { return; }
  monCpuFill.style.width = `${s.cpu.toFixed(0)}%`;
  monCpuVal.textContent = `${s.cpu.toFixed(0)}%`;
  // Per-core mini bars
  if (monCores.childElementCount !== s.cores.length) {
    monCores.innerHTML = '';
    for (let i = 0; i < s.cores.length; i++) {
      const bar = document.createElement('div');
      bar.className = 'core-bar';
      bar.innerHTML = '<div class="core-fill"></div>';
      monCores.appendChild(bar);
    }
  }
  s.cores.forEach((c, i) => {
    const fill = monCores.children[i]?.firstElementChild;
    if (fill) fill.style.height = `${c.toFixed(0)}%`;
  });
  monMemFill.style.width = `${s.mem_percent.toFixed(0)}%`;
  monMemVal.textContent = `${fmtBytes(s.mem_used)} / ${fmtBytes(s.mem_total)}`;
  const swapPct = s.swap_total ? (s.swap_used / s.swap_total) * 100 : 0;
  monSwapFill.style.width = `${swapPct.toFixed(0)}%`;
  monSwapVal.textContent = s.swap_total ? `${fmtBytes(s.swap_used)} / ${fmtBytes(s.swap_total)}` : 'none';
  monRx.textContent = fmtBytes(s.net_rx);
  monTx.textContent = fmtBytes(s.net_tx);
  monUptime.textContent = fmtUptime(s.uptime);
  monLoad.textContent = s.load_one.toFixed(2);
}

document.getElementById('btn-monitor').addEventListener('click', () => {
  sfx.playClick();
  // `toggle` returns whether 'hidden' is now present, i.e. the panel is closed.
  const hidden = monitorPanel.classList.toggle('hidden');
  // Always clear first: a fast double toggle used to leak an interval, leaving
  // two pollers hammering the backend for the rest of the session.
  clearInterval(monitorTimer);
  monitorTimer = null;
  if (!hidden) {
    pollMonitor();
    monitorTimer = setInterval(pollMonitor, 1500);
  }
});

// ---------------------------------------------------------------------------
// Command launcher: run arbitrary commands or open a terminal
// ---------------------------------------------------------------------------
const cmdPanel = document.getElementById('cmd-panel');
const cmdInput = document.getElementById('cmd-input');
const cmdTerminal = document.getElementById('cmd-terminal');
const cmdConfirm = document.getElementById('cmd-confirm');
const cmdConfirmText = document.getElementById('cmd-confirm-text');
const cmdHistoryList = document.getElementById('cmd-history');

const CMD_HISTORY_MAX = 25;
// Where the user currently is when walking history with the arrow keys.
// -1 means "on the live input", 0 is the most recent entry.
let historyPos = -1;
let historyDraft = '';
// The command awaiting confirmation, or null when nothing is pending.
let pendingCommand = null;

function toggleCmdPanel(force) {
  const hide = force === false || (force === undefined && !cmdPanel.classList.contains('hidden'));
  cmdPanel.classList.toggle('hidden', hide);
  cancelPendingCommand();
  if (!hide) {
    cmdInput.value = '';
    historyPos = -1;
    historyDraft = '';
    renderHistory();
    cmdInput.focus();
  }
}

/** Render the recent-command list; clicking an entry loads it into the input. */
function renderHistory() {
  const history = prefs.cmdHistory || [];
  cmdHistoryList.textContent = '';
  cmdHistoryList.classList.toggle('hidden', history.length === 0);
  for (const entry of history.slice(0, 8)) {
    const li = document.createElement('li');
    li.textContent = entry;           // textContent: never interpret as markup
    li.title = 'Click to reuse';
    li.addEventListener('click', () => {
      cmdInput.value = entry;
      cmdInput.focus();
    });
    cmdHistoryList.appendChild(li);
  }
}

/** Step through history with the arrow keys, preserving the half-typed line. */
function navigateHistory(dir) {
  const history = prefs.cmdHistory || [];
  if (!history.length) return;
  if (historyPos === -1 && dir > 0) historyDraft = cmdInput.value;
  const next = historyPos + dir;
  if (next < -1 || next >= history.length) return;
  historyPos = next;
  cmdInput.value = historyPos === -1 ? historyDraft : history[historyPos];
  // Put the caret at the end rather than selecting the recalled text.
  requestAnimationFrame(() => {
    cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
  });
}

async function rememberCommand(cmd) {
  const history = (prefs.cmdHistory || []).filter((c) => c !== cmd);
  prefs.cmdHistory = [cmd, ...history].slice(0, CMD_HISTORY_MAX);
  await universe.setPrefs(prefs);
  renderHistory();
}

function cancelPendingCommand() {
  pendingCommand = null;
  cmdConfirm.classList.add('hidden');
}

/**
 * Ask before running. Handing a string to `sh -c` is irreversible and easy to
 * fire by accident from a text box bound to Enter, so the command is shown
 * back verbatim and only runs on a second, explicit confirmation.
 */
function requestRunCommand() {
  const cmd = cmdInput.value.trim();
  if (!cmd) return;
  pendingCommand = { cmd, inTerminal: cmdTerminal.checked };
  cmdConfirmText.textContent = cmd; // textContent, not innerHTML
  cmdConfirm.classList.remove('hidden');
  document.getElementById('cmd-confirm-yes').focus();
}

async function confirmRunCommand() {
  if (!pendingCommand) return;
  const { cmd, inTerminal } = pendingCommand;
  cancelPendingCommand();
  try {
    await universe.runCommand(cmd, inTerminal);
    await rememberCommand(cmd);
    showToast(`Ran: ${cmd}`);
    toggleCmdPanel(false);
    universe.closeWindow();
  } catch (err) {
    showToast(`Command failed: ${err}`);
  }
}

document.getElementById('btn-terminal').addEventListener('click', () => {
  sfx.playClick();
  toggleCmdPanel();
});
document.getElementById('cmd-run').addEventListener('click', requestRunCommand);
document.getElementById('cmd-confirm-yes').addEventListener('click', confirmRunCommand);
document.getElementById('cmd-confirm-no').addEventListener('click', () => {
  cancelPendingCommand();
  cmdInput.focus();
});
document.getElementById('cmd-open-term').addEventListener('click', async () => {
  await universe.openTerminal();
  toggleCmdPanel(false);
  universe.closeWindow();
});
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    requestRunCommand();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    // First Escape backs out of a pending confirmation, second closes the panel.
    if (pendingCommand) { cancelPendingCommand(); cmdInput.focus(); }
    else toggleCmdPanel(false);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    navigateHistory(1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    navigateHistory(-1);
  }
});

// ---------------------------------------------------------------------------
// Desktop-entry actions: extra launch modes declared by the .desktop file
// (Firefox's "New Private Window", a terminal's "New Window", ...).
// ---------------------------------------------------------------------------
const actionsMenu = document.getElementById('actions-menu');

function hideActionsMenu() {
  actionsMenu.classList.add('hidden');
  actionsMenu.textContent = '';
}

/** Show the actions of the focused/hovered planet next to the screen centre. */
function showActionsMenu(p) {
  const actions = p?.app?.actions || [];
  if (!actions.length) {
    showToast(`${p?.app?.name || 'This app'} has no extra actions`);
    return;
  }
  actionsMenu.textContent = '';

  const title = document.createElement('div');
  title.className = 'actions-title';
  title.textContent = p.app.name;
  actionsMenu.appendChild(title);

  // The plain Exec line, so the default launch is reachable from here too.
  const entries = [{ id: null, name: 'Launch' }, ...actions];
  for (const action of entries) {
    const btn = document.createElement('button');
    btn.textContent = action.name;   // textContent: .desktop data is untrusted
    btn.addEventListener('click', async () => {
      hideActionsMenu();
      try {
        if (action.id === null) {
          launchWithWarp(p);
        } else {
          await universe.launchAction(p.app, action.id);
          recordRecent(p.app);
          universe.closeWindow();
        }
      } catch (err) {
        showToast(`Action failed: ${err}`);
      }
    });
    actionsMenu.appendChild(btn);
  }
  actionsMenu.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Settings panel wiring
// ---------------------------------------------------------------------------
const settingsPanel = document.getElementById('settings-panel');
const settingsBtn = document.getElementById('btn-settings');
settingsBtn.addEventListener('click', () => {
  sfx.playClick();
  settingsPanel.classList.toggle('hidden');
});

const sliders = [...settingsPanel.querySelectorAll('input[type="range"]')];

function syncSliders() {
  for (const input of sliders) {
    input.value = settings[input.dataset.key];
    input.nextElementSibling.textContent = Number(settings[input.dataset.key]).toFixed(2);
  }
}

let saveTimer = null;
function saveSettingsDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    prefs.settings = settings;
    universe.setPrefs(prefs);
  }, 400);
}

for (const input of sliders) {
  input.addEventListener('input', () => {
    settings[input.dataset.key] = Number(input.value);
    input.nextElementSibling.textContent = Number(input.value).toFixed(2);
    applySettings();
    saveSettingsDebounced();
  });
}

document.getElementById('settings-reset').addEventListener('click', () => {
  settings = { ...SETTINGS_DEFAULTS };
  syncSliders();
  applySettings();
  saveSettingsDebounced();
});

// ---------------------------------------------------------------------------
// Toast notifications (used by the command runner). Screen recording was
// removed: MediaRecorder + canvas.captureStream on the WebKitGTK webview relies
// on system GStreamer encoder plugins that are frequently missing or broken,
// and with the release build's `panic = "abort"` a failure in that pipeline
// took down the whole app. Removing it keeps the launcher stable and light.
// ---------------------------------------------------------------------------
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');

function showToast(text) {
  toastText.textContent = text;
  toast.classList.remove('hidden');
}

document.getElementById('toast-close').addEventListener('click', () => {
  toast.classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Responsive chrome: the top bar wraps onto extra rows on a narrow window, so
// the side panels cannot assume a fixed offset. Publish its real height as a
// CSS variable and let the stylesheet position everything from that.
// ---------------------------------------------------------------------------
const topbarEl = document.getElementById('topbar');

function syncTopbarHeight() {
  const bottom = topbarEl.getBoundingClientRect().bottom;
  document.documentElement.style.setProperty('--topbar-bottom', `${Math.round(bottom)}px`);
}

// ResizeObserver catches wrapping caused by content changes (a long category
// name landing in the select) as well as by the window resizing.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(syncTopbarHeight).observe(topbarEl);
}
syncTopbarHeight();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  syncTopbarHeight();
});

// ---------------------------------------------------------------------------
// Boot + render loop
// ---------------------------------------------------------------------------
async function boot() {
  // Merge over the defaults so prefs written by an older build (no launch
  // counts, no command history) still produce a fully-shaped object.
  prefs = { favorites: [], recents: [], launchCounts: {}, cmdHistory: [], ...await universe.getPrefs() };
  prefs.launchCounts = prefs.launchCounts || {};
  prefs.cmdHistory = prefs.cmdHistory || [];
  // Merge saved settings over defaults (ignores stale/unknown keys)
  if (prefs.settings) {
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (typeof prefs.settings[key] === 'number') settings[key] = prefs.settings[key];
    }
  }
  syncSliders();
  applySettings();
  allApps = await universe.scanApps();
  populateCategories();
  // Build planets in small batches so labels (async icons) don't block long
  for (let i = 0; i < allApps.length; i++) {
    planets.push(await makePlanet(allApps[i], i));
    if (i % 12 === 0) applyLayout(); // progressively settle into place
  }
  // Apply saved theme after planets exist so they get recolored
  if (prefs.theme && THEMES[prefs.theme]) applyTheme(prefs.theme);
  // Focus is the default layout and only works head-on, so square the camera
  // up before the first frame rather than starting in the orbit view.
  applyLayoutViewpoint(currentLayout);
  applyLayout();
  // The window starts maximized, so show the restore glyph from the outset.
  try {
    const maximized = await universe.isMaximized();
    btnMax.textContent = maximized ? '❐' : '□';
    btnMax.title = maximized ? 'Restore down' : 'Maximize';
  } catch { /* window controls unavailable: leave the default glyph */ }
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  // Settle the sun first: the absorb vortex and the raycast both read
  // core.position this frame, and the glow sprite has to sit exactly on top of
  // the core. Updating it at the end of the frame instead left the halo a step
  // behind the core, which looked like a second sun drifting away from it.
  // The sun is the centrepiece of the orbital layouts, but in focus it would
  // cover the readable grid, so it eases behind and below it there.
  const sunGoalPos = currentLayout === 'focus' ? FOCUS_SUN_POS : SUN_CENTER;
  core.position.lerp(sunGoalPos, 1 - Math.exp(-3 * dt));
  glow.position.copy(core.position);
  sun.position.copy(core.position);

  // Smoothly move planets to their layout targets + gentle float
  for (const p of planets) {
    if (!p.mesh.visible) continue;
    if (sunMode === 'absorbing') {
      // Vortex: spiral inward faster the closer they get, shrinking away
      // Fall toward wherever the sun actually is: in the focus layout it is
      // parked away from the origin.
      const dist = p.mesh.position.distanceTo(core.position);
      p.mesh.position.lerp(core.position, 1 - Math.exp(-2.2 * dt));
      p.mesh.position.applyAxisAngle(Y_AXIS, dt * (1.2 + 80 / (dist + 8)));
      const s = Math.max(0.04, Math.min(1, dist / 45));
      p.baseScale = s;
      p.mesh.scale.setScalar(s);
      p.mesh.rotation.y += dt * 6;
      if (dist < 2.5) p.mesh.visible = false;
      continue;
    }
    p.mesh.position.lerp(p.target, 1 - Math.exp(-3 * dt));
    p.mesh.position.y += Math.sin(t * 0.8 + p.mesh.id) * 0.012;
    p.mesh.rotation.y += dt * 0.4;
    // Hover/keyboard-focus pulse easing back to 1, scaled by the depth tier so
    // background apps in the focus layout stay visually subordinate.
    const tierScale = currentLayout === 'focus' ? depthScale(p.depthTier) : 1;
    const goal = (hovered === p || focused === p) ? 1.35 : tierScale;
    p.baseScale += (goal - p.baseScale) * Math.min(1, 6 * dt);
    p.mesh.scale.setScalar(p.baseScale);
    applyDepthFade(p, tierScale);
    if (p.ring) p.ring.rotation.z += dt * 0.8;
    if (p.halo.visible) p.halo.material.opacity = 0.7 + Math.sin(t * 2 + p.mesh.id) * 0.25;
  }

  // Absorption complete once every planet has fallen into the core
  if (sunMode === 'absorbing' && !planets.some((p) => p.mesh.visible)) {
    sunMode = 'absorbed';
  }
  // The sun swells while it holds the planets inside
  const sunGoal = sunMode === 'normal' ? 1 : sunMode === 'absorbing' ? 1.25 : 1.7;
  sunScale += (sunGoal - sunScale) * Math.min(1, 3 * dt);
  core.scale.setScalar(sunScale);
  glow.scale.setScalar(60 * sunScale);

  // Keyboard focus: smoothly aim the camera at the selected planet
  if (focused && focused.mesh.visible && !warp) {
    controls.target.lerp(focused.mesh.position, 1 - Math.exp(-4 * dt));
  }

  // Warp launch animation
  if (warp) {
    warp.t += dt * settings.warpSpeed;
    const k = Math.min(1, warp.t);
    const ease = k * k * (3 - 2 * k); // smoothstep
    const dest = warp.p.mesh.position.clone();
    camera.position.lerpVectors(warp.from, dest, ease * 0.92);
    controls.target.lerp(dest, 1 - Math.exp(-8 * dt));
    bloomPass.strength = settings.bloomStrength + ease * 1.8;
    warp.p.mesh.scale.setScalar(1 + ease * 1.5);
    if (k >= 1) {
      const launched = warp.p.app;
      warp = null;
      bloomPass.strength = settings.bloomStrength;
      // Return to the vantage this layout is meant to be seen from, not the
      // orbit default -- otherwise launching once knocks focus out of view.
      applyLayoutViewpoint(currentLayout);
      focused = null;
      launchAndReport(launched);
    }
  }

  core.rotation.y += dt * 0.2;
  glow.material.opacity = settings.sunGlow * (0.85 + Math.sin(t * 1.5) * 0.1)
    * (currentLayout === 'focus' ? 0.5 : 1);

  // Raycast hover detection (planet meshes only, not labels)
  raycaster.setFromCamera(pointer, camera);
  const meshes = planets.filter((p) => p.mesh.visible).map((p) => p.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  const hit = hits.length ? planets.find((p) => p.mesh === hits[0].object) : null;
  if (hit !== hovered) {
    hovered = hit;
    if (hovered) sfx.playHover();
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
    // Pause the spin while aiming -- and never resume it in the focus layout,
    // which is meant to be read head-on.
    controls.autoRotate = !hovered && currentLayout !== 'focus';
    updateTooltip();
  }

  controls.update();
  composer.render();
}

boot();
animate();
