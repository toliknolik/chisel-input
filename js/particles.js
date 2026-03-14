// ── WebGL Particle System ────────────────────────────────────────────────────
// GL_POINTS rendered in the shared cloud WebGL context.
// Two emitters: chisel dust (per keystroke) and crumble (on destroy).
// Soft-edged stone chips via fragment shader smoothstep.

import { getCloudGL, requestRender, registerParticleRenderer, onGLResize } from './cloud.js';

// ── Tunable parameters (read by sidebar) ─────────────────────────────────────
export const particleParams = {
  // Physics
  gravity:   0.45,
  drag:      0.98,
  // Chisel dust
  dustMin:   16,
  dustMax:   30,
  dustSize:  3.2,       // base size ± random
  dustAlpha: 0.60,
  dustDecay: 0.022,
  dustVx:    3.7,       // horizontal spread
  dustVy:    4.7,       // upward burst
  // Crumble — large chunks (few big pieces)
  chunkCount: 18,
  chunkSize:  10.0,
  chunkAlpha: 0.85,
  chunkDecay: 0.005,
  // Crumble — fragments (medium pieces)
  fragCount: 140,
  fragSize:  4.5,
  fragAlpha: 0.8,
  fragDecay: 0.008,
  // Crumble — chips (small debris)
  chipCount: 220,
  chipSize:  2.0,
  chipAlpha: 0.5,
  chipDecay: 0.010,
};

const STONE_COLORS = [
  [0.91, 0.89, 0.87], // #E8E2DE
  [0.85, 0.83, 0.81], // #D8D3CE
  [0.78, 0.76, 0.75], // #C8C3BE
  [0.72, 0.70, 0.68], // #B8B3AE
  [0.66, 0.64, 0.62], // #A8A39E
  [0.60, 0.58, 0.56], // #98938E
  [0.54, 0.52, 0.50], // #8A857F
  [0.76, 0.72, 0.67], // #C2B8AC
  [0.71, 0.67, 0.61], // #B5AA9C
];

// ── Shaders ──────────────────────────────────────────────────────────────────

const P_VERT = `
attribute vec2 a_position;
attribute float a_size;
attribute float a_rotation;
attribute vec3 a_color;
attribute float a_alpha;
attribute float a_shape;

uniform vec2 uResolution;
uniform float uZoom;

varying vec3 vColor;
varying float vAlpha;
varying float vRotation;
varying float vShape;

void main() {
  // Pixel position → clip space
  vec2 clip = (a_position / uResolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = a_size * uZoom;
  vColor = a_color;
  vAlpha = a_alpha;
  vRotation = a_rotation;
  vShape = a_shape;
}
`;

const P_FRAG = `
precision mediump float;

varying vec3 vColor;
varying float vAlpha;
varying float vRotation;
varying float vShape;

void main() {
  // Rotate gl_PointCoord around center
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRotation), s = sin(vRotation);
  vec2 ruv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

  // Skew UV for asymmetry (each particle gets unique skew via rotation)
  vec2 sk = ruv + vec2(ruv.y * 0.2, 0.0);

  float dist;
  if (vShape < 0.25) {
    // Acute shard — pointy asymmetric triangle
    dist = max(sk.x * 1.2 + sk.y * 1.8, max(-sk.x * 1.5 + sk.y * 0.8, -sk.y * 1.6)) - 0.35;
  } else if (vShape < 0.5) {
    // Thin splinter — very elongated
    dist = max(abs(sk.x) - 0.08, abs(sk.y) - 0.44);
  } else if (vShape < 0.75) {
    // Skewed trapezoid — broken chip
    float taper = sk.y * 0.3;
    dist = max(abs(sk.x + taper) - 0.28, abs(sk.y) - 0.32);
  } else {
    // Jagged fragment — irregular angular shape
    vec2 p = abs(sk);
    dist = max(p.x * 0.7 + p.y * 0.95 - 0.33,
               max(p.x - 0.22, p.y * 0.6 + p.x * 0.5 - 0.3));
  }

  // Sharp edge — no soft blur that makes things look circular
  float shapeAlpha = 1.0 - smoothstep(-0.01, 0.02, dist);
  if (shapeAlpha < 0.01) discard;

  gl_FragColor = vec4(vColor, shapeAlpha * vAlpha);
}
`;

// ── GL State ─────────────────────────────────────────────────────────────────

let gl = null;
let pProgram = null;
let pBuffer = null;
let uResLoc = null;
let uZoomLoc = null;

// Cached attribute locations
let aPositionLoc = -1;
let aSizeLoc = -1;
let aRotationLoc = -1;
let aColorLoc = -1;
let aAlphaLoc = -1;
let aShapeLoc = -1;

// Attribute layout: position(2) + size(1) + rotation(1) + color(3) + alpha(1) + shape(1) = 9 floats
const FLOATS_PER = 9;
const STRIDE = FLOATS_PER * 4;

let particles = [];
let slabRef = null;      // current slab dimensions
let slabEl = null;       // slab DOM element

// ── Public API ───────────────────────────────────────────────────────────────

export function initParticles() {
  const ctx = getCloudGL();
  gl = ctx.gl;
  if (!gl) return;

  slabEl = document.getElementById('slab');
  compileShader();
  registerParticleRenderer(renderParticles);
  onGLResize(handleResize);
}

export function resizeParticles(slab) {
  slabRef = slab;
}

// Chisel dust: small chips at (x, y) in slab-local coordinates
export function emitChiselDust(x, y) {
  const pp = particleParams;
  const count = pp.dustMin + Math.floor(Math.random() * (pp.dustMax - pp.dustMin + 1));
  for (let i = 0; i < count; i++) {
    particles.push(makeParticle(
      x, y,
      (Math.random() - 0.5) * pp.dustVx,
      -Math.random() * pp.dustVy - 0.5,
      pp.dustSize * (0.6 + Math.random() * 0.8),
      pp.dustAlpha * (0.8 + Math.random() * 0.4),
      pp.dustDecay * (0.8 + Math.random() * 0.6),
    ));
  }
  requestRender();
}

// Crumble: falling stone fragments with power-law size distribution
export function emitCrumble(slab) {
  const pp = particleParams;
  const cx = slab.w / 2;
  const cy = slab.h / 2;

  // Helper: radial burst velocity from slab center
  function burstVelocity(x, y, strength) {
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / dist, ny = dy / dist;
    const force = strength * (0.5 + Math.random() * 0.8);
    return {
      vx: nx * force + (Math.random() - 0.5) * strength * 0.4,
      vy: ny * force + (Math.random() - 0.5) * strength * 0.3 - Math.random() * 1.5,
    };
  }

  // Large chunks — few heavy pieces that tumble outward
  for (let i = 0; i < pp.chunkCount; i++) {
    const fx = slab.w * (0.15 + Math.random() * 0.7);
    const fy = slab.h * (0.15 + Math.random() * 0.7);
    const { vx, vy } = burstVelocity(fx, fy, 3.5);
    const p = makeParticle(
      fx, fy, vx, vy,
      pp.chunkSize * (0.6 + Math.random() * 0.8),
      pp.chunkAlpha * (0.8 + Math.random() * 0.3),
      pp.chunkDecay * (0.7 + Math.random() * 0.6),
    );
    // Chunks prefer pentagon/rect shapes (bigger look)
    p.shape = Math.random() < 0.6 ? 0.85 : 0.35;
    p.vr = (Math.random() - 0.5) * 0.15; // slow tumble
    particles.push(p);
  }

  // Medium fragments — burst outward from center
  for (let i = 0; i < pp.fragCount; i++) {
    const fx = Math.random() * slab.w;
    const fy = Math.random() * slab.h;
    const { vx, vy } = burstVelocity(fx, fy, 2.5);
    particles.push(makeParticle(
      fx, fy, vx, vy,
      pp.fragSize * (0.4 + Math.random() * 1.2),
      pp.fragAlpha * (0.7 + Math.random() * 0.5),
      pp.fragDecay * (0.7 + Math.random() * 0.7),
    ));
  }

  // Small chips — fast scatter, more horizontal spread
  for (let i = 0; i < pp.chipCount; i++) {
    const fx = Math.random() * slab.w;
    const fy = Math.random() * slab.h;
    const { vx, vy } = burstVelocity(fx, fy, 1.8);
    const p = makeParticle(
      fx, fy,
      vx + (Math.random() - 0.5) * 2,
      vy,
      pp.chipSize * (0.6 + Math.random() * 0.8),
      pp.chipAlpha * (0.6 + Math.random() * 0.8),
      pp.chipDecay * (0.6 + Math.random() * 0.8),
    );
    // Chips prefer splinter/triangle shapes
    p.shape = Math.random() < 0.5 ? 0.6 : Math.random() * 0.25;
    particles.push(p);
  }

  requestRender();
}

export function emitFractureDust(spines) {
  const pp = particleParams;
  // Emit dust along each crack spine with a staggered delay
  for (let si = 0; si < spines.length; si++) {
    const spine = spines[si];
    const delay = si * 150; // stagger per spine

    setTimeout(() => {
      // Walk along spine, emit particles at intervals
      for (let i = 0; i < spine.length - 1; i++) {
        const [x1, y1] = spine[i];
        const [x2, y2] = spine[i + 1];
        const segLen = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        const steps = Math.max(2, Math.floor(segLen / 8)); // particle every ~8px

        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const px = x1 + (x2 - x1) * t + (Math.random() - 0.5) * 6;
          const py = y1 + (y2 - y1) * t + (Math.random() - 0.5) * 6;

          // Perpendicular burst away from crack line
          const dx = x2 - x1, dy = y2 - y1;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = -dy / len, ny = dx / len;
          const side = Math.random() < 0.5 ? 1 : -1;
          const burst = 1.5 + Math.random() * 2.5;

          const p = makeParticle(
            px, py,
            nx * side * burst + (Math.random() - 0.5) * 1.5,
            ny * side * burst - Math.random() * 1.5, // slight upward bias
            pp.chipSize * (0.8 + Math.random() * 1.2),
            pp.chipAlpha * (0.6 + Math.random() * 0.4),
            pp.chipDecay * 1.2,
          );
          particles.push(p);
        }
      }
      requestRender();
    }, delay);
  }
}

export function clearParticles() {
  particles.length = 0;
}

// Test burst — emits chisel dust at slab center for visual tuning
export function testParticles() {
  const sw = slabRef ? slabRef.w : 300;
  const sh = slabRef ? slabRef.h : 400;
  emitChiselDust(sw / 2, sh / 2);
}

// ── Internal ─────────────────────────────────────────────────────────────────

function makeParticle(x, y, vx, vy, size, alpha, decay) {
  return {
    x, y, vx, vy, size, alpha, decay,
    rotation: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.3,
    life: 1.0,
    color: STONE_COLORS[Math.floor(Math.random() * STONE_COLORS.length)],
    shape: Math.random(), // 0-.25 triangle, .25-.5 rect, .5-.75 splinter, .75-1 pentagon
  };
}

function compileShader() {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, P_VERT);
  gl.compileShader(vs);

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, P_FRAG);
  gl.compileShader(fs);

  pProgram = gl.createProgram();
  gl.attachShader(pProgram, vs);
  gl.attachShader(pProgram, fs);
  gl.linkProgram(pProgram);

  pBuffer = gl.createBuffer();
  uResLoc = gl.getUniformLocation(pProgram, 'uResolution');
  uZoomLoc = gl.getUniformLocation(pProgram, 'uZoom');

  // Cache attribute locations
  aPositionLoc = gl.getAttribLocation(pProgram, 'a_position');
  aSizeLoc     = gl.getAttribLocation(pProgram, 'a_size');
  aRotationLoc = gl.getAttribLocation(pProgram, 'a_rotation');
  aColorLoc    = gl.getAttribLocation(pProgram, 'a_color');
  aAlphaLoc    = gl.getAttribLocation(pProgram, 'a_alpha');
  aShapeLoc    = gl.getAttribLocation(pProgram, 'a_shape');
}

function handleResize(newGL) {
  gl = newGL;
  compileShader();
}

// Called each frame by cloud.js tick(). Returns true if more frames are needed.
function renderParticles(glCtx, now) {
  if (particles.length === 0) return false;
  if (!pProgram || !slabEl) return false;

  // Slab position in viewport (accounts for scene zoom, transforms)
  const rect = slabEl.getBoundingClientRect();
  const sw = slabRef ? slabRef.w : rect.width;
  const sh = slabRef ? slabRef.h : rect.height;
  const zoom = rect.width / sw;

  // Update physics & build vertex data
  const data = new Float32Array(particles.length * FLOATS_PER);
  let alive = 0;

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];

    p.vy += particleParams.gravity;
    p.vx *= particleParams.drag;
    p.vy *= particleParams.drag;
    p.x += p.vx;
    p.y += p.vy;
    p.rotation += p.vr;
    p.life -= p.decay;

    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }

    // Slab-local → viewport pixels
    const vpx = rect.left + (p.x / sw) * rect.width;
    const vpy = rect.top  + (p.y / sh) * rect.height;

    const off = alive * FLOATS_PER;
    data[off + 0] = vpx;
    data[off + 1] = vpy;
    data[off + 2] = p.size;
    data[off + 3] = p.rotation;
    data[off + 4] = p.color[0];
    data[off + 5] = p.color[1];
    data[off + 6] = p.color[2];
    data[off + 7] = p.life * p.alpha;
    data[off + 8] = p.shape;
    alive++;
  }

  if (alive === 0) return false;

  const c = getCloudGL().canvas;

  // ── Draw ────────────────────────────────────────────────────────────────────
  glCtx.useProgram(pProgram);
  glCtx.bindBuffer(glCtx.ARRAY_BUFFER, pBuffer);
  glCtx.bufferData(glCtx.ARRAY_BUFFER, data.subarray(0, alive * FLOATS_PER), glCtx.DYNAMIC_DRAW);

  glCtx.enableVertexAttribArray(aPositionLoc);
  glCtx.vertexAttribPointer(aPositionLoc, 2, glCtx.FLOAT, false, STRIDE, 0);
  glCtx.enableVertexAttribArray(aSizeLoc);
  glCtx.vertexAttribPointer(aSizeLoc, 1, glCtx.FLOAT, false, STRIDE, 8);
  glCtx.enableVertexAttribArray(aRotationLoc);
  glCtx.vertexAttribPointer(aRotationLoc, 1, glCtx.FLOAT, false, STRIDE, 12);
  glCtx.enableVertexAttribArray(aColorLoc);
  glCtx.vertexAttribPointer(aColorLoc, 3, glCtx.FLOAT, false, STRIDE, 16);
  glCtx.enableVertexAttribArray(aAlphaLoc);
  glCtx.vertexAttribPointer(aAlphaLoc, 1, glCtx.FLOAT, false, STRIDE, 28);
  glCtx.enableVertexAttribArray(aShapeLoc);
  glCtx.vertexAttribPointer(aShapeLoc, 1, glCtx.FLOAT, false, STRIDE, 32);

  glCtx.uniform2f(uResLoc, c.width, c.height);
  glCtx.uniform1f(uZoomLoc, zoom);
  glCtx.drawArrays(glCtx.POINTS, 0, alive);

  return particles.length > 0;
}
