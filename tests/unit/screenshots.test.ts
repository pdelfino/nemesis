import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/main/agent/events'
import { CommandError } from '../../src/main/commands/registry'
import { screenshotFileName, Screenshots, type WindowSource } from '../../src/main/screenshots'

// Window screenshots (#81): the system's capture of a window, written under
// the sessions folder, its path for the prompt.

const AT = new Date(Date.UTC(2026, 9, 17, 16, 30, 45, 123))
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('the file name', () => {
  it('is the moment and the window title, as a shell and a prompt can carry it', () => {
    expect(screenshotFileName('Nemesis - dev build', AT)).toBe(
      '2026-10-17T16-30-45-nemesis-dev-build.png',
    )
    expect(screenshotFileName('  ', AT)).toBe('2026-10-17T16-30-45-window.png')
    expect(screenshotFileName('a'.repeat(60), AT)).toBe(`2026-10-17T16-30-45-${'a'.repeat(40)}.png`)
    expect(screenshotFileName('x-'.repeat(25), AT)).toBe(
      '2026-10-17T16-30-45-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x.png',
    )
  })
})

describe('the screenshots', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function harness(windows: readonly WindowSource[], pixels: Uint8Array | null = PNG) {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-shots-'))
    const folder = join(dir, 'screenshots')
    const captured: string[] = []
    const events: AgentEvent[] = []
    const screenshots = new Screenshots({
      dir: folder,
      now: () => AT,
      capturer: {
        list: () => Promise.resolve(windows),
        capture: (id) => {
          captured.push(id)
          return Promise.resolve(pixels)
        },
      },
    })
    screenshots.on((event) => events.push(event))
    return { screenshots, folder, captured, events }
  }

  it('lists the windows on refresh, captures one, writes the PNG and says where', async () => {
    const { screenshots, folder, captured, events } = harness([
      { id: 'window:1', name: 'Nemesis' },
      { id: 'window:2', name: 'Terminal' },
    ])
    expect(screenshots.windows).toEqual([])
    expect(await screenshots.refresh()).toHaveLength(2)
    expect(screenshots.windows.map((window) => window.name)).toEqual(['Nemesis', 'Terminal'])
    const shot = await screenshots.take('window:2')
    expect(captured).toEqual(['window:2'])
    expect(shot).toEqual({
      name: 'Terminal',
      path: join(folder, '2026-10-17T16-30-45-terminal.png'),
    })
    expect(readdirSync(folder)).toEqual(['2026-10-17T16-30-45-terminal.png'])
    expect(new Uint8Array(readFileSync(shot.path))).toEqual(PNG)
    expect(events).toEqual([
      {
        type: 'notice',
        text: `Screenshot of "Terminal" written to ${shot.path}; its path is in the prompt.`,
      },
    ])
  })

  it('refuses a window it did not list, and one that is gone, writing nothing', async () => {
    const { screenshots, folder, events } = harness([{ id: 'window:1', name: 'Nemesis' }], null)
    await expect(screenshots.take('window:1')).rejects.toThrow(CommandError)
    await screenshots.refresh()
    await expect(screenshots.take('window:9')).rejects.toThrow('not among the ones listed')
    await expect(screenshots.take('window:1')).rejects.toThrow('The window "Nemesis" is gone')
    expect(existsSync(folder)).toBe(false)
    expect(events).toEqual([])
  })
})
