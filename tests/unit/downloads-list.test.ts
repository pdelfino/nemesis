import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prompter } from '../../src/main/commands/prompter'
import type { Command } from '../../src/main/commands/registry'
import {
  downloadsCommands,
  downloadStateText,
  renderDownloads,
  type DownloadsSource,
} from '../../src/main/downloads-list'
import type { HelpBuffers } from '../../src/main/help'
import type { DownloadEntry } from '../../src/main/security/downloads'

/** The downloads buffer and its commands (#177), on a fake list. */

function entry(fields: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    id: 'd1',
    url: 'https://files.example.org/report.pdf',
    filename: 'report.pdf',
    path: '/tmp/nemesis-quarantine/report.pdf',
    totalBytes: 2048,
    receivedBytes: 0,
    state: 'started',
    ...fields,
  }
}

function setUp(entries: DownloadEntry[]) {
  const shown: string[] = []
  const help = { show: (text: string) => shown.push(text) } as unknown as HelpBuffers
  const prompter = new Prompter()
  const cancelled: string[] = []
  const source: DownloadsSource = {
    list: () => entries,
    cancel: (id) => {
      cancelled.push(id)
      return entries.some((each) => each.id === id && each.state === 'progress')
    },
  }
  const reveal = vi.fn()
  const commands = downloadsCommands(source, { help, prompter, reveal })
  const run = (name: string, answers: string[] = []) => {
    const command = commands.find((each: Command) => each.name === name)
    if (command === undefined) throw new Error(`no ${name}`)
    return prompter.scripted(answers, () => command.run({ source: 'test' }))
  }
  return { shown, cancelled, reveal, run, prompter }
}

describe('the downloads buffer (#177)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('shows each download with its URL, name, size and state', () => {
    expect(renderDownloads([])).toBe('No downloads yet in this session.')
    const text = renderDownloads([
      entry({ state: 'progress', receivedBytes: 1024 }),
      entry({ id: 'd2', filename: 'a.zip', state: 'done' }),
      entry({ id: 'd3', filename: 'b.zip', state: 'cancelled' }),
    ])
    expect(text).toContain('report.pdf  2.0 KB  [1.0 KB of 2.0 KB (50%)]')
    expect(text).toContain('  https://files.example.org/report.pdf')
    expect(text).toContain('a.zip  2.0 KB  [done]\n  https://files.example.org/report.pdf\n  /tmp/')
    expect(text).toContain('b.zip  2.0 KB  [cancelled]')
    expect(downloadStateText(entry({ state: 'failed' }))).toBe('failed')
  })

  it('list-downloads puts the list in the help buffer', async () => {
    const { shown, run } = setUp([entry()])
    await run('list-downloads')
    expect(shown[0]).toContain('report.pdf  2.0 KB  [started]')
  })

  it('cancel-download offers only running downloads and cancels the one picked', async () => {
    const { shown, cancelled, run } = setUp([
      entry({ id: 'd1', state: 'progress' }),
      entry({ id: 'd2', state: 'done' }),
    ])
    await expect(run('cancel-download', ['d2'])).rejects.toThrow(/not among the candidates/)
    await run('cancel-download', ['d1'])
    expect(cancelled).toEqual(['d1'])
    expect(shown.at(-1)).toBe('Cancelled the download of report.pdf')
  })

  it('cancel-download with nothing running says so and reads nothing', async () => {
    const { shown, prompter, run } = setUp([entry({ state: 'done' })])
    await run('cancel-download')
    expect(shown).toEqual(['No download is running.'])
    expect(prompter.pending).toBeNull()
  })

  it('reveal-download selects a finished file in Finder, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nemesis-reveal-'))
    dirs.push(dir)
    const path = join(dir, 'report.pdf')
    writeFileSync(path, '')
    const { shown, reveal, run } = setUp([
      entry({ id: 'd1', state: 'progress' }),
      entry({ id: 'd2', state: 'done', path }),
      entry({ id: 'd3', state: 'done', path: join(dir, 'gone.pdf'), filename: 'gone.pdf' }),
    ])
    await expect(run('reveal-download', ['d1'])).rejects.toThrow(/not among the candidates/)
    await run('reveal-download', ['d2'])
    expect(reveal).toHaveBeenCalledWith(path)
    await run('reveal-download', ['d3'])
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(shown.at(-1)).toContain('gone.pdf is no longer at')
  })

  it('reveal-download with nothing finished says so', async () => {
    const { shown, reveal, run } = setUp([entry({ state: 'progress' })])
    await run('reveal-download')
    expect(shown).toEqual(['No download has finished.'])
    expect(reveal).not.toHaveBeenCalled()
  })
})
