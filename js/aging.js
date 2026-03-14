// ── Aging Params ────────────────────────────────────────────────────────────
// Shared aging parameters — extracted to avoid circular dependency
// between app.js and sidebar.js.

export const ageParams = {
  enabled: false,    // aging off by default
  speed: 1.0,       // time multiplier (1 = 60s to full age)
  duration: 60,     // base seconds to reach full age
  idleDelay: 2.0,   // seconds of no typing before aging starts
};
