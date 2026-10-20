import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The wrapper registers through Electron's ipcMain, which does not exist
// outside the main process; the mock records the registration and the rest
// of the file runs the pure parts on fake events.
const registered = vi.fn()
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: registered },
}))

const { describeOrigin, guard, handle, handleIn, isInternalPage, parseNothing, topFrameUrl } =
  await import('../../src/main/ipc')
const { BUFFERS_CHANNEL } = await import('../../src/shared/buffers')
const { KEY_CHANNEL } = await import('../../src/shared/keys')
const { parseKeyPress } = await import('../../src/main/commands/dispatcher')

const COCKPIT = 'nemesis://app/'

/** A sender frame as `handle()` sees it: the URL and whether it is the top frame. */
function frame(url: string, parent: unknown = null) {
  return { senderFrame: { url, parent } as never }
}

describe('what counts as an internal page (SECURITY.org, T1)', () => {
  it('accepts a page on the internal origin nemesis://app (#50)', () => {
    expect(isInternalPage(COCKPIT)).toBe(true)
    expect(isInternalPage('nemesis://app/help.html')).toBe(true)
    expect(isInternalPage(`${COCKPIT}#transcript`)).toBe(true)
  })

  it('rejects any file, another host on the scheme, any web origin and anything unparseable', () => {
    expect(isInternalPage('file:///app/out/renderer/index.html')).toBe(false)
    expect(isInternalPage('file:///Users/pedro/Downloads/renderer/index.html')).toBe(false)
    expect(isInternalPage('nemesis://evil/')).toBe(false)
    expect(isInternalPage('nemesis://app.evil.test/')).toBe(false)
    expect(isInternalPage('https://example.com/renderer/index.html')).toBe(false)
    expect(isInternalPage('http://127.0.0.1:4000/node-probe.html')).toBe(false)
    expect(isInternalPage('about:blank')).toBe(false)
    expect(isInternalPage('')).toBe(false)
    expect(isInternalPage('not a url')).toBe(false)
  })

  it('rejects a config page, which shares the origin but is a page buffer (#181)', () => {
    expect(isInternalPage('nemesis://app/user/tools')).toBe(false)
    expect(isInternalPage('nemesis://app/user/tools?q=1')).toBe(false)
  })

  it('accepts the Vite dev server only when its URL is given', () => {
    const page = 'http://localhost:5173/index.html'
    expect(isInternalPage(page, 'http://localhost:5173')).toBe(true)
    expect(isInternalPage(page)).toBe(false)
    expect(isInternalPage(page, '')).toBe(false)
    expect(isInternalPage('http://localhost:5174/index.html', 'http://localhost:5173')).toBe(false)
  })

  it('reads only a live top frame', () => {
    expect(topFrameUrl({ url: COCKPIT, parent: null })).toBe(COCKPIT)
    expect(topFrameUrl({ url: COCKPIT, parent: { url: COCKPIT, parent: null } })).toBeNull()
    expect(topFrameUrl(null)).toBeNull()
    expect(topFrameUrl(undefined)).toBeNull()
    const disposed = {
      get url(): string {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      },
      parent: null,
    }
    expect(topFrameUrl(disposed)).toBeNull()
  })

  it('describes a sender by origin only, never by path', () => {
    expect(describeOrigin('http://127.0.0.1:4000/node-probe.html?secret=1')).toBe(
      'http://127.0.0.1:4000',
    )
    expect(describeOrigin(`${COCKPIT}?secret=1`)).toBe('nemesis://app')
    expect(describeOrigin(null)).toBe('no top frame')
    expect(describeOrigin('nonsense')).toBe('an unparseable URL')
  })
})

describe('the guarded handler', () => {
  let warnings: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnings.mockRestore()
  })

  it('runs the handler for an internal page with a valid payload', async () => {
    const run = vi.fn((press) => ({ status: 'command' as const, chord: press.key }))
    const listener = guard(KEY_CHANNEL, parseKeyPress, run)
    await expect(listener(frame(COCKPIT), { key: 'x', code: 'KeyX' })).resolves.toEqual({
      status: 'command',
      chord: 'x',
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(warnings).not.toHaveBeenCalled()
  })

  it('drops a call from a web page before parsing, and logs channel and origin only', async () => {
    const parse = vi.fn(parseKeyPress)
    const run = vi.fn()
    const listener = guard(KEY_CHANNEL, parse, run)
    const page = 'http://127.0.0.1:4000/node-probe.html?token=do-not-log'
    await expect(listener(frame(page), { key: 'x', code: 'KeyX' })).rejects.toThrow(
      /not an internal page/,
    )
    expect(parse).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(warnings).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveBeenCalledWith('ipc: dropped nemesis:key from http://127.0.0.1:4000')
  })

  it('drops a subframe and a missing frame', async () => {
    const run = vi.fn()
    const listener = guard(KEY_CHANNEL, parseKeyPress, run)
    await expect(listener(frame(COCKPIT, {}), { key: 'x', code: 'KeyX' })).rejects.toThrow(
      /not an internal page/,
    )
    await expect(listener({ senderFrame: null }, { key: 'x', code: 'KeyX' })).rejects.toThrow(
      /not an internal page/,
    )
    expect(run).not.toHaveBeenCalled()
    expect(warnings).toHaveBeenCalledWith('ipc: dropped nemesis:key from no top frame')
  })

  it('drops a bad payload from an internal page without logging it', async () => {
    const run = vi.fn()
    const listener = guard(KEY_CHANNEL, parseKeyPress, run)
    await expect(listener(frame(COCKPIT), { secret: 'do-not-log' })).rejects.toThrow(/usable key/)
    expect(run).not.toHaveBeenCalled()
    expect(warnings).toHaveBeenCalledWith(
      'ipc: dropped nemesis:key from nemesis://app: payload rejected',
    )
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('do-not-log')
  })

  it('takes the dev server from the environment in a development run', async () => {
    const run = vi.fn(() => ({ buffers: [], currentId: null }))
    const page = 'http://localhost:5173/index.html'
    await expect(guard(BUFFERS_CHANNEL, parseNothing, run)(frame(page), undefined)).rejects.toThrow(
      /not an internal page/,
    )
    await expect(
      guard(BUFFERS_CHANNEL, parseNothing, run, 'http://localhost:5173')(frame(page), undefined),
    ).resolves.toEqual({ buffers: [], currentId: null })
  })

  it('refuses a payload on a channel that takes none', () => {
    expect(parseNothing(undefined)).toBeUndefined()
    expect(() => parseNothing(null)).toThrow(/no payload/)
    expect(() => parseNothing({})).toThrow(/no payload/)
  })

  it('registers on ipcMain under the channel name', () => {
    handle(BUFFERS_CHANNEL, parseNothing, () => ({ buffers: [], currentId: null }))
    expect(registered).toHaveBeenCalledWith(BUFFERS_CHANNEL, expect.any(Function))
  })
})

describe('the per-window handlers (#70, #136)', () => {
  /** The listener `handleIn` registered on ipcMain for a channel. */
  function registeredFor(channel: string) {
    const call = registered.mock.calls.find(([name]) => name === channel)
    if (call === undefined) throw new Error(`nothing registered on ${channel}`)
    return call[1] as (event: unknown, payload: unknown) => Promise<unknown>
  }

  it('adds one destroyed listener for twenty channels, and destroying it removes every handler', async () => {
    const owner = Object.assign(new EventEmitter(), { id: 4242 })
    const channels = Array.from({ length: 20 }, (_, index) => `nemesis:test-${index}`)
    for (const channel of channels) {
      handleIn(owner as never, channel as never, parseNothing as never, (() => channel) as never)
    }
    expect(owner.listenerCount('destroyed')).toBe(1)

    const event = { ...frame(COCKPIT), sender: { id: owner.id } }
    for (const channel of channels) {
      await expect(registeredFor(channel)(event, undefined)).resolves.toBe(channel)
    }

    owner.emit('destroyed')
    expect(owner.listenerCount('destroyed')).toBe(0)
    for (const channel of channels) {
      await expect(registeredFor(channel)(event, undefined)).rejects.toThrow(/has no cockpit/)
    }
  })
})
