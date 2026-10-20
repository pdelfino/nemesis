#!/usr/bin/env node
// Writes docs/images/positioning-map.svg (#187): Nemesis and the README's
// neighbors on two axes, each dot the project's own logo from
// docs/images/logos/. GitHub shows a README's SVG through <img>, which loads
// nothing outside the file, so every logo is inlined as a data URI. The
// positions are a reading of the README's comparison tables, not a
// measurement; move a project by editing its x and y here and rerunning.
//
// Usage: node scripts/positioning-map.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('..', import.meta.url))
const logos = join(repository, 'docs', 'images', 'logos')

// x: 0 = no agent or one bolted on from outside, 1 = the agent hosted in-process.
// y: 0 = mouse or terminal first, 1 = keyboard and text first.
const PROJECTS = [
  {
    name: 'Nemesis',
    file: join(repository, 'resources', 'icon-64.png'),
    x: 0.93,
    y: 0.93,
    us: true,
  },
  { name: 'Nyxt', file: 'nyxt.png', x: 0.06, y: 0.93 },
  { name: 'Emacs + agent-shell', file: 'emacs.svg', x: 0.5, y: 0.88 },
  { name: 'Zed', file: 'zed.png', x: 0.45, y: 0.62 },
  { name: 'Min', file: 'min.png', x: 0.06, y: 0.42 },
  { name: 'Claude Code in iTerm2', file: 'iterm2.png', x: 0.78, y: 0.42 },
  { name: 'Goose', file: 'goose.png', x: 0.9, y: 0.22 },
  { name: 'Claude desktop app', file: 'claude.svg', x: 0.66, y: 0.18 },
  { name: 'BrowserOS', file: 'browseros.png', x: 0.4, y: 0.14 },
  { name: 'Claude in Chrome', file: 'chrome.svg', x: 0.14, y: 0.14 },
]

const W = 760
const H = 560
const PLOT = { left: 110, right: 720, top: 40, bottom: 470 }
const ICON = 40

const mime = { '.png': 'image/png', '.svg': 'image/svg+xml' }
const dataUri = (path) =>
  `data:${mime[extname(path)]};base64,${readFileSync(path).toString('base64')}`

const px = (x) => PLOT.left + x * (PLOT.right - PLOT.left)
const py = (y) => PLOT.bottom - y * (PLOT.bottom - PLOT.top)
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const dots = PROJECTS.map((p) => {
  const cx = px(p.x)
  const cy = py(p.y)
  const href = dataUri(p.file.startsWith('/') ? p.file : join(logos, p.file))
  const ring = p.us ? `<circle cx="${cx}" cy="${cy}" r="${ICON / 2 + 14}" class="us"/>` : ''
  return [
    `  <g>`,
    `    ${ring}`,
    `    <rect x="${cx - ICON / 2 - 5}" y="${cy - ICON / 2 - 5}" width="${ICON + 10}" height="${ICON + 10}" rx="10" class="plate"/>`,
    `    <image href="${href}" x="${cx - ICON / 2}" y="${cy - ICON / 2}" width="${ICON}" height="${ICON}"/>`,
    `    <text x="${cx}" y="${cy + ICON / 2 + (p.us ? 32 : 22)}" text-anchor="middle" class="label${p.us ? ' strong' : ''}">${escape(p.name)}</text>`,
    `  </g>`,
  ]
    .filter((line) => line.trim())
    .join('\n')
})

const midX = (PLOT.left + PLOT.right) / 2
const midY = (PLOT.top + PLOT.bottom) / 2

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Where Nemesis sits among its neighbors">
  <title>Where Nemesis sits among its neighbors</title>
  <style>
    .axis { stroke: #8b949e; stroke-width: 1.5; fill: none; }
    .grid { stroke: #8b949e; stroke-width: 1; stroke-dasharray: 4 6; opacity: 0.45; }
    /* Mid-tones on purpose: GitHub shows this as an img element, where the
       colour scheme follows the operating system, not GitHub's theme, so
       every colour has to read on white and on near-black alike. */
    .label { font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: #768390; }
    .axis-label { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: #768390; }
    .strong { font-weight: 700; fill: #c4407f; }
    .us { fill: none; stroke: #c4407f; stroke-width: 2.5; }
    .plate { fill: #ffffff; stroke: #d0d7de; stroke-width: 1; }
    @media (prefers-color-scheme: dark) {
      .plate { stroke: #444c56; }
    }
  </style>
  <line x1="${PLOT.left}" y1="${PLOT.bottom}" x2="${PLOT.right}" y2="${PLOT.bottom}" class="axis"/>
  <line x1="${PLOT.left}" y1="${PLOT.bottom}" x2="${PLOT.left}" y2="${PLOT.top}" class="axis"/>
  <line x1="${midX}" y1="${PLOT.top}" x2="${midX}" y2="${PLOT.bottom}" class="grid"/>
  <line x1="${PLOT.left}" y1="${midY}" x2="${PLOT.right}" y2="${midY}" class="grid"/>
  <text x="${PLOT.left}" y="${PLOT.bottom + 34}" class="axis-label">no agent, or one bolted on</text>
  <text x="${PLOT.right}" y="${PLOT.bottom + 34}" text-anchor="end" class="axis-label">agent hosted in-process →</text>
  <text x="${midX}" y="${PLOT.bottom + 58}" text-anchor="middle" class="label">how deep the agent lives</text>
  <text transform="translate(${PLOT.left - 70} ${PLOT.bottom}) rotate(-90)" class="axis-label">mouse or terminal first</text>
  <text transform="translate(${PLOT.left - 70} ${PLOT.top}) rotate(-90)" text-anchor="end" class="axis-label">keyboard and text first →</text>
${dots.join('\n')}
</svg>
`

const out = join(repository, 'docs', 'images', 'positioning-map.svg')
writeFileSync(out, svg)
console.log(`wrote ${out}, ${svg.length} bytes`)
