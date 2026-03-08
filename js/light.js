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

// Update callback — set by app.js once it defines updateLighting().
// This breaks the circular dependency: sidebar → light.js ← app.js
let _updateFn = null;

export function setUpdateLighting(fn) { _updateFn = fn; }

export function updateLighting() { if (_updateFn) _updateFn(); }
