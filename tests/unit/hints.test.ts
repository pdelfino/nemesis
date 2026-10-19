import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PageEvent } from '../../src/shared/buffers'
import {
  decodeHintLabels,
  encodeHintLabels,
  HINT_CHARACTERS,
  MAX_HINT_LABEL,
  MAX_HINTS,
  MAX_PAGE_REQUEST_ARGS,
  PAGE_DOOR_REQUEST_CHANNEL,
  parsePageAnswer,
  parsePageRequestArgs,
  type HintNode,
  type HintsAnswer,
  type PageRequest,
} from '../../src/shared/page-door'
import { PageScriptDoor } from '../../src/main/page-door'
import { HINT_MODE } from '../../src/main/page-buffer'
import {
  hintLabels,
  hintTargets,
  PageHints,
  type PageHintsOptions,
} from '../../src/main/pages/hints'
import { formatRef, type SemanticSnapshot } from '../../src/main/pages/semantic'
import { DEFAULT_HINT_SETTINGS, defaultSettings, parseSettings } from '../../src/main/settings'
import { createCockpitResolver, MODE_KEYMAPS } from '../../src/main/commands/keyscheme'
import type { KeyStroke } from '../../src/shared/keys'

/**
 * Hint mode (#123): the labels, the door's `hints` and `hints-show` entries
 * (numbers only in the request, the answers parsed whole), the targets drawn
 * from the snapshot's refs, the mode's flow on fakes, the `hints` setting
 * and the sealed `hint` layer. The live run, with the overlay in the page's
 * isolated world, is tests/e2e/hints.spec.ts.
 */

const ROOT = resolve(__dirname, '../..')

describe('hint labels', () => {
  it('are all one length, the shortest the alphabet allows, and none is a prefix of another', () => {
    expect(hintLabels(3, 'asd', 3)).toEqual(['a', 's', 'd'])
    const labels = hintLabels(10, 'asd', 3)
    expect(labels).toHaveLength(10)
    expect(new Set(labels.map((label) => label.length))).toEqual(new Set([3]))
    expect(new Set(labels).size).toBe(10)
    for (const one of labels) {
      for (const other of labels) if (one !== other) expect(other.startsWith(one)).toBe(false)
    }
    expect(hintLabels(4, 'asdfghjkl', 3)).toEqual(['a', 's', 'd', 'f'])
    expect(hintLabels(10, 'asdfghjkl', 3).slice(0, 2)).toEqual(['aa', 'as'])
  })

  it('stop at what the longest label can name', () => {
    expect(hintLabels(100, 'as', 2)).toEqual(['aa', 'as', 'sa', 'ss'])
    expect(hintLabels(0, 'as', 2)).toEqual([])
  })
})

describe("the door's hint entries", () => {
  it("carry the labels as numbers, the preload's reading the same labels back", () => {
    const labels = [
      { id: 7, label: 'as' },
      { id: 12, label: 'k9' },
    ]
    const args = encodeHintLabels(labels)
    expect(args.every((one) => Number.isSafeInteger(one))).toBe(true)
    expect(args).toEqual([7, 2, 97, 115, 12, 2, 107, 57])
    expect(decodeHintLabels(args)).toEqual(labels)
    expect(decodeHintLabels([])).toEqual([])
    // The most labels of the longest length still fit one request.
    expect(MAX_HINTS * (2 + MAX_HINT_LABEL)).toBeLessThanOrEqual(MAX_PAGE_REQUEST_ARGS)
  })

  it('refuse a label that is not hint characters, and args cut short or out of bounds', () => {
    expect(() => encodeHintLabels([{ id: 1, label: 'A' }])).toThrow()
    expect(() => encodeHintLabels([{ id: 1, label: '<b>' }])).toThrow()
    expect(() => encodeHintLabels([{ id: 0, label: 'a' }])).toThrow()
    expect(() => encodeHintLabels([{ id: 1, label: 'a'.repeat(MAX_HINT_LABEL + 1) }])).toThrow()
    expect(() => decodeHintLabels([1, 2, 97])).toThrow()
    expect(() => decodeHintLabels([1, 1, 60])).toThrow()
    expect(() => decodeHintLabels([1, 0])).toThrow()
    expect(() => parsePageRequestArgs([1, 'a'])).toThrow()
    expect(() => parsePageRequestArgs([1.5])).toThrow()
    expect(() => parsePageRequestArgs(new Array(MAX_PAGE_REQUEST_ARGS + 1).fill(1))).toThrow()
    expect(parsePageRequestArgs(undefined)).toEqual([])
  })

  it('parse a hostile answer whole or not at all', () => {
    const good: HintsAnswer = {
      nodes: [{ id: 1, href: 'https://a.test/', x: 0, y: 0, width: 10, height: 10 }],
    }
    expect(parsePageAnswer('hints', good)).toEqual(good)
    const bad = (
      node: Partial<Record<keyof HintNode, unknown>> & Record<string, unknown>,
    ): void => {
      expect(() => parsePageAnswer('hints', { nodes: [{ ...good.nodes[0], ...node }] })).toThrow()
    }
    bad({ x: Number.NaN })
    bad({ href: 'x'.repeat(9000) })
    bad({ id: 0 })
    bad({ label: 'zz' })
    expect(() =>
      parsePageAnswer('hints', { nodes: new Array(MAX_HINTS + 1).fill(good.nodes[0]) }),
    ).toThrow()
    expect(parsePageAnswer('hints-show', { labels: [] })).toEqual({ labels: [] })
    expect(() =>
      parsePageAnswer('hints-show', {
        labels: [{ id: 1, x: 0, y: 0, width: 1, height: 1, text: 'a' }],
      }),
    ).toThrow()
  })

  it('main sends args only to a name that takes them, and refuses args that are not whole numbers', async () => {
    const sent: PageRequest[] = []
    const door = new PageScriptDoor({ isPage: () => true, timeoutMs: 10, warn: () => undefined })
    const contents = {
      id: 3,
      isDestroyed: () => false,
      send: (channel: string, request: PageRequest) => {
        expect(channel).toBe(PAGE_DOOR_REQUEST_CHANNEL)
        sent.push(request)
      },
    }
    await door.request(contents, 'hints').catch(() => undefined)
    await door.request(contents, 'hints-show', [1, 1, 97]).catch(() => undefined)
    expect(sent.map((one) => Object.keys(one).sort())).toEqual([
      ['id', 'name'],
      ['args', 'id', 'name'],
    ])
    expect(sent[1]?.args).toEqual([1, 1, 97])
    await expect(door.request(contents, 'hints-show', [Number.NaN])).rejects.toThrow()
    expect(sent).toHaveLength(2)
  })

  it('the preload draws into a closed shadow root it owns, with no markup from a string', () => {
    const source = readFileSync(resolve(ROOT, 'src/preload/page.ts'), 'utf8')
    expect(source).toMatch(/attachShadow\(\{ mode: 'closed' \}\)/)
    // No markup is ever set; `query` (#141) only reads an element's outer HTML.
    expect(source).not.toMatch(
      /(?:innerHTML|outerHTML)\s*\+?=(?!=)|insertAdjacentHTML|document\.write/,
    )
    expect(source.match(/\.outerHTML\b/g)).toHaveLength(1)
    expect(source).not.toMatch(/innerHTML/)
    expect(source).not.toMatch(/mode: 'open'/)
  })
})

const DOCUMENT = 4

function snapshotOf(
  nodes: { id: number; role: SemanticSnapshot['nodes'][number]['role'] }[],
): SemanticSnapshot {
  return {
    pageId: 'p1',
    url: 'https://a.test/',
    origin: 'https://a.test',
    count: nodes.length,
    nodes: nodes.map(({ id, role }) => ({
      ref: formatRef(DOCUMENT, id),
      role,
      name: `node ${id}`,
      value: '',
      state: [],
      rect: { x: 0, y: 0, width: 10, height: 10 },
      children: [],
    })),
  }
}

function hint(id: number, href = ''): HintNode {
  return { id, href, x: 10 * id, y: 20, width: 40, height: 10 }
}

describe('hint targets', () => {
  const snapshot = snapshotOf([
    { id: 1, role: 'link' },
    { id: 2, role: 'textbox' },
    { id: 3, role: 'link' },
  ])

  it("are the read's elements the snapshot holds, by its refs", () => {
    const answer = {
      nodes: [hint(1, 'https://a.test/one'), hint(2), hint(9), hint(3, 'https://a.test/three')],
    }
    const targets = hintTargets(snapshot, answer, 'follow', { alphabet: 'as', maxLength: 3 })
    expect(targets.map((target) => [target.label, target.ref, target.role])).toEqual([
      ['aa', 'd4e1', 'link'],
      ['as', 'd4e2', 'textbox'],
      ['sa', 'd4e3', 'link'],
    ])
  })

  it('for a copy, are links only', () => {
    const answer = { nodes: [hint(1, 'https://a.test/one'), hint(2)] }
    const targets = hintTargets(snapshot, answer, 'copy', DEFAULT_HINT_SETTINGS)
    expect(targets.map((target) => target.ref)).toEqual(['d4e1'])
  })
})

interface Fakes {
  readonly options: PageHintsOptions
  readonly shown: (readonly number[])[]
  readonly modes: [string, boolean][]
  readonly opened: [string, string][]
  readonly clicked: [string, number, number][]
  readonly copied: string[]
  readonly notices: string[]
  readonly live: Set<string>
  emit(event: PageEvent): void
}

function fakes(answer: HintsAnswer): Fakes {
  const shown: (readonly number[])[] = []
  const modes: [string, boolean][] = []
  const opened: [string, string][] = []
  const clicked: [string, number, number][] = []
  const copied: string[] = []
  const notices: string[] = []
  const live = new Set(['d4e1', 'd4e2', 'd4e3'])
  let listener: ((event: PageEvent) => void) | null = null
  const options: PageHintsOptions = {
    semantic: {
      snapshot: () =>
        Promise.resolve(
          snapshotOf([
            { id: 1, role: 'link' },
            { id: 2, role: 'textbox' },
            { id: 3, role: 'button' },
          ]),
        ),
      resolve: (ref) => (live.has(ref) ? { pageId: 'p1' } : null),
    },
    read: () => Promise.resolve(answer),
    show: (_pageId, args) => {
      shown.push(args)
      return Promise.resolve({
        labels: decodeHintLabels(args).map(({ id }) => ({ id, x: 0, y: 0, width: 20, height: 14 })),
      })
    },
    settings: () => ({ alphabet: 'as', maxLength: 2 }),
    mode: (pageId, on) => modes.push([pageId, on]),
    open: (pageId, url) => {
      opened.push([pageId, url])
      return Promise.resolve(null)
    },
    click: (pageId, x, y) => clicked.push([pageId, x, y]),
    copy: (text) => copied.push(text),
    notify: (text) => notices.push(text),
    events: (on) => {
      listener = on
    },
  }
  return {
    options,
    shown,
    modes,
    opened,
    clicked,
    copied,
    notices,
    live,
    emit: (event) => listener?.(event),
  }
}

const ANSWER: HintsAnswer = {
  nodes: [hint(1, 'https://a.test/next'), hint(2), hint(3)],
}

describe('hint mode', () => {
  it('f draws a label per target and turns the mode on; a label typed whole follows its link', async () => {
    const f = fakes(ANSWER)
    const hints = new PageHints(f.options)
    await hints.start('p1', 'follow')
    expect(f.modes).toEqual([['p1', true]])
    expect(decodeHintLabels(f.shown[0] ?? [])).toEqual([
      { id: 1, label: 'aa' },
      { id: 2, label: 'as' },
      { id: 3, label: 'sa' },
    ])
    expect(hints.drawn('p1')).toHaveLength(3)

    // One key narrows the overlay to the labels that still match.
    await hints.type('p1', 'a')
    expect(decodeHintLabels(f.shown[1] ?? []).map((one) => one.label)).toEqual(['aa', 'as'])
    await hints.type('p1', 'a')
    expect(f.opened).toEqual([['p1', 'https://a.test/next']])
    expect(f.modes.at(-1)).toEqual(['p1', false])
    expect(f.shown.at(-1)).toEqual([])
    expect(hints.active('p1')).toBe(false)
  })

  it('a field or a button is clicked at its centre, in main', async () => {
    const f = fakes(ANSWER)
    const hints = new PageHints(f.options)
    await hints.start('p1', 'follow')
    await hints.type('p1', 'a')
    await hints.type('p1', 's')
    expect(f.clicked).toEqual([['p1', 40, 25]])
    expect(f.opened).toEqual([])
  })

  it("F copies a link's URL and the notice does not repeat it", async () => {
    const f = fakes(ANSWER)
    const hints = new PageHints(f.options)
    await hints.start('p1', 'copy')
    expect(decodeHintLabels(f.shown[0] ?? [])).toEqual([{ id: 1, label: 'a' }])
    await hints.type('p1', 'a')
    expect(f.copied).toEqual(['https://a.test/next'])
    expect(f.opened).toEqual([])
    expect(f.notices.join(' ')).not.toContain('https://a.test/next')
  })

  it('a key no label continues with does nothing, so a label the page draws itself means nothing', async () => {
    const f = fakes(ANSWER)
    const hints = new PageHints(f.options)
    await hints.start('p1', 'follow')
    await hints.type('p1', 'z')
    await hints.type('p1', 's')
    await hints.type('p1', 's')
    expect(f.opened).toEqual([])
    expect(f.clicked).toEqual([])
    expect(hints.active('p1')).toBe(true)
  })

  it('C-g takes the labels down, and a navigation ends the mode', async () => {
    const f = fakes(ANSWER)
    const hints = new PageHints(f.options)
    await hints.start('p1', 'follow')
    await hints.quit('p1')
    expect(f.shown.at(-1)).toEqual([])
    expect(f.modes.at(-1)).toEqual(['p1', false])

    await hints.start('p1', 'follow')
    f.emit({ type: 'committed', pageId: 'p1', url: 'https://a.test/other' })
    expect(hints.active('p1')).toBe(false)
    expect(f.modes.at(-1)).toEqual(['p1', false])
  })

  it('a target whose document is gone is refused', async () => {
    const f = fakes(ANSWER)
    const hints = new PageHints(f.options)
    await hints.start('p1', 'follow')
    await hints.type('p1', 'a')
    f.live.clear()
    await hints.type('p1', 'a')
    expect(f.opened).toEqual([])
    expect(f.notices).toContain('The page navigated; that hint is gone')
  })

  it('a read the door refuses is a notice, and the mode stays off', async () => {
    const f = fakes(ANSWER)
    const hints = new PageHints({
      ...f.options,
      read: () => Promise.reject(new Error('The page did not answer hints in time')),
    })
    await hints.start('p1', 'follow')
    expect(f.modes).toEqual([])
    expect(f.notices).toEqual(['No hints: The page did not answer hints in time'])
  })

  it('a page with nothing to label says so and stays out of the mode', async () => {
    const f = fakes({ nodes: [] })
    const hints = new PageHints(f.options)
    await hints.start('p1', 'follow')
    expect(f.modes).toEqual([])
    expect(f.shown).toEqual([])
    expect(f.notices).toEqual(['No hints on this page'])
  })
})

describe('the hints setting', () => {
  const defaults = defaultSettings('/Users/someone/Documents')

  it('defaults to the home row', () => {
    expect(defaults.hints).toEqual({ alphabet: 'asdfghjkl', maxLength: 3 })
    expect(parseSettings({ hints: { alphabet: 'jklm' } }, defaults).hints).toEqual({
      alphabet: 'jklm',
      maxLength: 3,
    })
    expect(parseSettings({ hints: { maxLength: 2 } }, defaults).hints.maxLength).toBe(2)
  })

  it('refuses an alphabet the hint layer cannot type, and a length out of bounds', () => {
    expect(() => parseSettings({ hints: { alphabet: 'a' } }, defaults)).toThrow(/hints.alphabet/)
    expect(() => parseSettings({ hints: { alphabet: 'aa' } }, defaults)).toThrow(/hints.alphabet/)
    expect(() => parseSettings({ hints: { alphabet: 'AS' } }, defaults)).toThrow(/hints.alphabet/)
    expect(() => parseSettings({ hints: { alphabet: 'a;' } }, defaults)).toThrow(/hints.alphabet/)
    expect(() => parseSettings({ hints: { maxLength: 0 } }, defaults)).toThrow(/hints.maxLength/)
    expect(() => parseSettings({ hints: { maxLength: 7 } }, defaults)).toThrow(/hints.maxLength/)
    expect(() => parseSettings({ hints: { selector: 'a' } }, defaults)).toThrow(/hints.selector/)
  })
})

describe('the hint layer', () => {
  const stroke = (key: string, control = false): KeyStroke => ({
    key,
    control,
    meta: false,
    shift: false,
    super: false,
  })

  it('f and F start hint mode from document mode', () => {
    const resolver = createCockpitResolver()
    expect(resolver.resolve(stroke('f'), 'page', ['document'])).toMatchObject({
      kind: 'command',
      command: 'follow-hint',
    })
    expect(resolver.resolve(stroke('F'), 'page', ['document'])).toMatchObject({
      kind: 'command',
      command: 'copy-hint-url',
    })
  })

  it('is sealed: every hint character types into the label, C-g leaves, and nothing below sees a key', () => {
    expect(MODE_KEYMAPS[HINT_MODE]?.sealed).toBe(true)
    const resolver = createCockpitResolver()
    const modes = [HINT_MODE, 'document']
    for (const key of HINT_CHARACTERS) {
      expect(resolver.resolve(stroke(key), 'page', modes)).toMatchObject({
        kind: 'command',
        command: 'type-hint-key',
      })
    }
    expect(resolver.resolve(stroke('g', true), 'page', modes)).toMatchObject({
      kind: 'command',
      command: 'quit-hints',
    })
    // C-v scrolls in document mode, and is the page's while labels are up.
    expect(resolver.resolve(stroke('v', true), 'page', modes).kind).toBe('unbound')
  })
})

describe('the clicks of hint mode stay in main', () => {
  it('a click is input main synthesizes, never a script in the page', () => {
    const source = readFileSync(resolve(ROOT, 'src/main/pages/hints.ts'), 'utf8')
    expect(source).not.toMatch(/executeJavaScript|\beval\s*\(/)
  })
})
