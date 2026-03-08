// ── Surface Lighting Params ──────────────────────────────────────────────────
// Tunable parameters for the SVG feDiffuseLighting / feSpecularLighting layer.
// Read by sidebar, applied by updateLighting() in app.js.

export const lightParams = {
  baseFrequency:    0.045,
  numOctaves:       3,
  diffuseSurface:   1.5,
  diffuseConstant:  0.8,
  specSurface:      1.0,
  specConstant:     0.4,
  specExponent:     20,
  azimuth:          225,
  elevation:        45,
  opacity:          0.35,
  blendMode:        'soft-light',
};

// ── Dappled Light Params ─────────────────────────────────────────────────────
// FBM noise-based dappled light with OKLab-inspired color grading.
// Rendered on a WebGL canvas inside #slab, composited via CSS blend mode.

export const rayParams = {
  intensity:  0.25,       // overall alpha (0 = off)
  speed:      0.3,        // animation speed multiplier
  blendMode:  'normal',
  // Dappled noise
  noiseScale:    3.0,     // patch size (lower = larger patches)
  octaves:       4,       // FBM detail (1-6)
  driftSpeed:    0.08,    // slow animation drift
  contrast:      1.5,     // shadow/highlight separation
  // Color grading
  warmth:        0.5,     // tint intensity (0 = monochrome, 1 = full)
  shadowR: 0.78, shadowG: 0.68, shadowB: 0.48,         // warm amber shadow
  highlightR: 0.85, highlightG: 0.87, highlightB: 0.92, // cool white highlight
};


// Update callback — set by app.js once it defines updateLighting().
// This breaks the circular dependency: sidebar → light.js ← app.js
let _updateFn = null;

export function setUpdateLighting(fn) { _updateFn = fn; }

export function updateLighting() { if (_updateFn) _updateFn(); }
