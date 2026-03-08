// ── Dappled Light Overlay ─────────────────────────────────────────────────────
// FBM noise-based dappled light with OKLab-inspired color grading.
// Renders organic shadow/highlight patches on a WebGL canvas inside the slab.
//
// Compositing strategy: on near-white marble, bright overlays are invisible.
// Instead we render warm SHADOWS in dappled patches (normal blend, semi-transparent
// tinted color). Where light hits → transparent → clean marble. Shadow patches →
// semi-opaque warm tint → subtle darkening with color depth.
// Inspired by farayan.me/garden — dappled light through foliage with OKLab grading.

import { rayParams } from './light.js';

// ── Shaders ──────────────────────────────────────────────────────────────────

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;

uniform float uTime;
uniform vec2  uResolution;
uniform float uIntensity;
uniform float uSpeed;
uniform float uNoiseScale;
uniform float uOctaves;
uniform float uDriftSpeed;
uniform float uContrast;
uniform float uWarmth;
uniform vec3  uShadowColor;
uniform vec3  uHighlightColor;

// ── Hash + value noise ──────────────────────────────────────────────────────
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
  for (int i = 0; i < 6; i++) {
    if (float(i) >= uOctaves) break;
    f += amp * noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return f;
}

// ── Wind noise (from garden project) ────────────────────────────────────────
// Layered sinusoidal with irrational frequency ratios — never repeats.
float windNoise(float t, float seed) {
  float n  = sin(t * 1.0 + seed);
  n += 0.7 * sin(t * 0.7071 + seed * 1.3);
  n += 0.5 * cos(t * 0.4533 + seed * 2.1);
  n += 0.3 * sin(t * 0.2347 + seed * 3.7);
  return n / 2.5;
}

// ── Main ────────────────────────────────────────────────────────────────────
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  // Wind-modulated drift — shadows sway and breathe instead of constant slide
  float t = uTime * uSpeed;
  float wx = windNoise(t * 0.6, 0.0);
  float wy = windNoise(t * 0.5, 3.7);
  vec2 drift = vec2(0.7 + wx * 0.3, 0.5 + wy * 0.3) * t * uDriftSpeed;

  // Domain warping — warp UVs with a noise layer for organic caustic shapes
  vec2 baseUV = uv * uNoiseScale;
  vec2 warp = vec2(
    noise(baseUV + drift + vec2(0.0, 0.0)),
    noise(baseUV + drift + vec2(3.1, 7.3))
  ) * 0.8;

  // Two warped FBM layers at different scales for irregularity
  float n1 = fbm(baseUV + warp + drift);
  float n2 = fbm((uv * 1.3 + vec2(5.2, 1.3)) * uNoiseScale * 0.8 + warp * 0.6 + drift * 0.7);

  // Blend layers — irregular caustic-like patches
  float pattern = n1 * 0.6 + n2 * 0.4;

  // Contrast shaping — push toward shadow or highlight
  float brightness = clamp((pattern - 0.3) * uContrast, 0.0, 1.0);

  // Shadow falloff (squared for soft edges, same strategy as before)
  float shadowWeight = 1.0 - brightness;
  shadowWeight *= shadowWeight;

  // Region-aware blending — midtones get less tinting than extremes
  float regionWeight = 1.0 - 2.0 * abs(brightness - 0.5);
  regionWeight = 1.0 - regionWeight * (1.0 - uWarmth);

  // Color tint: lerp between shadow and highlight color based on brightness
  vec3 tint = mix(uShadowColor, uHighlightColor, brightness);

  // Final alpha — shadows more opaque, highlights nearly transparent
  float alpha = shadowWeight * uIntensity * regionWeight;

  gl_FragColor = vec4(tint, alpha);
}
`;

// ── GL State ─────────────────────────────────────────────────────────────────

let canvas = null;
let gl     = null;
let prog   = null;
let quadBuf = null;
let uTimeLoc, uResLoc, uIntensityLoc, uSpeedLoc;
let uNoiseScaleLoc, uOctavesLoc, uDriftSpeedLoc, uContrastLoc;
let uWarmthLoc, uShadowColorLoc, uHighlightColorLoc;
let animId  = null;
let startTime = 0;
const RES_SCALE = 0.5; // render at half resolution for performance

// ── Public API ───────────────────────────────────────────────────────────────

export function initRays() {
  canvas = document.getElementById('rays');
  if (!canvas) return;

  gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) return;

  compileShader();
  startTime = performance.now();
  applyBlendMode();

  if (rayParams.intensity > 0) ensureLoop();
}

export function resizeRays(slab) {
  if (!canvas || !gl) return;
  canvas.width  = Math.round(slab.w * RES_SCALE);
  canvas.height = Math.round(slab.h * RES_SCALE);
  compileShader();
}

// Called when sidebar changes ray params
export function updateRays() {
  if (!canvas) return;
  applyBlendMode();
  if (rayParams.intensity > 0) {
    ensureLoop();
  }
}

// ── Internal ─────────────────────────────────────────────────────────────────

function applyBlendMode() {
  if (canvas) canvas.style.mixBlendMode = rayParams.blendMode;
}

function compileShader() {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, VERT);
  gl.compileShader(vs);

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, FRAG);
  gl.compileShader(fs);

  prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  uTimeLoc           = gl.getUniformLocation(prog, 'uTime');
  uResLoc            = gl.getUniformLocation(prog, 'uResolution');
  uIntensityLoc      = gl.getUniformLocation(prog, 'uIntensity');
  uSpeedLoc          = gl.getUniformLocation(prog, 'uSpeed');
  uNoiseScaleLoc     = gl.getUniformLocation(prog, 'uNoiseScale');
  uOctavesLoc        = gl.getUniformLocation(prog, 'uOctaves');
  uDriftSpeedLoc     = gl.getUniformLocation(prog, 'uDriftSpeed');
  uContrastLoc       = gl.getUniformLocation(prog, 'uContrast');
  uWarmthLoc         = gl.getUniformLocation(prog, 'uWarmth');
  uShadowColorLoc    = gl.getUniformLocation(prog, 'uShadowColor');
  uHighlightColorLoc = gl.getUniformLocation(prog, 'uHighlightColor');

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
}

function ensureLoop() {
  if (!animId) animId = requestAnimationFrame(tick);
}

function tick(now) {
  if (!gl) { animId = null; return; }

  // Stop loop if intensity is 0
  if (rayParams.intensity <= 0) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    animId = null;
    return;
  }

  const t = (now - startTime) / 1000;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.uniform1f(uTimeLoc, t);
  gl.uniform2f(uResLoc, canvas.width, canvas.height);
  gl.uniform1f(uIntensityLoc, rayParams.intensity);
  gl.uniform1f(uSpeedLoc, rayParams.speed);
  gl.uniform1f(uNoiseScaleLoc, rayParams.noiseScale);
  gl.uniform1f(uOctavesLoc, rayParams.octaves);
  gl.uniform1f(uDriftSpeedLoc, rayParams.driftSpeed);
  gl.uniform1f(uContrastLoc, rayParams.contrast);
  gl.uniform1f(uWarmthLoc, rayParams.warmth);
  gl.uniform3f(uShadowColorLoc, rayParams.shadowR, rayParams.shadowG, rayParams.shadowB);
  gl.uniform3f(uHighlightColorLoc, rayParams.highlightR, rayParams.highlightG, rayParams.highlightB);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  animId = requestAnimationFrame(tick);
}
