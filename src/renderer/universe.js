// 3D universe renderer: shows every desktop app as a glowing "planet"
// arranged in selectable layouts (galaxy / sphere / rings / grid).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as sfx from './sfx.js';

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
let currentLayout = 'galaxy';
let showHidden = true;
let query = '';
let warp = null; // { planet, t } active launch animation
let sunMode = 'normal'; // 'normal' | 'absorbing' | 'absorbed' (black-hole toggle)
const SUN_CENTER = new THREE.Vector3(0, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
let sunScale = 1; // eased visual scale of the sun while it holds the planets

// Persisted preferences: favorites pin apps near the sun, recents come next
let prefs = { favorites: [], recents: [] };
const isFav = (app) => prefs.favorites.includes(app.id);

async function toggleFavorite(p) {
  const id = p.app.id;
  const adding = !isFav(p.app);
  sfx.playFavorite(adding);
  prefs.favorites = adding
    ? [...prefs.favorites, id]
    : prefs.favorites.filter((f) => f !== id);
  p.halo.visible = isFav(p.app);
  await window.universe.setPrefs(prefs);
  applyLayout();
  updateTooltip();
}

async function recordRecent(app) {
  prefs.recents = [app.id, ...prefs.recents.filter((r) => r !== app.id)].slice(0, 12);
  await window.universe.setPrefs(prefs);
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
    const dataUrl = await window.universe.iconData(app.icon);
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
      const key = p.app.categories[0] || 'Otros';
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
};

/** Sort key: favorites innermost, then recents (by recency), then alphabetic. */
function sortRank(p) {
  if (isFav(p.app)) return -1000 + prefs.favorites.indexOf(p.app.id);
  const r = prefs.recents.indexOf(p.app.id);
  if (r !== -1) return -100 + r;
  return 0;
}

/** Re-apply visibility filter + layout targets. */
function applyLayout() {
  // Any relayout (search, filters, layout switch) releases the black hole
  if (sunMode !== 'normal') sunMode = 'normal';
  const q = query.toLowerCase();
  const visible = [];
  for (const p of planets) {
    const matches = !q
      || p.app.name.toLowerCase().includes(q)
      || p.app.comment.toLowerCase().includes(q)
      || p.app.categories.some((cat) => cat.toLowerCase().includes(q));
    const allowed = showHidden || !p.app.noDisplay;
    p.mesh.visible = matches && allowed;
    if (p.mesh.visible) visible.push(p);
  }
  visible.sort((a, b) => sortRank(a) - sortRank(b) || a.app.name.localeCompare(b.app.name));
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
    const data = await window.universe.iconData(app.icon);
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
document.getElementById('btn-close').addEventListener('click', () => window.universe.closeWindow());
document.getElementById('btn-min').addEventListener('click', () => window.universe.minimizeWindow());

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
  const typing = document.activeElement === searchInput;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (e.key === 'Escape') {
    if (typing && searchInput.value) {
      searchInput.value = '';
      query = '';
      focused = null;
      applyLayout();
    } else if (typing) {
      searchInput.blur();
    } else {
      window.universe.closeWindow();
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
    default:
  }
});

document.querySelectorAll('#layouts button').forEach((btn) => {
  btn.addEventListener('click', () => {
    sfx.playClick();
    document.querySelectorAll('#layouts button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentLayout = btn.dataset.layout;
    applyLayout();
  });
});

document.getElementById('show-hidden').addEventListener('change', (e) => {
  showHidden = e.target.checked;
  applyLayout();
});

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
    window.universe.setPrefs(prefs);
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
// Screen recording: captures the WebGL canvas directly (never freezes on
// layout/view changes, unlike X11 window capture), saves a WebM into ~/Videos.
// ---------------------------------------------------------------------------
const recordBtn = document.getElementById('btn-record');
const recIndicator = document.getElementById('rec-indicator');
const recTime = document.getElementById('rec-time');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');

let recorder = null;
let recChunks = [];
let recTimer = null;
let lastVideoPath = null;

function setRecUi(active) {
  recordBtn.classList.toggle('recording', active);
  recordBtn.title = active ? 'Stop recording' : 'Record screen';
  recordBtn.textContent = active ? '⏹' : '⏺';
  recIndicator.classList.toggle('hidden', !active);
}

function startRecTimer() {
  const t0 = Date.now();
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function showToast(text) {
  toastText.textContent = text;
  toast.classList.remove('hidden');
}

async function startRecording() {
  // Full-screen capture: includes the HTML UI + cursor, and unlike window
  // capture on X11 it does not freeze when views or window state change
  const videoStream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: { frameRate: { ideal: 30 } },
  });
  // Mix in the app's SFX audio (Web Audio master bus) with the video track
  const stream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...sfx.getAudioStream().getAudioTracks(),
  ]);
  recChunks = [];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus' : 'video/webm';
  recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 128_000,
  });
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    // Stop only the capture tracks; the SFX audio track is shared/reused
    videoStream.getTracks().forEach((track) => track.stop());
    clearInterval(recTimer);
    setRecUi(false);
    const blob = new Blob(recChunks, { type: 'video/webm' });
    recChunks = [];
    const buffer = await blob.arrayBuffer();
    lastVideoPath = await window.universe.saveVideo(buffer);
    showToast(`Recording saved: ${lastVideoPath}`);
  };
  recorder.start(250); // gather data in small chunks
  setRecUi(true);
  recTime.textContent = '0:00';
  startRecTimer();
}

recordBtn.addEventListener('click', async () => {
  sfx.playClick();
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    recorder = null;
  } else {
    try {
      await startRecording();
    } catch (err) {
      showToast(`Could not start recording: ${err.message}`);
    }
  }
});

document.getElementById('toast-open').addEventListener('click', () => {
  if (lastVideoPath) window.universe.showInFolder(lastVideoPath);
});
document.getElementById('toast-close').addEventListener('click', () => {
  toast.classList.add('hidden');
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Boot + render loop
// ---------------------------------------------------------------------------
async function boot() {
  prefs = await window.universe.getPrefs();
  // Merge saved settings over defaults (ignores stale/unknown keys)
  if (prefs.settings) {
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (typeof prefs.settings[key] === 'number') settings[key] = prefs.settings[key];
    }
  }
  syncSliders();
  applySettings();
  allApps = await window.universe.scanApps();
  // Build planets in small batches so labels (async icons) don't block long
  for (let i = 0; i < allApps.length; i++) {
    planets.push(await makePlanet(allApps[i], i));
    if (i % 12 === 0) applyLayout(); // progressively settle into place
  }
  applyLayout();
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  // Smoothly move planets to their layout targets + gentle float
  for (const p of planets) {
    if (!p.mesh.visible) continue;
    if (sunMode === 'absorbing') {
      // Vortex: spiral inward faster the closer they get, shrinking away
      const dist = p.mesh.position.distanceTo(SUN_CENTER);
      p.mesh.position.lerp(SUN_CENTER, 1 - Math.exp(-2.2 * dt));
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
    // Hover/keyboard-focus pulse easing back to 1
    const goal = (hovered === p || focused === p) ? 1.35 : 1;
    p.baseScale += (goal - p.baseScale) * Math.min(1, 6 * dt);
    p.mesh.scale.setScalar(p.baseScale);
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
      camera.position.copy(HOME_POS);
      controls.target.set(0, 0, 0);
      focused = null;
      window.universe.launchApp(launched);
      window.universe.closeWindow(); // hides; daemon keeps it warm
    }
  }

  core.rotation.y += dt * 0.2;
  glow.material.opacity = settings.sunGlow * (0.85 + Math.sin(t * 1.5) * 0.1);

  // Raycast hover detection (planet meshes only, not labels)
  raycaster.setFromCamera(pointer, camera);
  const meshes = planets.filter((p) => p.mesh.visible).map((p) => p.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  const hit = hits.length ? planets.find((p) => p.mesh === hits[0].object) : null;
  if (hit !== hovered) {
    hovered = hit;
    if (hovered) sfx.playHover();
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
    controls.autoRotate = !hovered; // pause spin while aiming
    updateTooltip();
  }

  controls.update();
  composer.render();
}

boot();
animate();
