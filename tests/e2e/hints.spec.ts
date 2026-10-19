import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './_test'
import { fixtureServer, launchNemesis, type Nemesis } from './security/_harness'

/**
 * Hint mode (#123) on the hostile fixture hints.html: two links, a field and
 * a button, and a script that, the moment the overlay's host appears, tries
 * to read it, hides it, closes its popover, takes it out of the document and
 * draws a forged label `a` over the second link.
 *
 * 1. `f` puts a label over each target, drawn by the overlay in the isolated
 *    world; the page finds a host with no shadow root it can reach and no
 *    label text, and after its attempts the labels are still the topmost
 *    thing at their own points. Typing the first label follows its link (the
 *    URL changes), not the link the forged `a` sits on.
 * 2. `F` labels the links only, and typing one copies its URL.
 * 3. A label on a field focuses it, a key no label continues with does
 *    nothing, and `C-g` takes the labels down and leaves the mode.
 */

interface Drawn {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Target {
  readonly label: string
  readonly ref: string
  readonly role: string
  readonly href: string
}

/** The test-only hook src/main/index.ts installs for hint mode. */
interface HintsHook {
  targets(windowId: number, bufferId: string): readonly Target[]
  drawn(windowId: number, bufferId: string): readonly Drawn[]
}

interface Ids {
  readonly windowId: number
  readonly bufferId: string
}

interface Hostile {
  readonly seen: number
  readonly shadowRoots: readonly string[]
  readonly texts: readonly string[]
}

function targets(app: ElectronApplication, ids: Ids): Promise<readonly Target[]> {
  return app.evaluate((_main, { windowId, bufferId }) => {
    const hook = (globalThis as { __nemesisHints?: HintsHook }).__nemesisHints
    if (hook === undefined) throw new Error('The app has no hints hook: is NODE_ENV=test?')
    return hook.targets(windowId, bufferId)
  }, ids)
}

function drawn(app: ElectronApplication, ids: Ids): Promise<readonly Drawn[]> {
  return app.evaluate((_main, { windowId, bufferId }) => {
    const hook = (globalThis as { __nemesisHints?: HintsHook }).__nemesisHints
    if (hook === undefined) throw new Error('The app has no hints hook: is NODE_ENV=test?')
    return hook.drawn(windowId, bufferId)
  }, ids)
}

/** One key typed into the page the way the system types it, so before-input-event sees it. */
async function press(
  app: ElectronApplication,
  contentsId: number,
  keyCode: string,
  modifiers: readonly ('control' | 'shift')[] = [],
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { contentsId, keyCode, modifiers }) => {
      const page = webContents.fromId(contentsId)
      if (page === undefined) throw new Error('no page contents')
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers] })
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [...modifiers] })
    },
    { contentsId, keyCode, modifiers },
  )
}

/** The page's modes, as the buffer list carries them. */
async function modes(nemesis: Nemesis, ids: Ids): Promise<readonly string[]> {
  return nemesis.window.evaluate(async (bufferId) => {
    const api = (
      globalThis as unknown as {
        nemesis: {
          buffers(): Promise<{ buffers: { id: string; modes?: readonly string[] }[] }>
        }
      }
    ).nemesis
    const list = await api.buffers()
    return list.buffers.find((buffer) => buffer.id === bufferId)?.modes ?? []
  }, ids.bufferId)
}

/** What the page's own world finds at a point: the id of the element, or the host's tag. */
function topAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ({ x, y }) => {
      const doc = (
        globalThis as unknown as {
          document: {
            elementFromPoint(
              x: number,
              y: number,
            ): {
              id: string
              tagName: string
              parentNode: unknown
            } | null
            documentElement: unknown
          }
        }
      ).document
      const hit = doc.elementFromPoint(x, y)
      if (hit === null) return 'nothing'
      if (hit.parentNode === doc.documentElement) return `host ${hit.tagName}`
      return hit.id.length > 0 ? `#${hit.id}` : hit.tagName
    },
    { x, y },
  )
}

test('labels go up over the links, out of reach of the page, and typing one follows it', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  const { app } = nemesis
  try {
    const url = fixtures.secureUrl('hints.html')
    const buffer = await nemesis.openPageBuffer(url)
    expect(buffer.loadError).toBeNull()
    const ids = buffer.ids
    if (ids === undefined) throw new Error('The page buffer has no ids')

    await press(app, buffer.contentsId, 'f')
    await expect.poll(async () => (await targets(app, ids)).length).toBe(4)
    expect(await modes(nemesis, ids)).toEqual(['hint', 'document'])
    const labelled = await targets(app, ids)
    // The home row, one key each, in document order, each on a ref of the snapshot.
    expect(labelled.map((target) => [target.label, target.role])).toEqual([
      ['a', 'link'],
      ['s', 'link'],
      ['d', 'textbox'],
      ['f', 'button'],
    ])
    for (const target of labelled) expect(target.ref).toMatch(/^d\d+e\d+$/)
    expect(labelled[0]?.href).toBe(fixtures.secureUrl('semantic.html'))

    // Each label is drawn at its target's corner, inside the target's box.
    const labels = await drawn(app, ids)
    expect(labels).toHaveLength(4)
    const boxes = await Promise.all(
      ['#next', '#away', '#field', '#press'].map((selector) =>
        buffer.page.locator(selector).boundingBox(),
      ),
    )
    labels.forEach((label, index) => {
      const box = boxes[index]
      if (box === null || box === undefined) throw new Error('a target has no box')
      expect(label.width).toBeGreaterThan(0)
      expect(Math.abs(label.x - box.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(label.y - box.y)).toBeLessThanOrEqual(1)
    })

    // The hostile page saw the host, and nothing in it: no shadow root, no text.
    await expect
      .poll(() =>
        buffer.page.evaluate(
          () => (globalThis as unknown as { __hostile: Hostile }).__hostile.seen,
        ),
      )
      .toBe(1)
    const hostile = await buffer.page.evaluate(
      () => (globalThis as unknown as { __hostile: Hostile }).__hostile,
    )
    expect(hostile.shadowRoots).toEqual(['null'])
    expect(hostile.texts).toEqual([''])
    // It hid the host, closed its popover and took it out: every label is
    // still the topmost thing at its own point, as the page's world sees it.
    for (const label of labels) {
      await expect
        .poll(() => topAt(buffer.page, label.x + label.width / 2, label.y + label.height / 2))
        .toBe('host DIV')
    }
    // The forged `a` sits over the second link, in the page's own DOM.
    expect(await buffer.page.locator('.forged').textContent()).toBe('a')

    // Typing `a` follows the first link, main's `a`, not the one the forgery covers.
    await press(app, buffer.contentsId, 'a')
    await expect.poll(() => buffer.page.url()).toBe(fixtures.secureUrl('semantic.html'))
    await expect.poll(() => modes(nemesis, ids)).toEqual(['document'])
    expect(await targets(app, ids)).toEqual([])
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})

test('F labels the links and copies the URL of the one typed', async () => {
  const fixtures = await fixtureServer()
  const scratch = mkdtempSync(join(tmpdir(), 'nemesis-hints-'))
  const clipboardFile = join(scratch, 'clipboard.txt')
  const nemesis = await launchNemesis({ env: { NEMESIS_CLIPBOARD_TEXT: clipboardFile } })
  const { app } = nemesis
  try {
    const url = fixtures.secureUrl('hints.html')
    const buffer = await nemesis.openPageBuffer(url)
    expect(buffer.loadError).toBeNull()
    const ids = buffer.ids
    if (ids === undefined) throw new Error('The page buffer has no ids')

    await press(app, buffer.contentsId, 'F', ['shift'])
    await expect.poll(async () => (await targets(app, ids)).length).toBe(2)
    const labelled = await targets(app, ids)
    expect(labelled.map((target) => [target.label, target.role])).toEqual([
      ['a', 'link'],
      ['s', 'link'],
    ])
    await press(app, buffer.contentsId, 's')
    await expect
      .poll(() => {
        try {
          return readFileSync(clipboardFile, 'utf8')
        } catch {
          return ''
        }
      })
      .toBe(fixtures.secureUrl('injection.html'))
    // A copy follows nothing.
    expect(buffer.page.url()).toBe(url)
    await expect.poll(() => modes(nemesis, ids)).toEqual(['document'])
  } finally {
    await nemesis.close()
    await fixtures.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a label on a field focuses it; a stray key does nothing; C-g leaves', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  const { app } = nemesis
  try {
    const url = fixtures.secureUrl('hints.html')
    const buffer = await nemesis.openPageBuffer(url)
    expect(buffer.loadError).toBeNull()
    const ids = buffer.ids
    if (ids === undefined) throw new Error('The page buffer has no ids')
    const focused = (): Promise<string> =>
      buffer.page.evaluate(
        () =>
          (globalThis as unknown as { document: { activeElement: { id: string } | null } }).document
            .activeElement?.id ?? '',
      )

    // C-g takes the labels down and the mode off; the page is where it was.
    await press(app, buffer.contentsId, 'f')
    await expect.poll(async () => (await targets(app, ids)).length).toBe(4)
    await press(app, buffer.contentsId, 'g', ['control'])
    await expect.poll(() => modes(nemesis, ids)).toEqual(['document'])
    expect(await targets(app, ids)).toEqual([])
    const first = (await drawn(app, ids))[0]
    expect(first).toBeUndefined()
    const box = await buffer.page.locator('#next').boundingBox()
    if (box === null) throw new Error('#next has no box')
    await expect.poll(() => topAt(buffer.page, box.x + 4, box.y + 4)).toBe('#next')

    // A key no label starts with is ignored; the field's label focuses the field.
    await press(app, buffer.contentsId, 'f')
    await expect.poll(async () => (await targets(app, ids)).length).toBe(4)
    await press(app, buffer.contentsId, 'z')
    expect(await modes(nemesis, ids)).toEqual(['hint', 'document'])
    await press(app, buffer.contentsId, 'd')
    await expect.poll(focused).toBe('field')
    await expect.poll(() => modes(nemesis, ids)).toEqual(['document'])
    expect(buffer.page.url()).toBe(url)
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
