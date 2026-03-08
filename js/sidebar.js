// ── Tuning Sidebar ───────────────────────────────────────────────────────────
// Dev sidebar for live-tuning cloud + particle + lighting params.
// Toggle with Ctrl+O / Cmd+O.

import { cloudParams, testCloud } from './cloud.js';
import { particleParams, testParticles } from './particles.js';
import { lightParams, updateLighting } from './light.js';

const GROUPS = [
  {
    group: 'Cloud',
    params: cloudParams,
    controls: [
      { section: 'Envelope' },
      { id: 'peakDensity', label: 'Peak Density', min: 0, max: 1, step: 0.01 },
      { id: 'maxRadius',   label: 'Max Radius',   min: 0.1, max: 5, step: 0.1 },
      { id: 'rampTime',    label: 'Ramp Time',    min: 0.05, max: 2, step: 0.05, unit: 's' },
      { id: 'holdTime',    label: 'Hold Time',    min: 0, max: 2, step: 0.05, unit: 's' },
      { id: 'fadeTime',    label: 'Fade Time',    min: 0.2, max: 5, step: 0.1, unit: 's' },
      { section: 'Shader' },
      { id: 'threshLow',   label: 'Thresh Low',   min: 0, max: 0.5, step: 0.01 },
      { id: 'threshHigh',  label: 'Thresh High',  min: 0.1, max: 1, step: 0.01 },
      { id: 'warpSpeed',   label: 'Warp Speed',   min: 0, max: 0.3, step: 0.005 },
      { id: 'coreRadius',  label: 'Core Radius',  min: 0, max: 0.4, step: 0.01 },
      { section: 'Color' },
      { id: 'colorR', label: 'Red',   min: 0, max: 1, step: 0.01 },
      { id: 'colorG', label: 'Green', min: 0, max: 1, step: 0.01 },
      { id: 'colorB', label: 'Blue',  min: 0, max: 1, step: 0.01 },
    ],
    actions: [{ id: 'sb-test-cloud', label: 'Test Cloud', handler: testCloud }],
  },
  {
    group: 'Particles',
    params: particleParams,
    controls: [
      { section: 'Physics' },
      { id: 'gravity',   label: 'Gravity',   min: 0, max: 0.5, step: 0.01 },
      { id: 'drag',      label: 'Drag',      min: 0.9, max: 1, step: 0.005 },
      { section: 'Chisel Dust' },
      { id: 'dustMin',   label: 'Min Count',  min: 1, max: 20, step: 1 },
      { id: 'dustMax',   label: 'Max Count',  min: 1, max: 30, step: 1 },
      { id: 'dustSize',  label: 'Size',       min: 0.5, max: 8, step: 0.1 },
      { id: 'dustAlpha', label: 'Alpha',      min: 0.1, max: 1, step: 0.05 },
      { id: 'dustDecay', label: 'Decay',      min: 0.005, max: 0.06, step: 0.001 },
      { id: 'dustVx',    label: 'H-Spread',   min: 0.5, max: 8, step: 0.1 },
      { id: 'dustVy',    label: 'V-Burst',    min: 0.5, max: 6, step: 0.1 },
      { section: 'Crumble — Fragments' },
      { id: 'fragCount', label: 'Count',  min: 10, max: 300, step: 10 },
      { id: 'fragSize',  label: 'Size',   min: 1, max: 12, step: 0.5 },
      { id: 'fragAlpha', label: 'Alpha',  min: 0.1, max: 1, step: 0.05 },
      { id: 'fragDecay', label: 'Decay',  min: 0.002, max: 0.03, step: 0.001 },
      { section: 'Crumble — Chips' },
      { id: 'chipCount', label: 'Count',  min: 10, max: 400, step: 10 },
      { id: 'chipSize',  label: 'Size',   min: 0.5, max: 8, step: 0.5 },
      { id: 'chipAlpha', label: 'Alpha',  min: 0.1, max: 1, step: 0.05 },
      { id: 'chipDecay', label: 'Decay',  min: 0.002, max: 0.03, step: 0.001 },
    ],
    actions: [{ id: 'sb-test-particles', label: 'Test Particles', handler: testParticles }],
  },
  {
    group: 'Lighting',
    params: lightParams,
    onChange: updateLighting,
    controls: [
      { section: 'Turbulence' },
      { id: 'baseFrequency',   label: 'Frequency',  min: 0.01, max: 0.15, step: 0.005 },
      { id: 'numOctaves',      label: 'Octaves',    min: 1, max: 5, step: 1 },
      { section: 'Diffuse' },
      { id: 'diffuseSurface',  label: 'Surface',    min: 0, max: 5, step: 0.1 },
      { id: 'diffuseConstant', label: 'Constant',   min: 0, max: 2, step: 0.05 },
      { section: 'Specular' },
      { id: 'specSurface',     label: 'Surface',    min: 0, max: 5, step: 0.1 },
      { id: 'specConstant',    label: 'Constant',   min: 0, max: 2, step: 0.05 },
      { id: 'specExponent',    label: 'Exponent',   min: 1, max: 60, step: 1 },
      { section: 'Light' },
      { id: 'azimuth',         label: 'Azimuth',    min: 0, max: 360, step: 5 },
      { id: 'elevation',       label: 'Elevation',  min: 5, max: 90, step: 5 },
      { section: 'Compositing' },
      { id: 'opacity',         label: 'Opacity',    min: 0, max: 1, step: 0.05 },
      { id: 'blendMode',       label: 'Blend Mode', type: 'select',
        options: ['soft-light', 'overlay', 'multiply', 'screen', 'hard-light', 'color-dodge', 'normal'] },
    ],
  },
];

export function initSidebar() {
  const nav = document.getElementById('sidebar');
  if (!nav) return;

  let bodyHtml = '';

  for (const g of GROUPS) {
    let groupContent = '';

    for (const c of g.controls) {
      if (c.section) {
        groupContent += `<div class="sb-section">${c.section}</div>`;
        continue;
      }

      const val = g.params[c.id];

      if (c.type === 'select') {
        // Dropdown select
        const opts = c.options.map(o =>
          `<option value="${o}"${o === val ? ' selected' : ''}>${o}</option>`
        ).join('');
        groupContent += `
          <div class="sb-row">
            <div class="sb-label">
              <span>${c.label}</span>
            </div>
            <select id="ctrl-${g.group}-${c.id}">${opts}</select>
          </div>`;
      } else {
        // Range slider
        const displayVal = formatVal(val, c.step);
        groupContent += `
          <div class="sb-row">
            <div class="sb-label">
              <span>${c.label}</span>
              <span class="sb-val" id="val-${g.group}-${c.id}">${displayVal}</span>
            </div>
            <input type="range" id="ctrl-${g.group}-${c.id}"
              min="${c.min}" max="${c.max}" step="${c.step}" value="${val}">
          </div>`;
      }
    }

    // Action buttons
    if (g.actions) {
      groupContent += `<div class="sb-actions">`;
      for (const a of g.actions) {
        groupContent += `<button id="${a.id}">${a.label}</button>`;
      }
      groupContent += `</div>`;
    }

    bodyHtml += `
      <div class="sb-group">
        <div class="sb-group-header">${g.group}</div>
        <div class="sb-group-body">${groupContent}</div>
      </div>`;
  }

  nav.innerHTML = `
    <div class="sb-header">
      <span>Tuning</span>
      <span class="sb-hint">ctrl+o</span>
    </div>
    <div class="sb-body">${bodyHtml}</div>`;

  // Wire up controls
  for (const g of GROUPS) {
    for (const c of g.controls) {
      if (c.section) continue;
      const el = document.getElementById(`ctrl-${g.group}-${c.id}`);

      if (c.type === 'select') {
        el.addEventListener('change', () => {
          g.params[c.id] = el.value;
          if (g.onChange) g.onChange();
        });
      } else {
        const display = document.getElementById(`val-${g.group}-${c.id}`);
        el.addEventListener('input', () => {
          const v = parseFloat(el.value);
          g.params[c.id] = v;
          display.textContent = formatVal(v, c.step);
          if (g.onChange) g.onChange();
        });
      }
    }

    // Action buttons
    if (g.actions) {
      for (const a of g.actions) {
        document.getElementById(a.id).addEventListener('click', a.handler);
      }
    }
  }

  // Collapsible group headers
  for (const header of nav.querySelectorAll('.sb-group-header')) {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('open');
    });
  }

  // Toggle sidebar with Ctrl+O / Cmd+O
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      nav.classList.toggle('open');
    }
  });
}

function formatVal(val, step) {
  return val.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : step >= 1 ? 0 : 1);
}
