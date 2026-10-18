#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Page } from '@playwright/test'

/**
 * Eyes on the window Pedro sees (#102):
 *
 *   npm run dev:debug                       # one terminal: the app, port 9222 open
 *   npm run peek -- [--port 9222] [--out /tmp/peek.png]
 *
 * The script attaches over the Chrome DevTools Protocol to the cockpit that
 * `dev:debug` (or a test launch with `--remote-debugging-port`) left
 * listening on loopback, prints what the window shows as an Org document on
 * stdout, and saves a PNG of it. It launches nothing and sends no input: the
 * page is read through `page.evaluate` and photographed through
 * `Page.captureScreenshot`, then the connection is dropped and the app keeps
 * running. Node strips the types the same way it does for agent-smoke.mts,
 * so there is no build step and no new dependency.
 */

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9222' },
    out: { type: 'string', default: join(tmpdir(), 'nemesis-peek.png') },
  },
})

/** One line on stderr and a non-zero exit; the caller gets no stack trace. */
function fail(reason: string): never {
  console.error(`peek: ${reason}`)
  process.exit(1)
}

const port = Number.parseInt(values.port, 10)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  fail(`--port must be a TCP port, got ${JSON.stringify(values.port)}`)
}
const endpoint = `http://127.0.0.1:${port}`
const out = resolve(values.out)

/** The cockpit page: the built app on nemesis://app, or the Vite dev server on localhost. */
function isCockpit(url: string): boolean {
  return (
    url.startsWith('nemesis://app') ||
    url.startsWith('http://localhost:') ||
    url.startsWith('http://127.0.0.1:')
  )
}

// The slice of the DOM the in-page function touches. The node tsconfig has
// no DOM lib, the same way the end-to-end specs declare what they read.
interface PeekElement {
  readonly id: string
  readonly hidden: boolean
  readonly innerText: string
  readonly children: ArrayLike<PeekElement>
  readonly dataset: Readonly<Record<string, string | undefined>>
  getAttribute(name: string): string | null
  querySelector(selector: string): PeekElement | null
  querySelectorAll(selector: string): ArrayLike<PeekElement>
}

interface PeekWindow {
  readonly document: {
    readonly title: string
    querySelector(selector: string): PeekElement | null
    querySelectorAll(selector: string): ArrayLike<PeekElement>
  }
  readonly location: { readonly href: string }
}

interface BufferSnapshot {
  readonly id: string
  readonly label: string
  readonly type: string
  readonly current: boolean
  readonly text: string
}

interface PaletteSnapshot {
  readonly prompt: string
  readonly input: string
  readonly candidates: readonly string[]
  readonly doc: string
}

interface WindowSnapshot {
  readonly title: string
  readonly url: string
  readonly modeline: string
  readonly buffers: readonly BufferSnapshot[]
  readonly hidden: readonly string[]
  readonly palette: PaletteSnapshot | null
}

/**
 * Runs inside the page. `innerText` is layout-aware, so a hidden child adds
 * nothing and a CodeMirror document comes out one line per `.cm-line`; the
 * editor's own chrome (selection layers, the measuring div) has no text.
 */
async function snapshot(page: Page): Promise<WindowSnapshot> {
  return page.evaluate(() => {
    const { document, location } = globalThis as unknown as PeekWindow
    const text = (element: PeekElement | null): string => element?.innerText.trim() ?? ''
    const content = (element: PeekElement): string => {
      const parts: string[] = []
      for (const child of Array.from(element.children)) {
        const part = text(child.querySelector('.cm-content') ?? child)
        if (part.length > 0) parts.push(part)
      }
      return parts.join('\n')
    }

    const buffers: BufferSnapshot[] = []
    const hidden: string[] = []
    for (const section of Array.from(
      document.querySelectorAll('main > section[data-buffer-type]'),
    )) {
      if (section.hidden) {
        hidden.push(section.id)
        continue
      }
      buffers.push({
        id: section.id,
        label: section.getAttribute('aria-label') ?? section.id,
        type: section.dataset['bufferType'] ?? '',
        current: section.dataset['current'] === 'true',
        text: content(section),
      })
    }

    const paletteElement = document.querySelector('#palette')
    const palette =
      paletteElement === null || paletteElement.hidden
        ? null
        : {
            prompt: text(document.querySelector('#palette-prompt')),
            input: text(document.querySelector('#palette-input .cm-content')),
            candidates: Array.from(document.querySelectorAll('#palette-candidates > li'), text),
            doc: text(document.querySelector('#palette-doc')),
          }

    return {
      title: document.title,
      url: location.href,
      modeline: text(document.querySelector('#modeline')).replace(/\s*\n\s*/g, ' | '),
      buffers,
      hidden,
      palette,
    }
  })
}

/** An Org example block; a line that would read as Org markup inside it is escaped the Org way. */
function example(body: string): string {
  const escaped = body.replace(/^(\s*)(#\+|\*)/gm, '$1,$2')
  return `#+begin_example\n${escaped}\n#+end_example`
}

function org(shot: WindowSnapshot, png: string): string {
  const lines: string[] = [
    '#+title: Nemesis peek',
    `#+date: ${new Date().toISOString()}`,
    '',
    '* Window',
    `- title: ${shot.title}`,
    `- url: ${shot.url}`,
    `- mode line: ${shot.modeline}`,
    `- hidden buffers: ${shot.hidden.length > 0 ? shot.hidden.join(', ') : 'none'}`,
    `- screenshot: ${png}`,
    '',
    '* Buffers',
  ]
  for (const buffer of shot.buffers) {
    lines.push(`** ${buffer.label}${buffer.current ? ' (current)' : ''}`)
    lines.push(`- element: #${buffer.id}, type ${buffer.type}`)
    lines.push(buffer.text.length > 0 ? example(buffer.text) : '(empty)')
    lines.push('')
  }
  lines.push('* Palette')
  if (shot.palette === null) {
    lines.push('closed')
  } else {
    lines.push(`- prompt: ${shot.palette.prompt}`)
    lines.push(`- input: ${shot.palette.input}`)
    lines.push(`- doc: ${shot.palette.doc}`)
    lines.push('- candidates:')
    for (const candidate of shot.palette.candidates) lines.push(`  - ${candidate}`)
  }
  lines.push('')
  return lines.join('\n')
}

// A short preflight so a dead port is one line, not a Playwright stack trace.
try {
  await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) })
} catch {
  fail(`nothing listens on ${endpoint}; start the app with npm run dev:debug`)
}

const browser = await chromium.connectOverCDP(endpoint)
try {
  const pages = browser.contexts().flatMap((context) => context.pages())
  const page = pages.find((candidate) => isCockpit(candidate.url()))
  if (page === undefined) {
    const seen =
      pages.length === 0 ? 'no pages' : pages.map((candidate) => candidate.url()).join(', ')
    fail(`no cockpit page on ${endpoint}; saw ${seen}`)
  }

  const shot = await snapshot(page)
  const session = await page.context().newCDPSession(page)
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
  await session.detach()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, Buffer.from(data, 'base64'))

  process.stdout.write(org(shot, out))
} finally {
  // Disconnects only: a browser reached through connectOverCDP is not ours to close.
  await browser.close()
}
