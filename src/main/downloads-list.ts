import { existsSync } from 'node:fs'
import type { Prompter } from './commands/prompter'
import { defineCommand, type Command } from './commands/registry'
import type { HelpBuffers } from './help'
import { formatBytes, type DownloadEntry } from './security/downloads'

/**
 * The downloads buffer (#177), Nyxt's list-downloads: every download the
 * user said yes to this session, with its URL, name, size and state, read
 * from the policy that tracks them (src/main/security/downloads.ts). A
 * running one can be cancelled; a finished one can be revealed in Finder,
 * which selects the file and opens nothing, so the quarantine attribute
 * stays and Gatekeeper decides on open (#51, SECURITY.org T2). Lost on quit.
 */

/** What the commands read and steer: the download policy. */
export interface DownloadsSource {
  list(): readonly DownloadEntry[]
  cancel(id: string): boolean
}

export interface DownloadsCommandDeps {
  readonly help: HelpBuffers
  readonly prompter: Prompter
  /** Selects a file in Finder: `shell.showItemInFolder`. Never opens it. */
  readonly reveal: (path: string) => void
}

/** The palette sources the commands read from. */
export const RUNNING_DOWNLOADS_SOURCE = 'running-downloads'
export const FINISHED_DOWNLOADS_SOURCE = 'finished-downloads'

/** `512 B of 1.0 KB`, `done`, `cancelled`: the state column. */
export function downloadStateText(entry: DownloadEntry): string {
  if (entry.state === 'started') return 'started'
  if (entry.state === 'progress') {
    const of = entry.totalBytes > 0 ? ` of ${formatBytes(entry.totalBytes)}` : ''
    const percent =
      entry.totalBytes > 0
        ? ` (${Math.floor((entry.receivedBytes / entry.totalBytes) * 100)}%)`
        : ''
    return `${formatBytes(entry.receivedBytes)}${of}${percent}`
  }
  return entry.state
}

/** The text of list-downloads: one block per download, newest last. */
export function renderDownloads(entries: readonly DownloadEntry[]): string {
  if (entries.length === 0) return 'No downloads yet in this session.'
  const lines = ['Downloads of this session (cancel-download, reveal-download)', '']
  for (const entry of entries) {
    lines.push(`${entry.filename}  ${formatBytes(entry.totalBytes)}  [${downloadStateText(entry)}]`)
    lines.push(`  ${entry.url}`)
    if (entry.state === 'done') lines.push(`  ${entry.path}`)
  }
  return lines.join('\n')
}

const running = (entry: DownloadEntry): boolean =>
  entry.state === 'started' || entry.state === 'progress'

export function downloadsCommands(
  downloads: DownloadsSource,
  deps: DownloadsCommandDeps,
): readonly Command[] {
  const { help, prompter, reveal } = deps
  const candidates = (keep: (entry: DownloadEntry) => boolean) => () =>
    downloads
      .list()
      .filter(keep)
      .map((entry) => ({
        id: entry.id,
        label: entry.filename,
        doc: entry.url,
        detail: downloadStateText(entry),
      }))
  prompter.addSource({ name: RUNNING_DOWNLOADS_SOURCE, candidates: candidates(running) })
  prompter.addSource({
    name: FINISHED_DOWNLOADS_SOURCE,
    candidates: candidates((entry) => entry.state === 'done'),
  })
  return [
    defineCommand({
      name: 'list-downloads',
      mcp: 'yes',
      doc: 'Show every download of this session with its URL, name, size and state.',
      run: () => {
        help.show(renderDownloads(downloads.list()))
      },
    }),
    defineCommand({
      name: 'cancel-download',
      mcp: 'yes',
      doc: 'Pick a running download and cancel it; nothing of it is kept.',
      run: () => {
        if (!downloads.list().some(running)) {
          help.show('No download is running.')
          return
        }
        prompter.read({ source: RUNNING_DOWNLOADS_SOURCE, prompt: 'Cancel download:' }, (id) => {
          const entry = downloads.list().find((each) => each.id === id)
          if (entry === undefined) return
          help.show(
            downloads.cancel(id)
              ? `Cancelled the download of ${entry.filename}`
              : `The download of ${entry.filename} is no longer running`,
          )
        })
      },
    }),
    defineCommand({
      name: 'reveal-download',
      mcp: 'never',
      doc: 'Pick a finished download and select its file in Finder; the file is not opened and stays quarantined.',
      run: () => {
        if (!downloads.list().some((entry) => entry.state === 'done')) {
          help.show('No download has finished.')
          return
        }
        prompter.read({ source: FINISHED_DOWNLOADS_SOURCE, prompt: 'Reveal download:' }, (id) => {
          const entry = downloads.list().find((each) => each.id === id)
          if (entry === undefined || entry.state !== 'done') return
          if (!existsSync(entry.path)) {
            help.show(`${entry.filename} is no longer at ${entry.path}`)
            return
          }
          reveal(entry.path)
        })
      },
    }),
  ]
}
