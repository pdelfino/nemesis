#!/usr/bin/env node
// Rasterize the mark (#91). resources/logo.svg is the single source: this
// script renders it to resources/icon-<size>.png at every size the Dock, the
// app switcher, a tab and the README need, then folds the macOS set into
// resources/icon.icns with iconutil. Nothing is drawn by hand; change the SVG
// and run this again.
//
// No new dependency and no download: the renderer is Chromium inside the
// Electron binary the install path already fetches, driven by the Playwright
// that drives the end-to-end specs; iconutil ships with macOS. On another OS
// the PNGs are written and the .icns step is skipped with a note, because the
// generated files are committed and the packaged icon is wired by
// electron-builder (#35).
//
// Usage: node scripts/icon.mjs

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const SIZES = [16, 32, 64, 128, 256, 512, 1024]

// Apple's iconset names: a point size and its @2x pixel double.
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

const resources = fileURLToPath(new URL('../resources/', import.meta.url))
const pngPath = (size) => join(resources, `icon-${size}.png`)

async function rasterize(svg) {
  const app = await electron.launch({ args: [join(import.meta.dirname, 'icon-window.mjs')] })
  try {
    const page = await app.firstWindow()
    const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    for (const size of SIZES) {
      // An <img> of the exact pixel size on a transparent page: Chromium scales
      // the vector once per size, so the 16 px icon is not a shrunk 1024.
      await page.setContent(
        '<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block}</style></head>' +
          `<body><img src="${data}" width="${size}" height="${size}"></body></html>`,
      )
      await page.waitForFunction('document.images[0].complete')
      await page.screenshot({
        path: pngPath(size),
        omitBackground: true,
        clip: { x: 0, y: 0, width: size, height: size },
      })
      console.log(`wrote resources/icon-${size}.png`)
    }
  } finally {
    await app.close()
  }
}

function makeIcns() {
  if (process.platform !== 'darwin') {
    console.log('skipping resources/icon.icns: iconutil is macOS only')
    return
  }
  const scratch = mkdtempSync(join(tmpdir(), 'nemesis-icon-'))
  const iconset = join(scratch, 'icon.iconset')
  mkdirSync(iconset)
  try {
    for (const [name, size] of ICONSET) copyFileSync(pngPath(size), join(iconset, name))
    const target = join(resources, 'icon.icns')
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', target], {
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      throw new Error(`iconutil failed: ${result.stderr || result.stdout || result.error}`)
    }
    console.log('wrote resources/icon.icns')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

await rasterize(readFileSync(join(resources, 'logo.svg'), 'utf8'))
makeIcns()
