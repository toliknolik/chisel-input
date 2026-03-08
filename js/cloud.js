// ── WebGL Dust Cloud ──────────────────────────────────────────────────────────
// FBM noise-based cloud overlay for the destroy → reveal transition.
// Cloud radiates outward from the slab center.
// Also serves as the shared GL context for the particle system (particles.js).

// ── Tunable parameters (read by sidebar) ─────────────────────────────────────
export const cloudParams = {
  // Envelope
  peakDensity: 0.48,
  maxRadius:   2.0,
  rampTime:    0.4,
  holdTime:    0.3,
  fadeTime:    1.5,
  // Shader
  threshLow:   0.18,
  threshHigh:  0.50,
  warpSpeed:   0.04,
  coreRadius:  0.31,
  colorR:      0.91,
  colorG:      0.89,
  colorB:      0.86,
};

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform float uTime;
uniform float uDensity;
uniform float uRadius;
uniform vec2  uResolution;
uniform vec2  uCenter;
uniform float uThreshLow;
uniform float uThreshHigh;
uniform float uWarpSpeed;
uniform vec3  uColor;
uniform float uCoreRadius;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float f = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) {
    f += amp * noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return f;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Distance from slab center (in UV space)
  vec2 center = uCenter / uResolution;
  float dist = length(uv - center);

  // Radial mask — cloud expands outward from center
  float innerR = uRadius * 0.4;
  float radial = 1.0 - smoothstep(innerR, max(innerR + 0.001, uRadius), dist);

  // Two layers of warped FBM for organic shape
  vec2 dir = normalize(uv - center + vec2(0.001));
  vec2 warpUV = uv - dir * uTime * uWarpSpeed;
  float n1 = fbm(warpUV * 4.0);
  float n2 = fbm(warpUV * 3.0 + n1 * 0.8);

  // Cloud shape — threshold controls coverage
  float cloud = smoothstep(uThreshLow, uThreshHigh, n2);

  // Solid core — near center, blend toward full coverage to hide slab swap
  float core = smoothstep(uCoreRadius, uCoreRadius * 0.3, dist);
  cloud = mix(cloud, 1.0, core);

  float alpha = cloud * radial * uDensity;
  gl_FragColor = vec4(uColor, alpha);
}
`;

let canvas, gl, program, cloudBuf;
let uTimeLoc, uDensityLoc, uResolutionLoc, uCenterLoc, uRadiusLoc;
let uThreshLowLoc, uThreshHighLoc, uWarpSpeedLoc, uColorLoc, uCoreRadiusLoc;
let animId = null;
let hideTimer = null;
let startTime = 0;      // reset per-phase for density/radius envelope
let shaderTime0 = 0;    // set once at crumble start — never reset, drives uTime
let phase = 'idle';     // 'idle' | 'crumble' | 'reveal' | 'settle'
let density = 0;
let radius = 0;

// ── Particle renderer coordination ───────────────────────────────────────────
let particleRenderer = null;   // fn(gl, now) → returns true if more frames needed
let resizeCallbacks = [];      // called after GL context reset (canvas resize)

export function getCloudGL() {
  return { gl, canvas };
}

// Ensure the RAF loop is running (used by particles when cloud is idle)
export function requestRender() {
  ensureLoop();
}

// Register per-frame particle render callback. Returns true → keep looping.
export function registerParticleRenderer(fn) {
  particleRenderer = fn;
}

// Register callback for GL context resets (canvas resize resets everything)
export function onGLResize(fn) {
  resizeCallbacks.push(fn);
}

// Setup / re-setup all WebGL state.  Called after every canvas resize
// because changing canvas.width/height resets the entire GL context.
function setupGL() {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, VERT);
  gl.compileShader(vs);

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, FRAG);
  gl.compileShader(fs);

  program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  cloudBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  uTimeLoc       = gl.getUniformLocation(program, 'uTime');
  uDensityLoc    = gl.getUniformLocation(program, 'uDensity');
  uRadiusLoc     = gl.getUniformLocation(program, 'uRadius');
  uResolutionLoc = gl.getUniformLocation(program, 'uResolution');
  uCenterLoc     = gl.getUniformLocation(program, 'uCenter');
  uThreshLowLoc  = gl.getUniformLocation(program, 'uThreshLow');
  uThreshHighLoc = gl.getUniformLocation(program, 'uThreshHigh');
  uWarpSpeedLoc  = gl.getUniformLocation(program, 'uWarpSpeed');
  uColorLoc      = gl.getUniformLocation(program, 'uColor');
  uCoreRadiusLoc = gl.getUniformLocation(program, 'uCoreRadius');

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Notify particle system (and any other listeners) to re-setup GL state
  for (const cb of resizeCallbacks) cb(gl);
}

function applyResize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  setupGL();
}

export function initCloud() {
  canvas = document.getElementById('cloud');
  gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) return;
  applyResize();
  window.addEventListener('resize', () => { if (gl) applyResize(); });
}

export function resizeCloud() {
  // no-op — cloud is viewport-sized, independent of slab
}

// Called when [start again] is clicked
export function triggerCrumbleCloud() {
  phase = 'crumble';
  density = 0;
  radius = 0;
  startTime = performance.now();
  shaderTime0 = startTime;
  if (hideTimer) clearTimeout(hideTimer);
  ensureLoop();
}

// Called after shatter animation ends — dense cloud to hide new slab
export function triggerRevealCloud() {
  phase = 'reveal';
  density = cloudParams.peakDensity;
  radius = cloudParams.maxRadius;
  ensureLoop();
  // Fallback: guarantee the cloud hides even if RAF is throttled
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { phase = 'idle'; density = 0; }, 3000);
}

// Test trigger — plays the full crumble→settle cycle without slab destruction
export function testCloud() {
  phase = 'crumble';
  density = 0;
  radius = 0;
  startTime = performance.now();
  shaderTime0 = startTime;
  if (hideTimer) clearTimeout(hideTimer);
  ensureLoop();
  // Simulate the reveal trigger after rampTime
  const rampMs = cloudParams.rampTime * 1000;
  setTimeout(() => {
    if (phase === 'crumble') {
      phase = 'reveal';
      density = cloudParams.peakDensity;
      radius = cloudParams.maxRadius;
    }
  }, rampMs);
}

function goIdle() {
  phase = 'idle';
  density = 0;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  // Don't stop the loop — particles may still need frames.
  // tick() will stop when both cloud and particles are idle.
}

function ensureLoop() {
  if (!animId) animId = requestAnimationFrame(tick);
}

function tick(now) {
  if (!gl) { animId = null; return; }

  const cloudActive = phase !== 'idle';
  let particlesActive = false;

  // ── Cloud envelope ──────────────────────────────────────────────────────────
  if (cloudActive) {
    const p = cloudParams;
    const elapsed = (now - startTime) / 1000;

    if (phase === 'crumble') {
      density = Math.min(p.peakDensity, elapsed / p.rampTime * p.peakDensity);
      radius = Math.min(p.maxRadius, elapsed / p.rampTime * p.maxRadius);
    } else if (phase === 'reveal') {
      density = p.peakDensity;
      radius = p.maxRadius;
      phase = 'settle';
      startTime = now;
    } else if (phase === 'settle') {
      const t = (now - startTime) / 1000;
      if (t < p.holdTime) {
        density = p.peakDensity;
      } else {
        const fadeT = (t - p.holdTime) / p.fadeTime;
        density = Math.max(0, p.peakDensity * (1.0 - fadeT * fadeT));
      }
      radius = p.maxRadius;
      if (density <= 0) {
        goIdle();
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Cloud pass
  if (phase !== 'idle') {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuf);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const shaderElapsed = (now - shaderTime0) / 1000;
    const p = cloudParams;
    gl.uniform1f(uTimeLoc, shaderElapsed);
    gl.uniform1f(uDensityLoc, density);
    gl.uniform1f(uRadiusLoc, radius);
    gl.uniform2f(uResolutionLoc, canvas.width, canvas.height);
    gl.uniform2f(uCenterLoc, canvas.width / 2, canvas.height / 2);
    gl.uniform1f(uThreshLowLoc, p.threshLow);
    gl.uniform1f(uThreshHighLoc, p.threshHigh);
    gl.uniform1f(uWarpSpeedLoc, p.warpSpeed);
    gl.uniform3f(uColorLoc, p.colorR, p.colorG, p.colorB);
    gl.uniform1f(uCoreRadiusLoc, p.coreRadius);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Particle pass
  if (particleRenderer) {
    particlesActive = particleRenderer(gl, now);
  }

  // Continue loop if either system needs frames
  if (phase !== 'idle' || particlesActive) {
    animId = requestAnimationFrame(tick);
  } else {
    animId = null;
  }
}
