// ── Deliberation meter ────────────────────────────────────────────────────────
// Tracks typing behavior over rolling windows and produces a 0–1 score:
//   0 = frantic (fast + many mistakes)   1 = steadfast (measured + few mistakes)
//
// Exposed API:
//   recordKeystroke('char' | 'backspace')  — call on every key
//   getDeliberation()   → { score, label, history }
//   resetDeliberation() — clear on intro reset
//   LABELS              — ordered array of label strings

const WINDOW_SIZE   = 10;   // keystrokes per window
const HISTORY_MAX   = 50;   // max windows to keep (for trajectory)
const CHISEL_DELAY  = 375;  // midpoint of DELAY_MIN–DELAY_MAX (250–500ms)

// Ideal inter-key interval: if you're matching the chisel pace, this is "calm".
// Anything faster → anxiety, anything slower → deliberation.
const PACE_TARGET   = CHISEL_DELAY; // ms — typing at chisel speed

const LABELS = ['FRANTIC', 'RESTLESS', 'MEASVRED', 'DELIBERATE', 'STEADFAST'];

let events  = [];     // { time: number, type: 'char' | 'backspace' }[]
let windows = [];     // { score: number }[]  — completed windows

function recordKeystroke(type) {
  events.push({ time: Date.now(), type });

  // When we have enough events, compute a window
  if (events.length >= WINDOW_SIZE) {
    windows.push(computeWindow(events.slice(-WINDOW_SIZE)));
    // Keep events trimmed — only need last window worth for next computation
    if (events.length > WINDOW_SIZE * 2) {
      events = events.slice(-WINDOW_SIZE);
    }
    if (windows.length > HISTORY_MAX) {
      windows = windows.slice(-HISTORY_MAX);
    }
  }
}

function computeWindow(evts) {
  // 1. Backspace ratio (0 = no mistakes, 1 = all backspaces)
  const backspaces = evts.filter(e => e.type === 'backspace').length;
  const bsRatio = backspaces / evts.length;

  // 2. Average inter-key interval
  let totalInterval = 0;
  let intervalCount = 0;
  for (let i = 1; i < evts.length; i++) {
    const gap = evts[i].time - evts[i - 1].time;
    // Cap at 5s to ignore long pauses (thinking, distracted)
    totalInterval += Math.min(gap, 5000);
    intervalCount++;
  }
  const avgInterval = intervalCount > 0 ? totalInterval / intervalCount : PACE_TARGET;

  // 3. Pace score: how close to the chisel pace (or slower)
  //    < PACE_TARGET → rushing (0–0.5), >= PACE_TARGET → calm (0.5–1.0)
  //    Clamp at 2x pace target as maximum deliberation
  let paceScore;
  if (avgInterval >= PACE_TARGET) {
    // At or slower than chisel pace — calm
    paceScore = 0.5 + 0.5 * Math.min((avgInterval - PACE_TARGET) / PACE_TARGET, 1);
  } else {
    // Faster than chisel pace — rushing
    paceScore = 0.5 * (avgInterval / PACE_TARGET);
  }

  // 4. Combine: pace matters most, mistakes penalize
  //    score = paceScore × (1 - bsRatio * 0.8)
  //    A perfect pace with 100% backspaces still scores 0.2 × paceScore
  const score = paceScore * (1 - bsRatio * 0.8);

  return { score: Math.max(0, Math.min(1, score)) };
}

function getDeliberation() {
  // Current score: weighted average of recent windows (more recent = more weight)
  let score = 0.5; // default: measured
  if (windows.length > 0) {
    let weightSum = 0;
    let valueSum = 0;
    const recent = windows.slice(-10); // last 10 windows
    recent.forEach((w, i) => {
      const weight = i + 1; // linear: more recent = heavier
      valueSum += w.score * weight;
      weightSum += weight;
    });
    score = valueSum / weightSum;
  } else if (events.length >= 3) {
    // Not enough for a full window — compute partial
    const partial = computeWindow(events);
    score = partial.score;
  }

  const labelIdx = Math.min(
    LABELS.length - 1,
    Math.floor(score * LABELS.length)
  );

  return {
    score,                                      // 0–1 float
    label: LABELS[labelIdx],                    // current label
    history: windows.map(w => w.score),          // array for sparkline/trajectory
    trajectory: getTrajectory()                  // e.g. "RESTLESS → DELIBERATE"
  };
}

function getTrajectory() {
  if (windows.length < 2) return null;

  // First quarter vs last quarter
  const q = Math.max(1, Math.floor(windows.length / 4));
  const firstAvg = windows.slice(0, q).reduce((s, w) => s + w.score, 0) / q;
  const lastAvg  = windows.slice(-q).reduce((s, w) => s + w.score, 0) / q;

  const labelFor = (s) => LABELS[Math.min(LABELS.length - 1, Math.floor(s * LABELS.length))];
  const startLabel = labelFor(firstAvg);
  const endLabel   = labelFor(lastAvg);

  if (startLabel === endLabel) return startLabel;
  return `${startLabel} → ${endLabel}`;
}

function resetDeliberation() {
  events  = [];
  windows = [];
}

export { recordKeystroke, getDeliberation, resetDeliberation, LABELS };
