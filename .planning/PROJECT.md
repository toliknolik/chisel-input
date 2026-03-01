# chisel-input

## What This Is

A deliberate, slowing-down text experience that mimics chiseling words into stone. Each keystroke is delayed 250–500ms, letters emerge gradually from the marble surface with opacity fade and scale animation, accompanied by stone-on-stone tap sounds and falling dust particles. When finished, the user clicks "Eternalize" to export the slab as a high-res 16:9 PNG, designed to be shared on Twitter/X. It is a single-session, front-end-only artifact creator.

## Core Value

Creating a beautiful, permanent marble artifact from intentional words — the slowness and permanence are the experience, not obstacles to it.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Each keystroke is delayed 250–500ms before the letter appears
- [ ] Letters emerge from the surface with opacity fade + scale animation
- [ ] No character editing allowed; "Destroy Slab" is the only reset — with a dramatic destruction animation
- [ ] Chisel sound plays on each keystroke (Web Audio API, stone-on-stone, muted by default)
- [ ] Dust particles fall from each carved letter (WebGL particle system)
- [ ] Marble slab rendered with Three.js/WebGL + displacement mapping
- [ ] Each session generates a unique slab: random shape (Perlin noise edges), random rotation (±0.1–0.2°), cracks and weathering
- [ ] Marble veins applied from a provided Figma SVG library (5–10 patterns), 2–3 randomly combined per session with random rotation, scale, opacity
- [ ] Roman serif typography (Cinzel or Trajan), all-caps, centered, slightly uneven letter spacing, baseline wobble, depth via outer/inner shadow
- [ ] "Eternalize" button exports slab as 16:9 high-res PNG (1920×1080 or 2x)
- [ ] Text capacity: 1–2 sentences (~100 characters)

### Out of Scope

- Backend, accounts, or session persistence — pure front-end, no server
- Public gallery or submission system — personal artifact only
- Instagram square export — 16:9 only for v1
- Delete/undo individual characters — destroy-all is the only escape
- Mobile touch input — desktop keyboard experience first

## Context

- Marble vein SVGs already exist as Figma exports — user will provide them; each cluster is a separate SVG path with relative stroke widths
- Rough.js considered for SVG export with hand-drawn aesthetic
- simplex-noise for marble vein generation + slab edge irregularity
- The delay is intentional friction; the no-delete constraint forces commitment — both are core to the artifact's meaning, not UX bugs

## Constraints

- **Tech**: Three.js/WebGL (marble surface + displacement), Canvas 2D or SVG (text rendering → geometry), Web Audio API (chisel sounds), simplex-noise (marble veins + slab edges), Rough.js (SVG export)
- **Typography**: Roman serif — Cinzel, Trajan, or EB Garamond; all-caps; per-session font size variation ±0.2pt; baseline wobble
- **Scope**: Single-page, zero dependencies on backend; runs entirely in-browser
- **Export**: 16:9 at 1920×1080 (or 2x), PNG, Twitter/X optimized

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| No delete (destroy-slab only) | Permanence is the point — editing undermines the ritual | — Pending |
| 16:9 export only for v1 | Twitter/X is primary sharing surface; square can come later | — Pending |
| Front-end only | Zero infra cost, instant deployment, keeps scope tight | — Pending |
| User-provided Figma SVG veins | Artisanal quality over procedural — veins already exist | — Pending |

---
*Last updated: 2026-03-01 after initialization*
