import { SLABS } from './slabs.js';
import { initParticles, resizeParticles, emitChiselDust, emitCrumble, clearParticles } from './particles.js';
import { initCloud, triggerCrumbleCloud, triggerRevealCloud } from './cloud.js';
import { initSidebar } from './sidebar.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DELAY_MIN  = 250;
const DELAY_MAX  = 500;
const MAX_CHARS  = 100;
const VOL_SCALE  = 1.30;  // volume div = 130 % of slab (room for the chip mask)

// Worst-case slab dimensions (max w/h across all slabs × max stretch 1.06)
const MAX_SLAB_W = 508 * 1.06;  // 539
const MAX_SLAB_H = 497 * 1.06;  // 527
const CHIP_SCALE = 1.15;  // mask slab path scaled up → bigger chip, smaller chipped corners

// ── State ─────────────────────────────────────────────────────────────────────

let keyQueue     = [];
let isCarving    = false;
let charCount    = 0;
let audioCtx     = null;
let slabRotation = 0;
let currentSlab  = null;
let currentSafe  = null; // shape-aware text bounding box

// ── Init ──────────────────────────────────────────────────────────────────────

function updateSceneZoom() {
  const scaleH = (window.innerHeight - 32) / (MAX_SLAB_H + 48);
  const scaleW = (window.innerWidth  - 40) / MAX_SLAB_W;
  document.getElementById('scene').style.zoom = Math.min(1, scaleH, scaleW);
}

function init() {
  initCloud();
  initParticles();
  updateSceneZoom();
  window.addEventListener('resize', updateSceneZoom);
  currentSlab = pickSlab();
  applySlabShape(currentSlab);
  applyVeins(currentSlab);
  document.addEventListener('keydown', onKeyDown);
  document.getElementById('btn-destroy').addEventListener('click', destroySlab);
  document.getElementById('btn-eternalize').addEventListener('click', eternalize);
  initSidebar();
}

// ── Slab setup ────────────────────────────────────────────────────────────────

function pickSlab() {
  const base = SLABS[Math.floor(Math.random() * SLABS.length)];
  return {
    ...base,
    sx: 0.94 + Math.random() * 0.12,  // ±6 % horizontal stretch
    sy: 0.94 + Math.random() * 0.12,  // ±6 % vertical stretch
    volumeAngle: base.volumeAngle + (Math.random() * 20 - 10),  // ±10° chip angle jitter
  };
}

// Compute the path's bounding-box center by briefly appending an off-screen SVG.
// Used as the rotation origin for the volume layer so it aligns with the slab's
// actual visual centroid rather than the rectangular element's geometric center.
function getPathBBoxCenter(slab) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', slab.path);
  svg.appendChild(path);
  document.body.appendChild(svg);
  const bb = path.getBBox();
  document.body.removeChild(svg);
  return { cx: bb.x + bb.width / 2, cy: bb.y + bb.height / 2 };
}

// Compute the largest inscribed safe-text rectangle for the given slab shape.
// Rasterises the slab path intersected with the chip mask at 20 % scale,
// scans middle-80 % of rows/cols for the innermost filled edge on each side,
// then shrinks by `padding` px.  The chip parameter keeps text inside the
// volume layer, away from the chipped corners.
function computeSafeTextArea(slab, padding, chip) {
  const SC = 0.2;
  const cw = Math.ceil(slab.w * SC);
  const ch = Math.ceil(slab.h * SC);
  const oc = document.createElement('canvas');
  oc.width = cw; oc.height = ch;
  const c2 = oc.getContext('2d');
  c2.scale(SC, SC);
  c2.fill(new Path2D(slab.path));

  // Intersect with the chip/volume mask so text avoids chipped corners
  if (chip) {
    c2.globalCompositeOperation = 'destination-in';
    c2.save();
    c2.translate(chip.vcx, chip.vcy);
    c2.rotate(chip.angle * Math.PI / 180);
    c2.scale(1, -1);
    c2.translate(-chip.volW / 2, -chip.volH / 2);
    c2.translate(chip.maskX, chip.maskY);
    c2.scale(CHIP_SCALE, CHIP_SCALE);
    c2.fill(new Path2D(slab.path));
    c2.restore();
    c2.globalCompositeOperation = 'source-over';
  }

  const d = c2.getImageData(0, 0, cw, ch).data;

  const yLo = Math.floor(ch * 0.10), yHi = Math.ceil(ch * 0.90);
  const xLo = Math.floor(cw * 0.10), xHi = Math.ceil(cw * 0.90);

  const leftEdges = [], rightEdges = [], topEdges = [], bottomEdges = [];

  for (let y = yLo; y <= yHi; y++) {
    let rL = -1, rR = -1;
    for (let x = 0;    x < cw; x++) if (d[(y*cw+x)*4+3] > 64) { rL = x; break; }
    for (let x = cw-1; x >= 0; x--) if (d[(y*cw+x)*4+3] > 64) { rR = x; break; }
    if (rL >= 0 && rR >= rL) { leftEdges.push(rL); rightEdges.push(rR); }
  }
  for (let x = xLo; x <= xHi; x++) {
    let cT = -1, cB = -1;
    for (let y = 0;    y < ch; y++) if (d[(y*cw+x)*4+3] > 64) { cT = y; break; }
    for (let y = ch-1; y >= 0; y--) if (d[(y*cw+x)*4+3] > 64) { cB = y; break; }
    if (cT >= 0 && cB >= cT) { topEdges.push(cT); bottomEdges.push(cB); }
  }

  // Use percentiles instead of strict max/min so irregular shapes don't
  // produce degenerate (negative-width) rectangles.
  const pct = (arr, p) => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length * p)]; };
  const sL = pct(leftEdges,   0.75); // 75 % of rows have left edge ≤ this
  const sR = pct(rightEdges,  0.25); // 75 % of rows have right edge ≥ this
  const sT = pct(topEdges,    0.75);
  const sB = pct(bottomEdges, 0.25);

  const S = 1 / SC;
  return {
    cx: ((sL + sR) / 2) * S,
    cy: ((sT + sB) / 2) * S,
    w:  Math.max(60, (sR - sL) * S - padding * 2),
    h:  Math.max(40, (sB - sT) * S - padding * 2),
  };
}

function applySlabShape(slab) {
  const el = document.getElementById('slab');
  el.style.width    = slab.w + 'px';
  el.style.height   = slab.h + 'px';
  el.style.clipPath = `path("${slab.path}")`;

  slabRotation = (Math.random() * 0.4 - 0.2).toFixed(3); // ±0.2°
  const transform = `rotate(${slabRotation}deg) scale(${slab.sx.toFixed(4)}, ${slab.sy.toFixed(4)})`;
  el.style.transform = transform;

  // Rotate the volume layer around the slab path's bounding-box center (not the
  // element's geometric center) so the chip appears centered on the actual rock shape.
  const { cx: vcx, cy: vcy } = getPathBBoxCenter(slab);
  currentSlab._bboxCx = vcx;
  currentSlab._bboxCy = vcy;

  const vol = document.querySelector('.marble-volume');
  const volW = slab.w * VOL_SCALE;
  const volH = slab.h * VOL_SCALE;
  vol.style.left       = `${vcx}px`;
  vol.style.top        = `${vcy}px`;
  vol.style.marginLeft = `${-volW / 2}px`;
  vol.style.marginTop  = `${-volH / 2}px`;
  vol.style.transform  = `rotate(${slab.volumeAngle}deg) scaleY(-1)`;

  // CSS mask: slab path scaled by CHIP_SCALE and centered on the bbox center.
  // Bigger CHIP_SCALE → rotated mask covers more of the outer slab → smaller corners.
  const maskW = slab.w * CHIP_SCALE;
  const maskH = slab.h * CHIP_SCALE;
  const maskX = volW / 2 - vcx * CHIP_SCALE;
  const maskY = volH / 2 - vcy * CHIP_SCALE;
  const svgMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${slab.w}" height="${slab.h}" viewBox="0 0 ${slab.w} ${slab.h}"><path d="${slab.path}" fill="white"/></svg>`;
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(svgMask)}")`;
  vol.style.webkitMaskImage    = maskUrl;
  vol.style.maskImage          = maskUrl;
  vol.style.webkitMaskSize     = `${maskW}px ${maskH}px`;
  vol.style.maskSize           = `${maskW}px ${maskH}px`;
  vol.style.webkitMaskPosition = `${maskX}px ${maskY}px`;
  vol.style.maskPosition       = `${maskX}px ${maskY}px`;

  // Chip edge stroke: slab path scaled + translated to match the mask boundary.
  const edge = document.querySelector('.marble-chip-edge');
  edge.style.left       = `${vcx}px`;
  edge.style.top        = `${vcy}px`;
  edge.style.width      = `${volW}px`;
  edge.style.height     = `${volH}px`;
  edge.style.marginLeft = `${-volW / 2}px`;
  edge.style.marginTop  = `${-volH / 2}px`;
  edge.style.transform  = `rotate(${slab.volumeAngle}deg) scaleY(-1)`;
  const edgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${volW}" height="${volH}" viewBox="0 0 ${volW} ${volH}"><path d="${slab.path}" transform="translate(${maskX},${maskY}) scale(${CHIP_SCALE})" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.5"/></svg>`;
  edge.style.backgroundImage    = `url("data:image/svg+xml,${encodeURIComponent(edgeSvg)}")`;
  edge.style.backgroundSize     = `${volW}px ${volH}px`;
  edge.style.backgroundRepeat   = 'no-repeat';
  edge.style.backgroundPosition = '0 0';

  // Position text layer within the shape-aware safe area (20 px margin).
  // Pass chip geometry so text stays inside the volume layer, avoiding chipped corners.
  const chip = { vcx, vcy, volW, volH, maskX, maskY, angle: slab.volumeAngle };
  currentSafe = computeSafeTextArea(slab, 20, chip);
  const tl = document.getElementById('text-layer');
  const safeTop = currentSafe.cy - currentSafe.h / 2;
  tl.style.left      = currentSafe.cx + 'px';
  tl.style.top       = safeTop + 'px';
  tl.style.width     = currentSafe.w  + 'px';
  tl.style.transform = 'translateX(-50%)';

  // Mask the text through the marble base texture so it looks carved into stone.
  // The mask is the base.svg positioned to cover the full slab — the text layer's
  // top-left offset relative to the slab is (cx − w/2, safeTop).
  const maskOffX = -(currentSafe.cx - currentSafe.w  / 2);
  const maskOffY = -safeTop;
  el.style.setProperty('--slab-w',      slab.w + 'px');
  el.style.setProperty('--slab-h',      slab.h + 'px');
  tl.style.setProperty('--text-mask-x', maskOffX + 'px');
  tl.style.setProperty('--text-mask-y', maskOffY + 'px');
  tl.style.webkitMaskImage = 'url(assets/marble/base.svg)';
  tl.style.maskImage       = 'url(assets/marble/base.svg)';

  // Zoom is set once in init / on resize — not per-slab.

  resizeParticles(slab);
}

// ── Vein overlays ─────────────────────────────────────────────────────────────
// Vein SVGs are ~1035 × 245 and ~1033 × 243 (wide panoramic strips).
// Sized to 2.5× slab width, maintaining native aspect ratio.
// Angles match the Figma reference: ~−160° and ~−15° (with y-flip on B).

function applyVeins(slab) {
  const veinW  = slab.w * 2.5;
  const veinHA = veinW * (245 / 1035); // vein-a aspect
  const veinHB = veinW * (243 / 1033); // vein-b aspect

  const wrapA = document.getElementById('vein-a');
  const wrapB = document.getElementById('vein-b');

  // Vein A — sweeps around −160° (lower-left ↗ upper-right direction)
  const angleA = -160 + (Math.random() * 20 - 10);
  const txA    = slab.w * (0.4 + Math.random() * 0.2);
  const tyA    = slab.h * (0.22 + Math.random() * 0.18);
  const opA    = 0.75 + Math.random() * 0.20;

  wrapA.style.width     = veinW + 'px';
  wrapA.style.height    = veinHA + 'px';
  wrapA.style.left      = (txA - veinW / 2) + 'px';
  wrapA.style.top       = (tyA - veinHA / 2) + 'px';
  wrapA.style.transform = `rotate(${angleA}deg)`;
  wrapA.style.opacity   = opA;

  // Vein B — sweeps around −15°, y-flipped for organic variation
  const angleB = -15 + (Math.random() * 20 - 10);
  const txB    = slab.w * (0.4 + Math.random() * 0.2);
  const tyB    = slab.h * (0.45 + Math.random() * 0.2);
  const opB    = 0.65 + Math.random() * 0.20;

  wrapB.style.width     = veinW + 'px';
  wrapB.style.height    = veinHB + 'px';
  wrapB.style.left      = (txB - veinW / 2) + 'px';
  wrapB.style.top       = (tyB - veinHB / 2) + 'px';
  wrapB.style.transform = `rotate(${angleB}deg) scaleY(-1)`;
  wrapB.style.opacity   = opB;
}

// ── Typing ────────────────────────────────────────────────────────────────────

function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length > 1 && e.key !== ' ') return;
  if (e.key === 'Backspace' || e.key === 'Delete') return;
  if (charCount + keyQueue.length >= MAX_CHARS) return;

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  keyQueue.push(e.key === ' ' ? '\u00A0' : e.key.toUpperCase());
  processQueue();
}

function processQueue() {
  if (isCarving || keyQueue.length === 0) return;
  isCarving = true;

  const ch    = keyQueue.shift();
  const delay = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

  playChisel();

  setTimeout(() => {
    carveCharacter(ch);
    isCarving = false;
    processQueue();
  }, delay);
}

function carveCharacter(ch) {
  const container = document.getElementById('carved-text');

  const span = document.createElement('span');
  span.className   = 'letter';
  span.textContent = ch;

  // Slight letter-spacing variation: ±0.5 px
  const kern = (Math.random() * 1 - 0.5).toFixed(2);
  span.style.marginRight = kern + 'px';

  container.appendChild(span);
  charCount++;

  // Emit chisel dust at the letter's position (slab-local coordinates)
  const slabEl   = document.getElementById('slab');
  const slabRect = slabEl.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  const lx = (spanRect.left + spanRect.width / 2 - slabRect.left) / slabRect.width  * currentSlab.w;
  const ly = (spanRect.top  + spanRect.height / 2 - slabRect.top)  / slabRect.height * currentSlab.h;
  emitChiselDust(lx, ly);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    span.classList.add('emerged');
  }));
}

// ── Audio — chisel tap ────────────────────────────────────────────────────────

function playChisel() {
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const bufLen = Math.floor(audioCtx.sampleRate * 0.08);
  const buf    = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const data   = buf.getChannelData(0);

  for (let i = 0; i < bufLen; i++) {
    const env = Math.pow(1 - i / bufLen, 3);
    data[i]   = (Math.random() * 2 - 1) * env;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = buf;

  const bp = audioCtx.createBiquadFilter();
  bp.type            = 'bandpass';
  bp.frequency.value = 2800 + Math.random() * 800;
  bp.Q.value         = 0.8;

  const hp = audioCtx.createBiquadFilter();
  hp.type            = 'highpass';
  hp.frequency.value = 800;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.25, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

  src.connect(bp);
  bp.connect(hp);
  hp.connect(gain);
  gain.connect(audioCtx.destination);
  src.start(now);
}

// ── Destroy slab ──────────────────────────────────────────────────────────────

const FRACTURE_MS = 900;
let destroying = false;

function destroySlab() {
  const slabEl = document.getElementById('slab');
  const controls = document.getElementById('controls');
  if (destroying) return;
  destroying = true;

  emitCrumble(currentSlab);
  setTimeout(triggerCrumbleCloud, 200);

  // Hide original slab + controls immediately
  slabEl.style.opacity = '0';
  controls.style.opacity = '0';
  controls.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease' });

  // Launch fracture — slab breaks into falling pieces
  fractureSlab(slabEl, currentSlab);

  setTimeout(() => {
    document.getElementById('carved-text').innerHTML = '';
    charCount = 0;
    keyQueue  = [];
    isCarving = false;

    clearParticles();

    currentSlab = pickSlab();
    applySlabShape(currentSlab);
    applyVeins(currentSlab);

    triggerRevealCloud();
    const fadeIn = slabEl.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 1200, easing: 'ease-out', fill: 'forwards' },
    );
    const fadeInCtrl = controls.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 1200, easing: 'ease-out', fill: 'forwards' },
    );
    fadeIn.onfinish = () => {
      slabEl.style.opacity = '1';
      fadeIn.cancel();
      destroying = false;
    };
    fadeInCtrl.onfinish = () => {
      controls.style.opacity = '1';
      fadeInCtrl.cancel();
    };
  }, FRACTURE_MS);
}

// ── Slab fracture ────────────────────────────────────────────────────────────

function fractureSlab(slabEl, slab) {
  const scene = slabEl.parentElement;
  const numPieces = Math.random() > 0.5 ? 3 : 2;
  const polys = generateCrackPolygons(slab.w, slab.h, numPieces);

  // Slab position within scene (flex-centered)
  const slabLeft = slabEl.offsetLeft;
  const slabTop = slabEl.offsetTop;
  const slabTransform = slabEl.style.transform || '';

  const fragments = [];

  for (let i = 0; i < polys.length; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slab-fragment';
    wrapper.style.left = slabLeft + 'px';
    wrapper.style.top  = slabTop + 'px';
    wrapper.style.width  = slab.w + 'px';
    wrapper.style.height = slab.h + 'px';
    wrapper.style.transform = slabTransform;

    // Polygon clip selects this piece; slab's own clip-path gives stone edges
    const polyStr = polys[i].map(p => `${p[0]}px ${p[1]}px`).join(', ');
    wrapper.style.clipPath = `polygon(${polyStr})`;

    // Clone the full slab with all marble layers
    const clone = slabEl.cloneNode(true);
    clone.style.opacity = '1';
    clone.style.transform = 'none'; // wrapper handles transform
    clone.style.position = 'absolute';
    clone.style.inset = '0';
    wrapper.appendChild(clone);

    scene.appendChild(wrapper);
    fragments.push(wrapper);
  }

  // Animate each piece falling
  animateFragments(fragments, slab);
}

function animateFragments(fragments, slab) {
  const n = fragments.length;

  for (let i = 0; i < n; i++) {
    // Each piece drifts away from center horizontally
    const centerBias = (i / (n - 1 || 1)) - 0.5; // -0.5 to +0.5
    const dx = centerBias * (80 + Math.random() * 60); // ±40-70px
    const fallY = 350 + Math.random() * 200;
    const rot = (Math.random() - 0.5) * 30; // ±15°
    const delay = i * (30 + Math.random() * 50);  // staggered 30-80ms

    // Piece centroid for transform-origin (rough: polygon center)
    const frag = fragments[i];
    frag.style.transformOrigin = `${slab.w * (0.3 + centerBias * 0.4)}px ${slab.h * 0.4}px`;

    const baseTransform = frag.style.transform || '';

    const anim = frag.animate([
      { transform: `${baseTransform} translate(0px, 0px) rotate(0deg)`, opacity: 1 },
      { transform: `${baseTransform} translate(${dx * 0.05}px, ${fallY * 0.02}px) rotate(${rot * 0.05}deg)`, opacity: 1, offset: 0.08 },
      { transform: `${baseTransform} translate(${dx * 0.2}px, ${fallY * 0.1}px) rotate(${rot * 0.15}deg)`, opacity: 1, offset: 0.2 },
      { transform: `${baseTransform} translate(${dx * 0.45}px, ${fallY * 0.3}px) rotate(${rot * 0.35}deg)`, opacity: 0.9, offset: 0.4 },
      { transform: `${baseTransform} translate(${dx * 0.7}px, ${fallY * 0.55}px) rotate(${rot * 0.6}deg)`, opacity: 0.7, offset: 0.6 },
      { transform: `${baseTransform} translate(${dx * 0.9}px, ${fallY * 0.8}px) rotate(${rot * 0.85}deg)`, opacity: 0.4, offset: 0.8 },
      { transform: `${baseTransform} translate(${dx}px, ${fallY}px) rotate(${rot}deg)`, opacity: 0 },
    ], {
      duration: FRACTURE_MS - delay,
      delay,
      easing: 'ease-in',
      fill: 'forwards',
    });

    anim.onfinish = () => frag.remove();
  }
}

function generateCrackPolygons(w, h, numPieces) {
  const pad = 60; // extend beyond slab so only the slab's own clip-path is the edge

  function makeCrackLine(xCenter) {
    const pts = [];
    const steps = 3 + Math.floor(Math.random() * 3); // 3-5 zigzag segments
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const jitter = (Math.random() - 0.5) * w * 0.14;
      pts.push([xCenter + jitter, t * h]);
    }
    return pts;
  }

  if (numPieces === 2) {
    const xC = w * (0.35 + Math.random() * 0.3);
    const crack = makeCrackLine(xC);

    return [
      // Left piece: top-left → along crack → bottom-left
      [[-pad, -pad], ...crack, [-pad, h + pad]],
      // Right piece: top-right → along crack → bottom-right
      [[w + pad, -pad], ...crack, [w + pad, h + pad]],
    ];
  }

  // 3 pieces: two crack lines
  const x1 = w * (0.2 + Math.random() * 0.15);
  const x2 = w * (0.55 + Math.random() * 0.2);
  const crack1 = makeCrackLine(x1);
  const crack2 = makeCrackLine(x2);

  return [
    // Left piece
    [[-pad, -pad], ...crack1, [-pad, h + pad]],
    // Middle piece: crack1 top→bottom, then crack2 bottom→top
    [...crack1, ...crack2.slice().reverse()],
    // Right piece
    [[w + pad, -pad], ...crack2, [w + pad, h + pad]],
  ];
}

// ── Eternalize → PNG export ───────────────────────────────────────────────────

async function eternalize() {
  const W = 1920, H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0d0c0a';
  ctx.fillRect(0, 0, W, H);

  const sw = currentSlab.w;
  const sh = currentSlab.h;
  const sx = currentSlab.sx || 1;
  const sy = currentSlab.sy || 1;
  const scale = (H * 0.70) / Math.max(sw * sx, sh * sy);
  const dw = sw * sx * scale, dh = sh * sy * scale;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;

  // Clip to slab shape (with per-slab stretch)
  ctx.save();
  ctx.translate(dx, dy);
  ctx.scale(scale * sx, scale * sy);
  ctx.clip(new Path2D(currentSlab.path));

  // 1. Marble base
  const imgBase = document.querySelector('.marble-base img');
  ctx.drawImage(imgBase, 0, 0, sw, sh);

  // 2. Volume layer — rotated per-slab angle, y-flipped, normal blend.
  //    Replicates the CSS chip with CHIP_SCALE for the mask path.
  const imgVol = document.querySelector('.marble-volume img');
  const cx = currentSlab._bboxCx;
  const cy = currentSlab._bboxCy;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(currentSlab.volumeAngle * Math.PI / 180);
  ctx.scale(1, -1);
  ctx.globalAlpha = 1;
  const volW = sw * VOL_SCALE, volH = sh * VOL_SCALE;
  ctx.translate(-volW / 2, -volH / 2);
  const cMaskX = volW / 2 - cx * CHIP_SCALE;
  const cMaskY = volH / 2 - cy * CHIP_SCALE;
  // Build a scaled chip clip path matching the CSS mask
  const chipPath = new Path2D();
  chipPath.addPath(new Path2D(currentSlab.path),
    new DOMMatrix().translate(cMaskX, cMaskY).scale(CHIP_SCALE, CHIP_SCALE));
  ctx.save();
  ctx.clip(chipPath);
  ctx.drawImage(imgVol, 0, 0, volW, volH);
  ctx.restore();
  // Chip edge stroke
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth   = 1.5;
  ctx.stroke(chipPath);
  ctx.restore();
  ctx.restore();

  // 3. Cracks — rotated −60°
  const imgCracks = document.querySelector('.marble-cracks img');
  ctx.save();
  ctx.translate(sw / 2, sh / 2);
  ctx.rotate(-60 * Math.PI / 180);
  ctx.globalAlpha = 0.9;
  const crW = sw * 2, crH = sh * 2;
  ctx.drawImage(imgCracks, -crW / 2, -crH / 2, crW, crH);
  ctx.restore();

  // 4–5. Veins
  for (const id of ['vein-a', 'vein-b']) {
    const wrap = document.getElementById(id);
    const img  = wrap.querySelector('img');
    const l  = parseFloat(wrap.style.left)   || 0;
    const t  = parseFloat(wrap.style.top)    || 0;
    const vw = parseFloat(wrap.style.width)  || img.naturalWidth;
    const vh = parseFloat(wrap.style.height) || img.naturalHeight;
    const op = parseFloat(window.getComputedStyle(wrap).opacity) || 1;
    const tf = wrap.style.transform;
    const ang  = extractRotation(tf);
    const flipY = /scaleY\(-1\)/.test(tf);

    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = 'multiply';
    ctx.translate(l + vw / 2, t + vh / 2);
    ctx.rotate(ang * Math.PI / 180);
    if (flipY) ctx.scale(1, -1);
    ctx.drawImage(img, -vw / 2, -vh / 2, vw, vh);
    ctx.restore();
  }

  ctx.restore(); // end slab clip

  // Text
  if (currentSafe) {
    ctx.save();
    ctx.translate(dx, dy);
    ctx.scale(scale * sx, scale * sy);
    ctx.clip(new Path2D(currentSlab.path));

    const textEl = document.getElementById('carved-text');
    const text   = textEl.innerText.replace(/\n/g, ' ').trim();
    if (text) {
      const fontSize = Math.round(30 * scale);
      ctx.font         = `${fontSize}px 'Cinzel', serif`;
      ctx.fillStyle    = '#d3d5cc';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.letterSpacing = `${Math.round(1.8 * scale)}px`;
      const maxWidth = currentSafe.w * scale;
      const lineH    = fontSize * 1.25;
      const lines    = wrapText(ctx, text.toUpperCase(), maxWidth);
      const startY   = currentSafe.cy * scale - ((lines.length - 1) * lineH) / 2;
      lines.forEach((line, i) => {
        ctx.shadowColor   = 'rgba(0,0,0,0.12)';
        ctx.shadowOffsetX = 1 * scale;
        ctx.shadowOffsetY = 1 * scale;
        ctx.shadowBlur    = 2 * scale;
        ctx.fillText(line, currentSafe.cx * scale, startY + i * lineH);
      });
    }
    ctx.restore();
  }

  const link    = document.createElement('a');
  link.download = 'chisel.png';
  link.href     = canvas.toDataURL('image/png');
  link.click();
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let   line  = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function extractRotation(transformStr) {
  const m = transformStr && transformStr.match(/rotate\(([^)]+)deg\)/);
  return m ? parseFloat(m[1]) : 0;
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
