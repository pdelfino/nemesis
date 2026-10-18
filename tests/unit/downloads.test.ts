import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentNoticeEvent } from '../../src/main/agent/events'
import {
  describeDownload,
  DownloadPolicy,
  formatBytes,
  QUARANTINE_FOLDER,
  quarantineValue,
  safeFilename,
  uniquePath,
  type DownloadItemSurface,
  type DownloadSurface,
  type QuarantineAttributes,
} from '../../src/main/security/downloads'

/**
 * The decision behind `will-download` (#51, SECURITY.org T2), on fakes: a
 * session that records what was installed and requested, an item that
 * records where it was told to land. The live handler, the real folder and
 * the real attribute are tests/e2e/security/downloads-quarantine.spec.ts.
 */

type WillDownload = (event: { preventDefault(): void }, item: DownloadItemSurface) => void

interface FakeSession extends DownloadSurface {
  handler: WillDownload | null
  downloadPath: string | null
  readonly requested: string[]
  installs: number
}

function fakeSession(): FakeSession {
  const session = {
    handler: null,
    downloadPath: null,
    requested: [],
    installs: 0,
    on(event: string, listener: WillDownload) {
      if (event === 'will-download') {
        session.installs += 1
        session.handler = listener
      }
      return session
    },
    setDownloadPath(path: string) {
      session.downloadPath = path
    },
    downloadURL(url: string) {
      session.requested.push(url)
    },
  } as unknown as FakeSession
  return session
}

interface FakeItem extends DownloadItemSurface {
  savePath: string | null
  done: ((event: unknown, state: string) => void) | null
}

function fakeItem(
  fields: { filename?: string; bytes?: number; url?: string; initiator?: string } = {},
): FakeItem {
  const item = {
    savePath: null,
    done: null,
    getFilename: () => fields.filename ?? 'report.pdf',
    getTotalBytes: () => fields.bytes ?? 1024,
    getURL: () => fields.url ?? 'https://files.example.org/report.pdf?token=secret',
    getInitiatorOrigin: () => fields.initiator ?? 'https://example.org',
    setSavePath(path: string) {
      item.savePath = path
    },
    once(event: string, listener: (event: unknown, state: string) => void) {
      if (event === 'done') item.done = listener
      return item
    },
  } as unknown as FakeItem
  return item
}

/** Offers `item` to the handler; true when the handler let it run. */
function offer(session: FakeSession, item: DownloadItemSurface): boolean {
  if (session.handler === null) throw new Error('no will-download handler installed')
  let prevented = false
  session.handler(
    {
      preventDefault() {
        prevented = true
      },
    },
    item,
  )
  return !prevented
}

function fakeAttributes(stored: Map<string, string>, writable = true): QuarantineAttributes {
  return {
    read: async (path) => stored.get(path) ?? null,
    write: async (path, value) => {
      if (writable) stored.set(path, value)
      return writable
    },
  }
}

const tick = () => new Promise((done) => setTimeout(done, 0))

describe('what a download is called (SECURITY.org T2)', () => {
  it('keeps one printable path segment, not hidden, not empty, not endless', () => {
    expect(safeFilename('report.pdf')).toBe('report.pdf')
    expect(safeFilename('../../etc/passwd')).toBe('passwd')
    expect(safeFilename('..\\..\\boot.ini')).toBe('boot.ini')
    expect(safeFilename('.bashrc')).toBe('bashrc')
    expect(safeFilename(' trailing dots... ')).toBe('trailing dots')
    expect(safeFilename(`re${String.fromCharCode(0x202e)}fdp.exe`)).toBe('refdp.exe')
    expect(safeFilename(`a${String.fromCharCode(0)}b${String.fromCharCode(0x200b)}c`)).toBe('abc')
    expect(safeFilename('')).toBe('download')
    expect(safeFilename('...')).toBe('download')
    const long = `${'x'.repeat(300)}.tar.gz`
    expect(safeFilename(long)).toHaveLength(120)
    expect(safeFilename(long).endsWith('.gz')).toBe(true)
  })

  it('shows the size in words a person reads', () => {
    expect(formatBytes(0)).toBe('unknown size')
    expect(formatBytes(-1)).toBe('unknown size')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('asks with the name, the size and the origin, never the URL', () => {
    expect(
      describeDownload({ filename: 'report.pdf', bytes: 1024, origin: 'https://example.org' }),
    ).toBe('Download report.pdf (1.0 KB) from https://example.org?')
    expect(describeDownload({ filename: 'x', bytes: 0, origin: null })).toBe(
      'Download x (unknown size) from an unknown origin?',
    )
  })

  it('writes a quarantine value in the shape LaunchServices does', () => {
    expect(quarantineValue(1_700_000_000_000)).toMatch(
      /^0081;6553f100;Nemesis;[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/,
    )
  })
})

describe('the download policy (SECURITY.org T2)', () => {
  const dirs: string[] = []
  function quarantineDir(): string {
    const dir = join(mkdtempSync(join(tmpdir(), 'nemesis-downloads-')), QUARANTINE_FOLDER)
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(join(dir, '..'), { recursive: true, force: true })
  })

  function setUp(answer: boolean | Error, attributes?: QuarantineAttributes) {
    const dir = quarantineDir()
    const confirm = vi.fn(async () => {
      if (answer instanceof Error) throw answer
      return answer
    })
    const policy = new DownloadPolicy({
      quarantineDir: dir,
      confirm,
      attributes: attributes ?? fakeAttributes(new Map()),
      platform: 'darwin',
    })
    const notices: string[] = []
    policy.on((event: AgentNoticeEvent) => notices.push(event.text))
    const session = fakeSession()
    policy.apply(session)
    return { dir, policy, confirm, notices, session }
  }

  it('installs once per session and points the session at the quarantine folder', () => {
    const { dir, policy, session } = setUp(false)
    policy.apply(session)
    expect(session.installs).toBe(1)
    expect(session.downloadPath).toBe(dir)
  })

  it('refuses the item the page offered, asks with its details, and on a no writes nothing', async () => {
    const { dir, confirm, notices, session } = setUp(false)
    const item = fakeItem()
    expect(offer(session, item)).toBe(false)
    expect(confirm).toHaveBeenCalledWith({
      filename: 'report.pdf',
      bytes: 1024,
      origin: 'https://example.org',
    })
    await tick()
    expect(session.requested).toEqual([])
    expect(item.savePath).toBeNull()
    expect(notices).toEqual([
      'Refused download of report.pdf (1.0 KB) from https://example.org: nothing was written (SECURITY.org, T2)',
    ])
    // The folder is not even created for a no.
    expect(() => uniquePath(dir, 'x')).not.toThrow()
    expect(notices.join(' ')).not.toContain('secret')
  })

  it('a confirmation that fails is a no', async () => {
    const { notices, session } = setUp(new Error('the window is gone'))
    expect(offer(session, fakeItem())).toBe(false)
    await tick()
    expect(session.requested).toEqual([])
    expect(notices[0]).toMatch(/^Refused download/)
  })

  it('on a yes requests the URL itself, once, and lets only that item run, into the folder, under the approved name', async () => {
    const { dir, confirm, notices, session } = setUp(true)
    const url = 'https://files.example.org/report.pdf?token=secret'
    expect(offer(session, fakeItem({ url }))).toBe(false)
    await tick()
    expect(session.requested).toEqual([url])

    // The item the policy asked for: the server may name it differently now.
    const second = fakeItem({ url, filename: 'something-else.exe', initiator: '' })
    expect(offer(session, second)).toBe(true)
    expect(second.savePath).toBe(join(dir, 'report.pdf'))
    expect(confirm).toHaveBeenCalledTimes(1)

    // The approval was for one item: the same URL offered again is asked about again.
    const third = fakeItem({ url })
    expect(offer(session, third)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)

    // Done: the attribute is there (the fake stores what was written), the user is told, nothing opened.
    second.done?.(null, 'completed')
    await tick()
    expect(notices).toEqual([
      `Saved report.pdf (1.0 KB) from https://example.org to ${dir}: quarantined, not opened`,
    ])
  })

  it('removes a completed file that cannot be given the quarantine attribute', async () => {
    const stored = new Map<string, string>()
    const { dir, notices, session } = setUp(true, fakeAttributes(stored, false))
    const url = 'https://files.example.org/report.pdf'
    offer(session, fakeItem({ url }))
    await tick()
    const item = fakeItem({ url })
    offer(session, item)
    const path = item.savePath ?? ''
    writeFileSync(path, 'bytes')
    item.done?.(null, 'completed')
    await tick()
    expect(() => uniquePath(dir, 'report.pdf')).not.toThrow()
    expect(uniquePath(dir, 'report.pdf')).toBe(path)
    expect(notices).toEqual([
      'Removed report.pdf (1.0 KB) from https://example.org: the file could not be quarantined (SECURITY.org, T2)',
    ])
  })

  it('trusts the attribute Chromium wrote and writes none of its own then', async () => {
    const stored = new Map<string, string>()
    const attributes = fakeAttributes(stored)
    const write = vi.spyOn(attributes, 'write')
    const { session } = setUp(true, attributes)
    const url = 'https://files.example.org/report.pdf'
    offer(session, fakeItem({ url }))
    await tick()
    const item = fakeItem({ url })
    offer(session, item)
    stored.set(item.savePath ?? '', '0081;0;Chromium;X')
    item.done?.(null, 'completed')
    await tick()
    expect(write).not.toHaveBeenCalled()
  })

  it('reports an interrupted or cancelled item and keeps nothing', async () => {
    const { notices, session } = setUp(true)
    const url = 'https://files.example.org/report.pdf'
    offer(session, fakeItem({ url }))
    await tick()
    const item = fakeItem({ url })
    offer(session, item)
    item.done?.(null, 'interrupted')
    expect(notices).toEqual([
      'Download of report.pdf (1.0 KB) from https://example.org interrupted: nothing was kept',
    ])
  })

  it('never lands two downloads on one name', () => {
    const dir = quarantineDir()
    rmSync(dir, { recursive: true, force: true })
    expect(uniquePath(dir, 'report.pdf')).toBe(join(dir, 'report.pdf'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'report.pdf'), '')
    expect(uniquePath(dir, 'report.pdf')).toBe(join(dir, 'report (2).pdf'))
    writeFileSync(join(dir, 'report (2).pdf'), '')
    expect(uniquePath(dir, 'report.pdf')).toBe(join(dir, 'report (3).pdf'))
    expect(uniquePath(dir, 'README')).toBe(join(dir, 'README'))
  })
})
