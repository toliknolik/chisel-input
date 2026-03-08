// ── Surface Lighting Params ──────────────────────────────────────────────────
// Tunable parameters for the SVG feDiffuseLighting / feSpecularLighting layer.
// Read by sidebar, applied by updateLighting() in app.js.

export const lightParams = {
  baseFrequency:    0.045,
  numOctaves:       3,
  diffuseSurface:   2.0,
  diffuseConstant:  1.0,
  specSurface:      1.5,
  specConstant:     0.5,
  specExponent:     25,
  azimuth:          225,
  elevation:        40,
  opacity:          0.5,
  blendMode:        'soft-light',
};

// Update callback — set by app.js once it defines updateLighting().
// This breaks the circular dependency: sidebar → light.js ← app.js
let _updateFn = null;

export function setUpdateLighting(fn) { _updateFn = fn; }

export function updateLighting() { if (_updateFn) _updateFn(); }
