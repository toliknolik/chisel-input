import { SLABS } from './slabs.js';
import { initParticles, resizeParticles, emitChiselDust, emitCrumble, emitFractureDust, clearParticles } from './particles.js';
import { initCloud, triggerCrumbleCloud, triggerRevealCloud } from './cloud.js';
import { initSidebar } from './sidebar.js';
import { lightParams, setUpdateLighting } from './light.js';
import { ageParams } from './aging.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DELAY_MIN  = 250;
const DELAY_MAX  = 500;
const MAX_CHARS  = 100;
const VOL_SCALE  = 1.30;  // volume div = 130 % of slab (room for the chip mask)
const BASE_FONT  = 30;
const WORD_BREAK_LIMIT = 12; // chars before a word gets character-level wrapping
const MIN_FONT   = 14;
let   currentFontSize = BASE_FONT;

// Worst-case slab dimensions (max w/h across all slabs × max stretch 1.06)
const MAX_SLAB_W = 508 * 1.06;  // 539
const MAX_SLAB_H = 497 * 1.06;  // 527
const CHIP_BASE  = 1.15;  // minimum chip mask scale (at 0° rotation)
const CHIP_ANGLE = 0.004; // extra scale per degree of rotation → bigger angles get bigger mask

// ── State ─────────────────────────────────────────────────────────────────────

let keyQueue     = [];
let isCarving    = false;
let charCount    = 0;
let audioCtx     = null;
let slabRotation = 0;
let currentSlab  = null;
let currentSafe  = null; // shape-aware text bounding box
let crackCount      = 0;
let crackDirection  = 0;   // dominant angle in radians, set per slab
let existingCracks  = [];  // array of polylines (each is [[x,y], ...])
let crackSpines     = [];  // just the edge-to-edge spines (for fracture)
const MAX_CRACKS    = 4;
let ageLevel        = 0;   // 0 (fresh) to 1 (fully aged)
let lastTypeTime    = 0;   // timestamp of last keystroke
// ageParams imported from aging.js (shared with sidebar)

// lightParams imported from light.js (shared with sidebar)

// ── Init ──────────────────────────────────────────────────────────────────────

function updateSceneZoom() {
  const vv = window.visualViewport;
  const vpW = vv ? vv.width  : window.innerWidth;
  const vpH = vv ? vv.height : window.innerHeight;
  const scaleH = (vpH - 32) / (MAX_SLAB_H + 48);
  const scaleW = (vpW - 40) / MAX_SLAB_W;
  document.getElementById('scene').style.zoom = Math.min(1, scaleH, scaleW);
}

function init() {
  setUpdateLighting(updateLighting);
  initCloud();
  initParticles();
  updateSceneZoom();
  window.addEventListener('resize', updateSceneZoom);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateSceneZoom);
  }
  currentSlab = pickSlab();
  crackDirection = (20 + Math.random() * 50) * Math.PI / 180; // 20-70° from horizontal
  applySlabShape(currentSlab);
  applyVeins(currentSlab);
  document.addEventListener('keydown', onKeyDown);
  document.getElementById('btn-destroy').addEventListener('click', destroySlab);
  document.getElementById('btn-eternalize').addEventListener('click', eternalize);
  initSidebar();
  startAgingLoop();
  initMobileInput();
}

// ── Aging system ─────────────────────────────────────────────────────────────

function startAgingLoop() {
  let lastFrame = performance.now();
  function tick(now) {
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (ageParams.enabled && Date.now() - lastTypeTime > ageParams.idleDelay * 1000 && ageLevel < 1 && !destroying) {
      ageLevel = Math.min(1, ageLevel + dt * ageParams.speed / ageParams.duration);
      updateAgeVisuals();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function updateAgeVisuals() {
  const ageEl = document.querySelector('.marble-age');
  const mossEl = document.querySelector('.marble-moss');
  if (!ageEl || !mossEl || !currentSlab) return;

  // Darkening: light grey multiply — preserves volume contrast
  ageEl.style.opacity = (ageLevel * 0.5).toFixed(3);

  // Moss: starts at age 0.15
  const mossFrac = Math.max(0, (ageLevel - 0.15) / 0.85);

  // Opacity: snap to full — threshold + edge mask control visibility
  mossEl.style.opacity = mossFrac > 0 ? '0.85' : '0';

  // Combined edge + patch mask:
  // - Edge band: scale 1.0 → 0.92 (~8% band, but patches thin toward center)
  // - Threshold: strict (few spots) → relaxed (many patches)
  if (mossFrac > 0) {
    const pad = 3; // px moss extends beyond slab edges
    const w = currentSlab.w, h = currentSlab.h;
    const mw = w + pad * 2, mh = h + pad * 2;
    const cx = mw / 2, cy = mh / 2;
    const scale = 1.0 - mossFrac * 0.10;
    const gain = 50 - mossFrac * 35;   // 50 → 15
    const bias = -30 + mossFrac * 24;  // -30 → -6
    applyMossMask(mossEl, mw, mh, cx, cy, scale, 42, 75, gain, bias, pad);
  }
}

function applyMossMask(el, w, h, cx, cy, scale, seed, displacement, gain, bias, pad) {
  // Combined mask: edge band (inverted slab cutout) × turbulence patchiness.
  // 1. Edge band: white rect + black scaled-down slab = white only at edges
  // 2. Turbulence patches: fractalNoise thresholded to create organic spots
  // 3. Composite: "in" operator = patches only visible within edge band
  // pad: slab path is offset by this amount so moss extends beyond slab edges
  const p = pad || 0;
  const mossMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>` +
    // Edge band filter: displacement + hard threshold to re-sharpen interpolation blur
    `<filter id="edge${seed}" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feTurbulence type="turbulence" baseFrequency="0.005" numOctaves="3" seed="${seed}" result="warp"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="warp" scale="${displacement}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>` +
    `<feColorMatrix type="matrix" in="displaced" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 500 -250"/>` +
    `</filter>` +
    // Edge band shape as a mask — outer boundary = slab path scaled up (moss extends beyond slab)
    // Inner cutout = scaled-down slab (center stays clean)
    // Outer scale: expand slab path so it's ~pad px larger on each side
    `<mask id="edgemask${seed}">` +
    `<g transform="translate(${cx},${cy}) scale(${(1 + 2 * p / Math.min(w - 2*p, h - 2*p)).toFixed(3)}) translate(${-cx},${-cy})">` +
    `<g transform="translate(${p},${p})"><path d="${currentSlab.path}" fill="white"/></g>` +
    `</g>` +
    `<g filter="url(#edge${seed})" transform="translate(${cx},${cy}) scale(${scale.toFixed(3)}) translate(${-cx},${-cy})">` +
    `<g transform="translate(${p},${p})"><path d="${currentSlab.path}" fill="black"/></g>` +
    `</g>` +
    `</mask>` +
    // Patch filter: turbulence → threshold → erode (removes thin wisps)
    `<filter id="patch${seed}" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="3" seed="${seed + 7}" result="noise"/>` +
    `<feColorMatrix type="matrix" in="noise" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${gain.toFixed(1)} ${bias.toFixed(1)}" result="thresh"/>` +
    `<feMorphology operator="erode" radius="12" in="thresh" result="clean"/>` +
    `<feMorphology operator="dilate" radius="12" in="clean" result="expanded"/>` +
    `<feColorMatrix type="matrix" in="expanded" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 500 -250"/>` +
    `</filter>` +
    `</defs>` +
    // White patches confined to edge band
    `<rect width="${w}" height="${h}" fill="white" filter="url(#patch${seed})" mask="url(#edgemask${seed})"/>` +
    `</svg>`;
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(mossMask)}")`;
  el.style.webkitMaskImage = maskUrl;
  el.style.maskImage = maskUrl;
  el.style.webkitMaskSize = `${w}px ${h}px`;
  el.style.maskSize = `${w}px ${h}px`;
}

function resetAge() {
  ageLevel = 0;
  const ageEl = document.querySelector('.marble-age');
  if (ageEl) ageEl.style.opacity = '0';
  for (const el of document.querySelectorAll('.marble-moss')) {
    el.style.opacity = '0';
    el.style.webkitMaskImage = '';
    el.style.maskImage = '';
  }
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
    c2.scale(currentSlab._chipScale, currentSlab._chipScale);
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

  // Slab outline stroke — outside clip-path so it's not clipped
  const stroke = document.getElementById('slab-stroke');
  stroke.style.width     = slab.w + 'px';
  stroke.style.height    = slab.h + 'px';
  stroke.style.transform = transform;

  // Moss overlay — outside slab clip-path, expanded by 10px per side
  const mossPad = 3;
  const mossOuter = document.querySelector('.marble-moss');
  if (mossOuter) {
    mossOuter.style.width  = (slab.w + mossPad * 2) + 'px';
    mossOuter.style.height = (slab.h + mossPad * 2) + 'px';
    mossOuter.style.left   = -mossPad + 'px';
    mossOuter.style.top    = -mossPad + 'px';
    mossOuter.style.transform = transform;
  }
  stroke.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${slab.w}" height="${slab.h}" viewBox="0 0 ${slab.w} ${slab.h}"><path d="${slab.path}" fill="none" stroke="#F8F8F6" stroke-width="1"/></svg>`;

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

  // Chip scale adapts to rotation angle — higher angles need a bigger mask to
  // keep the chipped corners small and consistent across slab variants.
  const chipScale = CHIP_BASE + CHIP_ANGLE * Math.abs(slab.volumeAngle);
  currentSlab._chipScale = chipScale;
  const maskW = slab.w * chipScale;
  const maskH = slab.h * chipScale;
  const maskX = volW / 2 - vcx * chipScale;
  const maskY = volH / 2 - vcy * chipScale;
  const svgMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${slab.w}" height="${slab.h}" viewBox="0 0 ${slab.w} ${slab.h}"><path d="${slab.path}" fill="white"/></svg>`;
  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(svgMask)}")`;
  vol.style.webkitMaskImage    = maskUrl;
  vol.style.maskImage          = maskUrl;
  vol.style.webkitMaskSize     = `${maskW}px ${maskH}px`;
  vol.style.maskSize           = `${maskW}px ${maskH}px`;
  vol.style.webkitMaskPosition = `${maskX}px ${maskY}px`;
  vol.style.maskPosition       = `${maskX}px ${maskY}px`;

  // Surface lighting: feDiffuseLighting + feSpecularLighting on turbulence bump map.
  // Same position/transform/mask as the volume layer.
  const light = document.querySelector('.marble-light');
  light.style.left       = `${vcx}px`;
  light.style.top        = `${vcy}px`;
  light.style.marginLeft = `${-volW / 2}px`;
  light.style.marginTop  = `${-volH / 2}px`;
  light.style.transform  = `rotate(${slab.volumeAngle}deg) scaleY(-1)`;
  light.style.webkitMaskImage    = maskUrl;
  light.style.maskImage          = maskUrl;
  light.style.webkitMaskSize     = `${maskW}px ${maskH}px`;
  light.style.maskSize           = `${maskW}px ${maskH}px`;
  light.style.webkitMaskPosition = `${maskX}px ${maskY}px`;
  light.style.maskPosition       = `${maskX}px ${maskY}px`;
  light.style.width  = `${volW}px`;
  light.style.height = `${volH}px`;
  // Store dimensions for updateLighting() rebuilds
  light.dataset.volW = volW;
  light.dataset.volH = volH;
  updateLighting();

  // Chip edge stroke: slab path scaled + translated to match the mask boundary.
  const edge = document.querySelector('.marble-chip-edge');
  edge.style.left       = `${vcx}px`;
  edge.style.top        = `${vcy}px`;
  edge.style.width      = `${volW}px`;
  edge.style.height     = `${volH}px`;
  edge.style.marginLeft = `${-volW / 2}px`;
  edge.style.marginTop  = `${-volH / 2}px`;
  edge.style.transform  = `rotate(${slab.volumeAngle}deg) scaleY(-1)`;
  const edgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${volW}" height="${volH}" viewBox="0 0 ${volW} ${volH}"><path d="${slab.path}" transform="translate(${maskX},${maskY}) scale(${chipScale})" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="0.7"/></svg>`;
  edge.style.backgroundImage    = `url("data:image/svg+xml,${encodeURIComponent(edgeSvg)}")`;
  edge.style.backgroundSize     = `${volW}px ${volH}px`;
  edge.style.backgroundRepeat   = 'no-repeat';
  edge.style.backgroundPosition = '0 0';

  // Position text layer within the shape-aware safe area (20 px margin).
  // Pass chip geometry so text stays inside the volume layer, avoiding chipped corners.
  const chip = { vcx, vcy, volW, volH, maskX, maskY, angle: slab.volumeAngle };
  currentSafe = computeSafeTextArea(slab, 20, chip);
  const tl = document.getElementById('text-layer');
  // text-layer covers the whole slab (inset:0 in CSS); constrain text to safe zone
  const ct = document.getElementById('carved-text');
  ct.style.width = currentSafe.w + 'px';
  // Position text within safe area — center both vertically and horizontally.
  // Use symmetric padding (max of each axis) so text looks visually centered on the slab.
  const safeTop = currentSafe.cy - currentSafe.h / 2;
  const safeBottom = slab.h - (currentSafe.cy + currentSafe.h / 2);
  const safeLeft = currentSafe.cx - currentSafe.w / 2;
  const safeRight = slab.w - (currentSafe.cx + currentSafe.w / 2);
  const safeV = Math.max(safeTop, safeBottom);
  const safeH = Math.max(safeLeft, safeRight);
  tl.style.paddingTop = safeV + 'px';
  tl.style.paddingBottom = safeV + 'px';
  tl.style.paddingLeft = safeH + 'px';
  tl.style.paddingRight = safeH + 'px';

  // Mask crack overlay to the volume face so cracks don't appear on chipped edges.
  // The volume layer is rotated + flipped + offset, so we bake the same transform
  // into an SVG mask in slab-local coordinates.
  const crackOverlay = document.getElementById('crack-overlay');
  const ang = slab.volumeAngle * Math.PI / 180;
  // Build the transform that maps the volume-layer mask into slab coordinates:
  // 1. Translate so vcx,vcy is origin
  // 2. Rotate by volumeAngle
  // 3. Flip Y (scaleY -1)
  // 4. Position the mask path within the volume layer
  const crackMaskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${slab.w}" height="${slab.h}" viewBox="0 0 ${slab.w} ${slab.h}">` +
    `<g transform="translate(${vcx},${vcy}) rotate(${slab.volumeAngle}) scale(1,-1) translate(${-volW/2},${-volH/2})">` +
    `<path d="${slab.path}" transform="translate(${maskX},${maskY}) scale(${chipScale})" fill="white"/>` +
    `</g></svg>`;
  const crackMaskUrl = `url("data:image/svg+xml,${encodeURIComponent(crackMaskSvg)}")`;
  crackOverlay.style.webkitMaskImage = crackMaskUrl;
  crackOverlay.style.maskImage       = crackMaskUrl;
  crackOverlay.style.webkitMaskSize  = `${slab.w}px ${slab.h}px`;
  crackOverlay.style.maskSize        = `${slab.w}px ${slab.h}px`;

  // Mask the slab stroke so it doesn't appear in the chipped corner area
  // (avoids visible gap between stroke and chip edge).
  stroke.style.webkitMaskImage    = crackMaskUrl;
  stroke.style.maskImage          = crackMaskUrl;
  stroke.style.webkitMaskSize     = `${slab.w}px ${slab.h}px`;
  stroke.style.maskSize           = `${slab.w}px ${slab.h}px`;
  stroke.style.webkitMaskRepeat   = 'no-repeat';
  stroke.style.maskRepeat         = 'no-repeat';

  // Mask the text through the marble base texture so it looks carved into stone.
  // text-layer covers the full slab, so mask offset is (0, 0).
  const maskOffX = 0;
  const maskOffY = 0;
  el.style.setProperty('--slab-w',      slab.w + 'px');
  el.style.setProperty('--slab-h',      slab.h + 'px');
  tl.style.setProperty('--text-mask-x', maskOffX + 'px');
  tl.style.setProperty('--text-mask-y', maskOffY + 'px');
  tl.style.webkitMaskImage = 'url(assets/marble/base.svg)';
  tl.style.maskImage       = 'url(assets/marble/base.svg)';

  // Zoom is set once in init / on resize — not per-slab.

  resizeParticles(slab);
}

// ── Lighting SVG rebuild ──────────────────────────────────────────────────────
// Called on init and whenever sidebar changes a light param.

function updateLighting() {
  const light = document.querySelector('.marble-light');
  if (!light || !light.dataset.volW) return;
  const volW = parseFloat(light.dataset.volW);
  const volH = parseFloat(light.dataset.volH);
  const lp = lightParams;

  light.style.opacity      = lp.opacity;
  light.style.mixBlendMode = lp.blendMode;

  light.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${volW}" height="${volH}" viewBox="0 0 ${volW} ${volH}" style="display:block">` +
    `<filter id="marble-lighting" x="0" y="0" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${lp.baseFrequency}" numOctaves="${lp.numOctaves}" seed="42" result="noise"/>` +
      `<feDiffuseLighting in="noise" surfaceScale="${lp.diffuseSurface}" diffuseConstant="${lp.diffuseConstant}" lighting-color="#F8F1DF" result="diffuse">` +
        `<feDistantLight azimuth="${lp.azimuth}" elevation="${lp.elevation}"/>` +
      `</feDiffuseLighting>` +
      `<feSpecularLighting in="noise" surfaceScale="${lp.specSurface}" specularConstant="${lp.specConstant}" specularExponent="${lp.specExponent}" lighting-color="#FFFFFF" result="specular">` +
        `<feDistantLight azimuth="${lp.azimuth}" elevation="${lp.elevation}"/>` +
      `</feSpecularLighting>` +
      `<feComposite in="specular" in2="diffuse" operator="arithmetic" k1="0" k2="1" k3="0.6" k4="0" result="lit"/>` +
    `</filter>` +
    `<rect width="100%" height="100%" filter="url(#marble-lighting)"/>` +
  `</svg>`;
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

// ── Audio helper ──────────────────────────────────────────────────────────────

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ── Typing ────────────────────────────────────────────────────────────────────

// Only allow Latin letters, digits, and basic punctuation. U → V (Roman style).
const LATIN_RE = /^[A-Za-z0-9 .,'!?;:\-()&]$/;
function romanize(ch) {
  const upper = ch.toUpperCase();
  return upper === 'U' ? 'V' : upper;
}

function onKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (!destroying) addCrack();
    return;
  }
  if (e.key.length > 1 && e.key !== ' ') return;
  if (!LATIN_RE.test(e.key)) return;        // block non-Latin
  e.preventDefault();
  lastTypeTime = Date.now();
  if (charCount + keyQueue.length >= MAX_CHARS) return;

  ensureAudio();

  keyQueue.push(e.key === ' ' ? '\u00A0' : romanize(e.key));
  processQueue();
}

// ── Mobile input ──────────────────────────────────────────────────────────────

function initMobileInput() {
  const mobileInput = document.getElementById('mobile-input');
  if (!mobileInput) return;

  // Seed with padding so backspace always has content to delete
  const SEED = '......';
  mobileInput.value = SEED;
  let lastLen = SEED.length;

  // Focus hidden input on any touch/click on the scene (opens virtual keyboard)
  const scene = document.getElementById('scene');
  scene.addEventListener('touchstart', focusMobileInput, { passive: true });
  scene.addEventListener('click', focusMobileInput);

  // Resume AudioContext on first user interaction (mobile requirement)
  function resumeAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    document.removeEventListener('touchstart', resumeAudio);
    document.removeEventListener('click', resumeAudio);
  }
  document.addEventListener('touchstart', resumeAudio, { passive: true });
  document.addEventListener('click', resumeAudio);

  // Handle text input from virtual keyboard
  mobileInput.addEventListener('beforeinput', (e) => {
    ensureAudio();
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
      e.preventDefault();
      if (!destroying) addCrack();
      // Re-seed so next backspace works
      mobileInput.value = SEED;
      lastLen = SEED.length;
      return;
    }
    if (e.inputType === 'insertText' && e.data) {
      e.preventDefault();
      lastTypeTime = Date.now();

      for (const ch of e.data) {
        if (!LATIN_RE.test(ch)) continue;    // block non-Latin
        if (charCount + keyQueue.length >= MAX_CHARS) break;
        keyQueue.push(ch === ' ' ? '\u00A0' : romanize(ch));
      }
      processQueue();
      // Re-seed
      mobileInput.value = SEED;
      lastLen = SEED.length;
    }
  });

  // Fallback: input event for browsers that don't support beforeinput well
  mobileInput.addEventListener('input', () => {
    ensureAudio();
    const curLen = mobileInput.value.length;
    if (curLen > lastLen) {
      // Characters added
      const added = mobileInput.value.slice(lastLen);
      lastTypeTime = Date.now();
      for (const ch of added) {
        if (!LATIN_RE.test(ch)) continue;    // block non-Latin
        if (charCount + keyQueue.length >= MAX_CHARS) break;
        keyQueue.push(ch === ' ' ? '\u00A0' : romanize(ch));
      }
      processQueue();
    } else if (curLen < lastLen) {
      // Characters deleted (backspace)
      if (!destroying) addCrack();
    }
    // Re-seed to ensure backspace always works
    mobileInput.value = SEED;
    lastLen = SEED.length;
  });

  // Keep focus on mobile input (refocus if lost, unless sidebar is open)
  mobileInput.addEventListener('blur', () => {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar?.classList.contains('open')) {
      setTimeout(() => mobileInput.focus(), 100);
    }
  });
}

function focusMobileInput() {
  const mobileInput = document.getElementById('mobile-input');
  if (mobileInput) mobileInput.focus();
}

function processQueue() {
  if (isCarving || keyQueue.length === 0) return;
  isCarving = true;

  const ch    = keyQueue.shift();
  const delay = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

  if (ch === '\u00A0') playSkip(); else playChisel();

  setTimeout(() => {
    carveCharacter(ch);
    isCarving = false;
    processQueue();
  }, delay);
}

function getOrCreateWord(container) {
  const cursor = document.getElementById('cursor');
  // Last content node is the one before the cursor
  const last = cursor ? cursor.previousSibling : container.lastChild;
  if (last && last.nodeType === Node.ELEMENT_NODE && last.classList.contains('word')) return last;
  const w = document.createElement('span');
  w.className = 'word';
  // Insert before cursor so cursor stays at the end
  if (cursor && cursor.parentNode === container) {
    container.insertBefore(w, cursor);
  } else {
    container.appendChild(w);
  }
  return w;
}

function isTextOverflowing() {
  const container = document.getElementById('carved-text');
  const tl = document.getElementById('text-layer');
  const style = getComputedStyle(tl);
  const available = tl.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const fontSize = parseFloat(getComputedStyle(container).fontSize);
  const lineHeight = parseFloat(getComputedStyle(container).lineHeight);
  const leading = lineHeight - fontSize;
  return container.scrollHeight > available + leading;
}

function applyFontSize(size) {
  currentFontSize = size;
  const container = document.getElementById('carved-text');
  container.style.fontSize = size + 'px';
  container.style.letterSpacing = (1.8 * size / BASE_FONT).toFixed(1) + 'px';
}

// Try shrinking font to fit; returns true if text fits, false if at minimum and still overflows
function shrinkToFit() {
  while (isTextOverflowing() && currentFontSize > MIN_FONT) {
    applyFontSize(currentFontSize - 1);
  }
  return !isTextOverflowing();
}

function carveCharacter(ch) {
  const container = document.getElementById('carved-text');

  if (ch === ' ' || ch === '\u00A0') {
    const spaceNode = document.createTextNode('\u00A0');
    const cursor = document.getElementById('cursor');
    if (cursor && cursor.parentNode === container) {
      container.insertBefore(spaceNode, cursor);
    } else {
      container.appendChild(spaceNode);
    }
    if (!shrinkToFit()) {
      container.removeChild(spaceNode);
      keyQueue.length = 0;
      return;
    }
    charCount++;
    return;
  }

  const word = getOrCreateWord(container);

  const span = document.createElement('span');
  span.className   = 'letter';
  span.textContent = ch;

  // Slight letter-spacing variation: ±0.5 px
  const kern = (Math.random() * 1 - 0.5).toFixed(2);
  span.style.marginRight = kern + 'px';

  word.appendChild(span);

  // Allow character-level wrapping when a word exceeds the limit
  const letterCount = word.querySelectorAll('.letter').length;
  if (letterCount > WORD_BREAK_LIMIT) word.classList.add('break-word');

  if (!shrinkToFit()) {
    span.remove();
    if (word.childNodes.length === 0) word.remove();
    keyQueue.length = 0;
    return;
  }

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

const pickBuffers = [];
let lastPickIdx = -1;

// Preload pick samples
['assets/pick_1.mp3', 'assets/pick_2.mp3', 'assets/pick_3.mp3'].forEach((url, i) => {
  preloadAudio(url).then(b => { pickBuffers[i] = b; }).catch(() => {});
});

function playChisel() {
  if (!audioCtx || pickBuffers.length === 0) return;

  // Pick a random sample, avoiding repeat of the last one
  let idx;
  do { idx = Math.floor(Math.random() * 3); } while (idx === lastPickIdx && pickBuffers.length > 1);
  lastPickIdx = idx;

  const buf = pickBuffers[idx];
  if (!buf) return;

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.85 + Math.random() * 0.3; // pitch variation

  const gain = audioCtx.createGain();
  gain.gain.value = 0.3 + Math.random() * 0.2; // volume variation

  src.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

// ── Backspace cracks ─────────────────────────────────────────────────────────

function addCrack() {
  ensureAudio();
  crackCount++;
  playCrack();

  if (crackCount >= MAX_CRACKS) {
    destroySlab();
    return;
  }

  const severity = crackCount;
  const overlay = document.getElementById('crack-overlay');
  const w = currentSlab.w;
  const h = currentSlab.h;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('fill', 'none');

  // Generate one spine per backspace, mostly parallel to crackDirection
  const spine = generateCrackSpine(w, h, severity);
  const branches = generateBranches(spine, w, h, severity);
  const allPaths = [spine, ...branches];
  const allAnimTargets = [];

  for (let pi = 0; pi < allPaths.length; pi++) {
    const pts = allPaths[pi];
    const d = pointsToSvgPath(pts);
    const isBranch = pi > 0;

    const strokeW = isBranch ? [0, 0.35, 0.42, 0.5][severity] : [0, 0.45, 0.6, 0.7][severity];
    const opacity = isBranch ? [0, 0.09, 0.12, 0.15][severity] : [0, 0.13, 0.17, 0.21][severity];

    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', `rgba(90,85,80,${opacity})`);
    p.setAttribute('stroke-width', String(strokeW));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    allAnimTargets.push({ el: p, delay: isBranch ? 80 + pi * 30 : 0 });
  }

  overlay.appendChild(svg);

  // Store spine + branches for anti-crossing checks
  crackSpines.push(spine);
  existingCracks.push(spine);
  for (const b of branches) existingCracks.push(b);

  // Animate paths growing
  requestAnimationFrame(() => {
    for (const { el, delay } of allAnimTargets) {
      const len = el.getTotalLength();
      el.style.strokeDasharray = len;
      el.style.strokeDashoffset = len;
      el.style.transition = `stroke-dashoffset ${[0, 300, 200, 150][severity]}ms ease-out ${delay}ms`;
    }
    requestAnimationFrame(() => {
      for (const { el } of allAnimTargets) el.style.strokeDashoffset = '0';
    });
  });
}

// ── Segment intersection check ───────────────────────────────────────────────

function segmentsIntersect(a1, a2, b1, b2) {
  const d1x = a2[0] - a1[0], d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0], d2y = b2[1] - b1[1];
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-8) return false; // parallel
  const dx = b1[0] - a1[0], dy = b1[1] - a1[1];
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

function polylineCrossesExisting(pts) {
  for (let i = 0; i < pts.length - 1; i++) {
    for (const existing of existingCracks) {
      for (let j = 0; j < existing.length - 1; j++) {
        if (segmentsIntersect(pts[i], pts[i + 1], existing[j], existing[j + 1])) return true;
      }
    }
  }
  return false;
}

// ── Generate crack spine — parallel to dominant direction ─────────────────────

function generateCrackSpine(w, h, severity) {
  const angle = crackDirection + (Math.random() - 0.5) * 0.23; // ±~6-7°
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const perpX = -dy, perpY = dx;

  // Space cracks apart perpendicular to the direction
  const diag = Math.sqrt(w * w + h * h);
  // Spread cracks across the slab: offset from center line
  const spread = diag * 0.6;
  const n = existingCracks.length;
  // Distribute offsets: alternate sides of center, growing outward
  const offsets = [0, -0.3, 0.3, -0.6, 0.6, -0.15, 0.15];
  const offsetFrac = n < offsets.length ? offsets[n] : (Math.random() - 0.5);
  const perpOffset = offsetFrac * spread + (Math.random() - 0.5) * 20;

  // Center of the slab
  const cx = w / 2 + perpX * perpOffset;
  const cy = h / 2 + perpY * perpOffset;

  // Extend ray in both directions from center until hitting slab bounds
  const rayHitEdge = (ox, oy, rdx, rdy) => {
    let tMin = Infinity;
    // Check 4 slab edges
    if (Math.abs(rdx) > 1e-6) {
      const t0 = -ox / rdx;       // left edge (x=0)
      const t1 = (w - ox) / rdx;  // right edge (x=w)
      if (t0 > 0) tMin = Math.min(tMin, t0);
      if (t1 > 0) tMin = Math.min(tMin, t1);
    }
    if (Math.abs(rdy) > 1e-6) {
      const t2 = -oy / rdy;       // top edge (y=0)
      const t3 = (h - oy) / rdy;  // bottom edge (y=h)
      if (t2 > 0) tMin = Math.min(tMin, t2);
      if (t3 > 0) tMin = Math.min(tMin, t3);
    }
    return tMin === Infinity ? 100 : tMin;
  };

  const tFwd = rayHitEdge(cx, cy, dx, dy);
  const tBwd = rayHitEdge(cx, cy, -dx, -dy);

  const sx = cx - dx * tBwd * 0.98, sy = cy - dy * tBwd * 0.98;
  const ex = cx + dx * tFwd * 0.98, ey = cy + dy * tFwd * 0.98;

  // Build polyline with subtle organic drift
  const segments = 20 + Math.floor(Math.random() * 10);
  const points = [[sx, sy]];
  const mdx = ex - sx, mdy = ey - sy;
  const mLen = Math.sqrt(mdx * mdx + mdy * mdy) || 1;
  const pX = -mdy / mLen, pY = mdx / mLen;

  let drift = 0;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    drift += (Math.random() - 0.5) * [0, 2.5, 3, 3.5][severity];
    drift *= 0.94;
    points.push([sx + mdx * t + pX * drift, sy + mdy * t + pY * drift]);
  }

  // Anti-crossing: retry with slight perpendicular shift if crossing detected
  if (polylineCrossesExisting(points)) {
    const shift = 15 + Math.random() * 15;
    const side = Math.random() > 0.5 ? 1 : -1;
    for (let i = 0; i < points.length; i++) {
      points[i][0] += perpX * shift * side;
      points[i][1] += perpY * shift * side;
    }
  }

  return points;
}

// ── Generate 0-2 long branches at acute angles ──────────────────────────────

function generateBranches(spine, w, h, severity) {
  const branches = [];
  const numBranches = severity <= 1
    ? Math.floor(Math.random() * 2)       // 0-1
    : 1 + Math.floor(Math.random() * 2);  // 1-2

  // Spine total length for proportional branch length
  let spineLen = 0;
  for (let i = 1; i < spine.length; i++) {
    const dx = spine[i][0] - spine[i - 1][0], dy = spine[i][1] - spine[i - 1][1];
    spineLen += Math.sqrt(dx * dx + dy * dy);
  }

  for (let b = 0; b < numBranches; b++) {
    // Pick a point along the spine (20-80% range)
    const idx = Math.floor(spine.length * (0.2 + Math.random() * 0.6));
    const [bx, by] = spine[idx];

    // Get spine direction at this point
    const prev = spine[Math.max(0, idx - 1)];
    const next = spine[Math.min(spine.length - 1, idx + 1)];
    const sdx = next[0] - prev[0], sdy = next[1] - prev[1];
    const sLen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;

    // Branch at acute angle (10-25°) from spine direction
    const angle = (10 + Math.random() * 15) * Math.PI / 180;
    const side = Math.random() > 0.5 ? 1 : -1;
    const cos = Math.cos(side * angle), sin = Math.sin(side * angle);
    const bdx = (sdx / sLen) * cos - (sdy / sLen) * sin;
    const bdy = (sdx / sLen) * sin + (sdy / sLen) * cos;

    // Long branch: 40-80% of spine length
    const branchLen = spineLen * (0.4 + Math.random() * 0.4);
    const steps = 10 + Math.floor(Math.random() * 6);
    const pts = [[bx, by]];

    let bDrift = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      bDrift += (Math.random() - 0.5) * 1.5;
      bDrift *= 0.93;
      const perpBx = -bdy, perpBy = bdx;
      pts.push([
        bx + bdx * branchLen * t + perpBx * bDrift,
        by + bdy * branchLen * t + perpBy * bDrift,
      ]);
    }

    // Skip branch if it crosses existing cracks
    if (!polylineCrossesExisting(pts)) {
      branches.push(pts);
    }
  }
  return branches;
}

// Convert point array to SVG path — straight line segments for angular look
function pointsToSvgPath(pts) {
  if (pts.length < 2) return '';
  const f = n => n.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L${f(pts[i][0])} ${f(pts[i][1])}`;
  }
  return d;
}

let crackBuffer = null;
let newSlabBuffer = null;

// Preload audio samples
function preloadAudio(url) {
  return fetch(url)
    .then(r => r.arrayBuffer())
    .then(buf => {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      return audioCtx.decodeAudioData(buf);
    });
}
let skipBuffer = null;
let destroyBuffer = null;
preloadAudio('assets/crack.mp3').then(b => { crackBuffer = b; }).catch(() => {});
preloadAudio('assets/new_slab.mp3').then(b => { newSlabBuffer = b; }).catch(() => {});
preloadAudio('assets/destroy.mp3').then(b => { destroyBuffer = b; }).catch(() => {});
preloadAudio('assets/skip.mp3').then(b => { skipBuffer = b; }).catch(() => {});

function playCrack() {
  if (!audioCtx || !crackBuffer) return;

  const src = audioCtx.createBufferSource();
  src.buffer = crackBuffer;
  // Slight pitch variation each crack
  src.playbackRate.value = 0.9 + Math.random() * 0.2;

  const gain = audioCtx.createGain();
  gain.gain.value = 0.5;

  src.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

function playNewSlab() {
  if (!audioCtx || !newSlabBuffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = newSlabBuffer;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.5;
  src.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

function playSkip() {
  if (!audioCtx || !skipBuffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = skipBuffer;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.4;
  src.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

function playDestroy() {
  if (!audioCtx || !destroyBuffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = destroyBuffer;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.6;
  src.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

// ── Destroy slab ──────────────────────────────────────────────────────────────

const FRACTURE_MS = 1100;
let destroying = false;

function destroySlab() {
  const slabEl = document.getElementById('slab');
  const controls = document.getElementById('controls');
  if (destroying) return;
  destroying = true;

  playDestroy();
  emitCrumble(currentSlab);
  emitFractureDust(crackSpines);
  setTimeout(triggerCrumbleCloud, 200);

  // Capture position BEFORE hiding (offsetLeft/Top need visible element)
  const strokeEl = document.getElementById('slab-stroke');
  const mossOuter = document.querySelector('.marble-moss');

  // Launch fracture BEFORE hiding — needs layout info
  fractureSlab(slabEl, currentSlab);

  // Now hide original slab + stroke + moss + crack overlay + controls
  slabEl.style.opacity = '0';
  strokeEl.style.opacity = '0';
  if (mossOuter) mossOuter.style.opacity = '0';
  document.getElementById('crack-overlay').style.opacity = '0';
  controls.style.opacity = '0';
  controls.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease' });

  setTimeout(() => {
    const ct = document.getElementById('carved-text');
    const cur = document.getElementById('cursor');
    ct.innerHTML = '';
    if (cur) ct.appendChild(cur);
    const crackOv = document.getElementById('crack-overlay');
    crackOv.innerHTML = '';
    crackOv.style.opacity = '1';
    charCount  = 0;
    crackCount = 0;
    applyFontSize(BASE_FONT);
    existingCracks = [];
    crackSpines = [];
    crackDirection = (20 + Math.random() * 50) * Math.PI / 180;
    resetAge();
    keyQueue   = [];
    isCarving  = false;

    clearParticles();

    currentSlab = pickSlab();
    applySlabShape(currentSlab);
    applyVeins(currentSlab);

    triggerRevealCloud();
    playNewSlab();
    const fadeIn = slabEl.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 1200, easing: 'ease-out', fill: 'forwards' },
    );
    const fadeInStroke = strokeEl.animate(
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
    fadeInStroke.onfinish = () => {
      strokeEl.style.opacity = '1';
      fadeInStroke.cancel();
    };
    fadeInCtrl.onfinish = () => {
      controls.style.opacity = '1';
      fadeInCtrl.cancel();
    };
  }, FRACTURE_MS + 800); // extra time for staggered fragment falls
}

// ── Slab fracture ────────────────────────────────────────────────────────────

function polyArea(pts) {
  let area = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = Array.isArray(pts[i]) ? pts[i] : [0, 0];
    const [x2, y2] = Array.isArray(pts[(i + 1) % n]) ? pts[(i + 1) % n] : [0, 0];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function fractureSlab(slabEl, slab) {
  const scene = slabEl.parentElement;
  const minArea = slab.w * slab.h * 0.05; // skip fragments smaller than 5% of slab
  const polys = generateCrackPolygons(slab.w, slab.h).filter(p => polyArea(p) > minArea);

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

  // Shuffle order so pieces don't always fall left-to-right
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  for (let rank = 0; rank < n; rank++) {
    const i = order[rank];
    const frag = fragments[i];

    // Each piece drifts away from center
    const centerBias = (i / (n - 1 || 1)) - 0.5; // -0.5 to +0.5
    const dx = centerBias * (80 + Math.random() * 60);
    const fallY = 350 + Math.random() * 200;
    const rot = (Math.random() - 0.5) * 30; // ±15°

    // Staggered: 120-200ms between each piece releasing
    const delay = rank * (120 + Math.random() * 80);

    frag.style.transformOrigin = `${slab.w * (0.3 + centerBias * 0.4)}px ${slab.h * 0.4}px`;

    const baseTransform = frag.style.transform || '';
    const dur = FRACTURE_MS;

    const anim = frag.animate([
      { transform: `${baseTransform} translate(0px, 0px) rotate(0deg)`, opacity: 1 },
      // Brief hold — piece separates but hasn't fallen yet
      { transform: `${baseTransform} translate(${dx * 0.02}px, ${fallY * 0.01}px) rotate(${rot * 0.02}deg)`, opacity: 1, offset: 0.1 },
      // Gravity accelerates
      { transform: `${baseTransform} translate(${dx * 0.15}px, ${fallY * 0.08}px) rotate(${rot * 0.1}deg)`, opacity: 1, offset: 0.25 },
      { transform: `${baseTransform} translate(${dx * 0.4}px, ${fallY * 0.3}px) rotate(${rot * 0.3}deg)`, opacity: 0.9, offset: 0.45 },
      { transform: `${baseTransform} translate(${dx * 0.7}px, ${fallY * 0.6}px) rotate(${rot * 0.6}deg)`, opacity: 0.6, offset: 0.65 },
      { transform: `${baseTransform} translate(${dx * 0.9}px, ${fallY * 0.85}px) rotate(${rot * 0.85}deg)`, opacity: 0.3, offset: 0.85 },
      { transform: `${baseTransform} translate(${dx}px, ${fallY}px) rotate(${rot}deg)`, opacity: 0 },
    ], {
      duration: dur,
      delay,
      easing: 'cubic-bezier(0.45, 0, 0.85, 0.35)', // slow start, accelerating fall
      fill: 'forwards',
    });

    anim.onfinish = () => frag.remove();
  }
}

function generateCrackPolygons(w, h) {
  const pad = 60; // extend beyond slab so only the slab's own clip-path is the edge

  // Use actual crack spines if available, else generate using crack spine logic
  let lines;
  if (crackSpines.length > 0) {
    lines = crackSpines.slice();
  } else {
    // Fallback: generate 1-2 spines using the same diagonal logic as backspace cracks
    const count = Math.random() > 0.4 ? 2 : 1;
    lines = [];
    for (let i = 0; i < count; i++) {
      const spine = generateCrackSpine(w, h, i + 1);
      lines.push(spine);
      existingCracks.push(spine); // so anti-crossing works for 2nd line
    }
    existingCracks = []; // clean up temp state
  }

  // Sort spines by perpendicular offset from dominant crack direction
  // so we can create strips left→right (or along the perpendicular axis)
  const perpX = -Math.sin(crackDirection);
  const perpY = Math.cos(crackDirection);
  function spineOffset(spine) {
    // Average perpendicular projection of spine midpoint
    const mid = spine[Math.floor(spine.length / 2)];
    return mid[0] * perpX + mid[1] * perpY;
  }
  lines.sort((a, b) => spineOffset(a) - spineOffset(b));

  // Walk rectangle boundary clockwise, collecting corners between two edge points.
  // Each crack spine starts and ends on slab edges — we partition the boundary at those points.
  const corners = [[-pad, -pad], [w + pad, -pad], [w + pad, h + pad], [-pad, h + pad]];

  // Determine which edge a point is on (0=top, 1=right, 2=bottom, 3=left)
  // and its parametric position along the full clockwise perimeter.
  function perimeterT(pt) {
    const [x, y] = pt;
    const eps = 5;
    if (y <= eps)     return (x + pad) / (w + 2 * pad);                             // top edge: 0→1
    if (x >= w - eps) return 1 + (y + pad) / (h + 2 * pad);                         // right edge: 1→2
    if (y >= h - eps) return 2 + (w + pad - x) / (w + 2 * pad);                     // bottom edge: 2→3
    return 3 + (h + pad - y) / (h + 2 * pad);                                       // left edge: 3→4
  }

  // For each crack, get the perimeter position of its start and end
  // Start = first point, end = last point
  const crackEndpoints = lines.map(spine => {
    const tStart = perimeterT(spine[0]);
    const tEnd = perimeterT(spine[spine.length - 1]);
    return { spine, tStart, tEnd };
  });

  // Collect all split points on the perimeter (crack endpoints)
  // Each split point has a perimeter position and references its crack
  const splits = [];
  for (const ce of crackEndpoints) {
    splits.push({ t: ce.tStart, crack: ce, isStart: true });
    splits.push({ t: ce.tEnd,   crack: ce, isStart: false });
  }
  splits.sort((a, b) => a.t - b.t);

  // Walk the perimeter, collecting boundary corners + crack traversals into polygons.
  // Between consecutive same-side splits, the boundary arc + crack form a closed polygon.
  // Simpler approach: use perpendicular side test. For each region between consecutive
  // cracks (sorted by offset), build a polygon from the two cracks + boundary corners between them.

  // For two consecutive crack lines, build a polygon:
  // Walk crack A from start→end, then boundary corners from A.end to B.end,
  // then crack B reversed (end→start), then boundary corners from B.start to A.start.
  function cornersBetween(t1, t2) {
    // Collect rectangle corners whose perimeter position is between t1 and t2 (clockwise)
    const result = [];
    for (const c of corners) {
      let tc = perimeterT(c);
      if (t1 < t2) {
        if (tc > t1 && tc < t2) result.push(c);
      } else {
        // Wraps around (t2 < t1)
        if (tc > t1 || tc < t2) result.push(c);
      }
    }
    // Sort by perimeter distance from t1
    result.sort((a, b) => {
      let da = perimeterT(a) - t1; if (da < 0) da += 4;
      let db = perimeterT(b) - t1; if (db < 0) db += 4;
      return da - db;
    });
    return result;
  }

  const polys = [];
  const n = lines.length;

  // First region: boundary from last crack's end → first crack's start + first crack reversed
  {
    const first = crackEndpoints[0];
    const last = crackEndpoints[n - 1];
    const tFrom = last.spine[last.spine.length - 1];
    const tTo = first.spine[0];
    const tFromT = perimeterT(tFrom);
    const tToT = perimeterT(tTo);
    const betweenCorners = cornersBetween(tFromT, tToT);
    polys.push([tFrom, ...betweenCorners, tTo, ...first.spine.slice().reverse(),
      ...last.spine]);
  }

  // Middle regions: between consecutive cracks
  for (let i = 0; i < n - 1; i++) {
    const a = crackEndpoints[i];
    const b = crackEndpoints[i + 1];
    // From A.end → boundary corners → B.end, then B reversed, boundary corners, back to A.start
    const tAend = perimeterT(a.spine[a.spine.length - 1]);
    const tBstart = perimeterT(b.spine[0]);
    const tBend = perimeterT(b.spine[b.spine.length - 1]);
    const tAstart = perimeterT(a.spine[0]);

    const corners1 = cornersBetween(tAend, tBend);
    const corners2 = cornersBetween(tBstart, tAstart);
    polys.push([...a.spine, ...corners1, ...b.spine.slice().reverse(), ...corners2]);
  }

  // Last region: from last crack end → boundary → first crack start + first crack + boundary back
  // Already handled by "first region" above (it wraps around)

  // If only 1 crack, we need a second polygon for the other side
  if (n === 1) {
    const spine = crackEndpoints[0].spine;
    const tStart = perimeterT(spine[0]);
    const tEnd = perimeterT(spine[spine.length - 1]);
    const betweenCorners = cornersBetween(tEnd, tStart);
    polys.push([...spine, ...betweenCorners]);
  }

  return polys;
}

// ── Eternalize → PNG export ───────────────────────────────────────────────────

async function eternalize() {
  const W = 1200, H = 628; // Twitter summary_large_image ratio

  const sw = currentSlab.w;
  const sh = currentSlab.h;
  const dpr = Math.max(window.devicePixelRatio || 1, 2); // at least 2x for sharp text
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr); // all coordinates stay in logical 1200×628 space

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Scale slab to fit, centered (ignoring sx/sy stretch for clean export)
  const scale = (H * 0.78) / Math.max(sw, sh);
  const dw = sw * scale, dh = sh * scale;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;

  // All drawing is in slab-local coordinates via ctx.scale
  ctx.save();
  ctx.translate(dx, dy);
  ctx.scale(scale, scale);
  ctx.clip(new Path2D(currentSlab.path));

  // 1. Marble base
  const imgBase = document.querySelector('.marble-base img');
  if (imgBase) ctx.drawImage(imgBase, 0, 0, sw, sh);

  // 2. Volume layer — rotated, y-flipped, clipped by chip mask
  const imgVol = document.querySelector('.marble-volume img');
  if (imgVol) {
    const vcx = currentSlab._bboxCx;
    const vcy = currentSlab._bboxCy;
    const cs = currentSlab._chipScale;
    const volW = sw * VOL_SCALE, volH = sh * VOL_SCALE;
    const maskX = volW / 2 - vcx * cs;
    const maskY = volH / 2 - vcy * cs;

    ctx.save();
    ctx.translate(vcx, vcy);
    ctx.rotate(currentSlab.volumeAngle * Math.PI / 180);
    ctx.scale(1, -1);
    ctx.translate(-volW / 2, -volH / 2);

    // Clip to chip mask (slab path scaled by chipScale)
    const chipPath = new Path2D();
    chipPath.addPath(new Path2D(currentSlab.path),
      new DOMMatrix().translate(maskX, maskY).scale(cs, cs));
    ctx.clip(chipPath);
    ctx.drawImage(imgVol, 0, 0, volW, volH);

    // Chip edge stroke
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.7;
    ctx.stroke(chipPath);
    ctx.restore();
  }

  // 3. Cracks texture — rotated −60°
  const imgCracks = document.querySelector('.marble-cracks img');
  if (imgCracks) {
    ctx.save();
    ctx.translate(sw / 2, sh / 2);
    ctx.rotate(-60 * Math.PI / 180);
    ctx.globalAlpha = 0.9;
    const crW = sw * 2, crH = sh * 2;
    ctx.drawImage(imgCracks, -crW / 2, -crH / 2, crW, crH);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 4. Crack overlay (backspace damage lines)
  const crackOv = document.getElementById('crack-overlay');
  if (crackOv && crackOv.children.length > 0) {
    for (const svg of crackOv.querySelectorAll('svg')) {
      const svgStr = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([svgStr], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      await new Promise(r => { img.onload = r; img.onerror = r; img.src = url; });
      ctx.drawImage(img, 0, 0, sw, sh);
      URL.revokeObjectURL(url);
    }
  }

  // 5. Veins — multiply blend
  for (const id of ['vein-a', 'vein-b']) {
    const wrap = document.getElementById(id);
    const img = wrap?.querySelector('img');
    if (!wrap || !img) continue;
    const l  = parseFloat(wrap.style.left)   || 0;
    const t  = parseFloat(wrap.style.top)    || 0;
    const vw = parseFloat(wrap.style.width)  || img.naturalWidth;
    const vh = parseFloat(wrap.style.height) || img.naturalHeight;
    const op = parseFloat(getComputedStyle(wrap).opacity) || 1;
    const tf = wrap.style.transform || '';
    const angMatch = tf.match(/rotate\(([^)]+)deg\)/);
    const ang = angMatch ? parseFloat(angMatch[1]) : 0;
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

  // 6. Text — replicate CSS text-shadow carved effect
  const textEl = document.getElementById('carved-text');
  const text = textEl?.innerText.replace(/\n/g, ' ').trim();
  if (text && currentSafe) {
    const fontSize = currentFontSize;
    ctx.font = `${fontSize}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try { ctx.letterSpacing = `${(1.8 * fontSize / BASE_FONT).toFixed(1)}px`; } catch(e) {}

    // CSS uses symmetric padding: max(safeTop, safeBottom) for both sides.
    // This centers text at (slab.w/2, slab.h/2), NOT at currentSafe.cx/cy.
    const textCX = sw / 2;
    const textCY = sh / 2;

    const maxW = currentSafe.w;
    const lineH = fontSize; // CSS line-height: 1
    // Word-wrap
    const words = text.toUpperCase().split(/[\s\u00A0]+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);

    const startY = textCY - ((lines.length - 1) * lineH) / 2;

    // Replicate CSS: text-shadow: 0.5px -0.5px 0.2px #868582, -0.66px -0.5px 0 #F8F9F6;
    // Use CSS drop-shadow filter — behaves identically to text-shadow and
    // is not affected by canvas CTM scaling issues.
    // Match CSS -webkit-font-smoothing: antialiased (thinner strokes on macOS)
    ctx.save();
    ctx.textRendering = 'geometricPrecision';
    ctx.filter = 'drop-shadow(0.5px -0.5px 0.2px #868582) drop-shadow(-0.66px -0.5px 0px #F8F9F6)';
    ctx.fillStyle = '#d3d5cc';
    lines.forEach((ln, i) => ctx.fillText(ln, textCX, startY + i * lineH));
    ctx.filter = 'none';
    ctx.restore();
  }

  ctx.restore(); // end slab clip + scale

  // Slab outline stroke (outside the clip)
  ctx.save();
  ctx.translate(dx, dy);
  ctx.scale(scale, scale);
  ctx.strokeStyle = '#F8F8F6';
  ctx.lineWidth = 1;
  ctx.stroke(new Path2D(currentSlab.path));
  ctx.restore();

  const link = document.createElement('a');
  link.download = 'chisel.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
