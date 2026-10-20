import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadWindows,
  parseWindows,
  restoreSkipped,
  savedWindow,
  saveWindows,
  serializeWindows,
  WINDOWS_FILE,
  windowsToSave,
  type OpenPage,
} from '../../src/main/restore'

/**
 * Session restore (#127): what each window leaves in windows.json at quit,
 * and what the next start reads back. The live run, two windows quit and
 * relaunched on one profile, is tests/e2e/restore.spec.ts.
 */

const folders: string[] = []

function profile(): string {
  const folder = mkdtempSync(join(tmpdir(), 'nemesis-restore-'))
  folders.push(folder)
  return folder
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const pages: readonly OpenPage[] = [
  { id: 'b3', url: 'https://example.com/a', title: 'Example A', partition: 'persistent' },
  { id: 'b4', url: 'https://secret.example/', title: 'Secret', partition: 'ephemeral' },
  { id: 'b5', url: 'https://example.com/b', title: 'Example B', partition: 'persistent' },
  { id: 'b6', title: 'Page', partition: 'persistent' },
]

describe('what a window leaves at quit', () => {
  it('keeps the persistent pages with a URL, in order, and drops the ephemeral one', () => {
    expect(savedWindow('/work/project', pages, 'b5')).toEqual({
      cwd: '/work/project',
      pages: [
        { url: 'https://example.com/a', title: 'Example A', partition: 'persistent' },
        { url: 'https://example.com/b', title: 'Example B', partition: 'persistent' },
      ],
      current: 1,
    })
  })

  it('has no current page when the current buffer is not a saved page', () => {
    expect(savedWindow('/work', pages, 'b2').current).toBeNull()
    // The current page was ephemeral: it is not saved, and neither is its being current.
    expect(savedWindow('/work', pages, 'b4').current).toBeNull()
  })

  it('writes no URL, title or trace of an ephemeral page to the file', () => {
    const text = serializeWindows([savedWindow('/work', pages, 'b4')])
    expect(text).not.toContain('secret')
    expect(text).not.toContain('Secret')
    expect(text).not.toContain('ephemeral')
  })
})

describe('the windows file', () => {
  it('round-trips two windows through the profile, readable by the user alone', () => {
    const file = join(profile(), WINDOWS_FILE)
    const windows = [
      savedWindow('/work/one', pages, 'b5'),
      savedWindow('/work/two', [pages[0] as OpenPage], null),
    ]
    saveWindows(file, windows)
    expect(loadWindows(file)).toEqual(windows)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('reads no file as no windows', () => {
    expect(loadWindows(join(profile(), WINDOWS_FILE))).toEqual([])
  })

  it('refuses a file that is not JSON or not this shape, naming the file', () => {
    const file = join(profile(), WINDOWS_FILE)
    writeFileSync(file, '{ not json')
    expect(() => loadWindows(file)).toThrow(/windows\.json is not valid JSON/)
    writeFileSync(file, JSON.stringify({ version: 2, windows: [] }))
    expect(() => loadWindows(file)).toThrow(/not version 1/)
    expect(() => parseWindows({ version: 1, windows: [{ pages: [] }] })).toThrow(/no folder/)
  })

  it('drops an ephemeral page, a page that is not http or https, and moves current with them', () => {
    const windows = parseWindows({
      version: 1,
      windows: [
        {
          cwd: '/work',
          pages: [
            { url: 'https://hidden.example/', title: 'Hidden', partition: 'ephemeral' },
            { url: 'file:///etc/passwd', title: 'File', partition: 'persistent' },
            { url: 'https://example.com/a', title: '  ', partition: 'persistent' },
          ],
          current: 2,
        },
      ],
    })
    expect(windows).toEqual([
      {
        cwd: '/work',
        pages: [{ url: 'https://example.com/a', title: 'example.com', partition: 'persistent' }],
        current: 0,
      },
    ])
  })
})

describe('when the restore is skipped', () => {
  it('skips on the setting off or the --no-restore switch, and runs otherwise', () => {
    expect(restoreSkipped(true, ['electron', '.'])).toBe(false)
    expect(restoreSkipped(false, ['electron', '.'])).toBe(true)
    expect(restoreSkipped(true, ['electron', '.', '--no-restore'])).toBe(true)
  })
})

describe('windowsToSave', () => {
  it('leaves out the windows of background sessions (#158)', () => {
    const windows = [{ id: 1 }, { id: 2 }, { id: 3 }]
    expect(windowsToSave(windows, new Set([2]))).toEqual([{ id: 1 }, { id: 3 }])
    expect(windowsToSave(windows, new Set())).toEqual(windows)
  })
})
