import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PageSpec } from '../shared/buffers'
import { hostOf } from './security/transport'

/**
 * Session restore (#127): at quit, each window's page buffers and its folder
 * go to one file in the profile, `windows.json`; at the next start the same
 * windows reopen with their pages, each loaded when it is first shown.
 *
 * Only a page's URL and title are written, never its content. A page in the
 * `ephemeral` partition is never written, and a page that has not committed
 * a URL has nothing to write. Agent sessions are not part of this
 * (`resume-session`, #67): a restored window starts with no session.
 *
 * Nothing here touches Electron; the main process hands in the windows and
 * the path, so the unit tests run this against a temporary folder.
 */

export const WINDOWS_FILE = 'windows.json'

/** The command-line switch that skips the restore for one start. */
export const NO_RESTORE_SWITCH = '--no-restore'

/** The file's shape; a different number is a file this build does not read. */
const VERSION = 1
/** The same bounds a page buffer holds a URL and a title to. */
const MAX_URL = 8192
const MAX_TITLE = 200
/** More than this is no session a person left open; the rest is dropped. */
const MAX_WINDOWS = 64
const MAX_PAGES = 1000

export interface SavedPage {
  readonly url: string
  readonly title: string
  /** Always `persistent`: an `ephemeral` page is never saved. */
  readonly partition: 'persistent'
}

export interface SavedWindow {
  /** The folder the window ran in. */
  readonly cwd: string
  readonly pages: readonly SavedPage[]
  /** The index in `pages` of the window's current buffer, or null when that was not a saved page. */
  readonly current: number | null
}

/** One page buffer as the cockpit holds it at quit. */
export interface OpenPage {
  readonly id: string
  readonly url?: string | undefined
  readonly title: string
  readonly partition: NonNullable<PageSpec['partition']> | undefined
}

export class RestoreError extends Error {
  override readonly name = 'RestoreError'
}

/** What one window leaves in the file: its folder, its persistent pages with a URL, the current one. */
export function savedWindow(
  cwd: string,
  pages: readonly OpenPage[],
  currentId: string | null,
): SavedWindow {
  const kept = pages.filter(
    (page): page is OpenPage & { url: string } =>
      page.partition === 'persistent' && page.url !== undefined && page.url.length > 0,
  )
  const index = kept.findIndex((page) => page.id === currentId)
  return {
    cwd,
    pages: kept.map((page) => ({
      url: page.url,
      title: page.title,
      partition: 'persistent',
    })),
    current: index === -1 ? null : index,
  }
}

export function serializeWindows(windows: readonly SavedWindow[]): string {
  return `${JSON.stringify({ version: VERSION, windows }, null, 2)}\n`
}

/** Writes the file whole, through a temporary name, readable by the user alone. */
export function saveWindows(path: string, windows: readonly SavedWindow[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, serializeWindows(windows), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/** The windows of the file, or none when there is no file. Throws a RestoreError on a file it cannot use. */
export function loadWindows(path: string): SavedWindow[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new RestoreError(`${path} is not valid JSON: ${describe(error)}`)
  }
  try {
    return parseWindows(parsed)
  } catch (error) {
    throw new RestoreError(`${path}: ${describe(error)}`)
  }
}

/**
 * Validates the file by hand, shape only. A page that is not a usable
 * `http:` or `https:` URL, or that names any partition but `persistent`, is
 * dropped rather than failing the whole file: the rest of the session still
 * comes back.
 */
export function parseWindows(payload: unknown): SavedWindow[] {
  if (!isRecord(payload)) throw new RestoreError('The windows file is not an object')
  if (payload['version'] !== VERSION) {
    throw new RestoreError(`The windows file is not version ${VERSION}`)
  }
  const windows = payload['windows']
  if (!Array.isArray(windows)) throw new RestoreError('The windows file has no windows list')
  return windows.slice(0, MAX_WINDOWS).map((raw, index) => parseWindow(raw, index))
}

function parseWindow(raw: unknown, index: number): SavedWindow {
  if (!isRecord(raw)) throw new RestoreError(`Window ${index + 1} is not an object`)
  const cwd = raw['cwd']
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new RestoreError(`Window ${index + 1} has no folder`)
  }
  const rawPages = raw['pages']
  if (!Array.isArray(rawPages)) throw new RestoreError(`Window ${index + 1} has no pages list`)
  const rawCurrent = raw['current'] ?? null
  const current = Number.isInteger(rawCurrent) ? (rawCurrent as number) : null
  const pages: SavedPage[] = []
  let kept: number | null = null
  rawPages.slice(0, MAX_PAGES).forEach((one, position) => {
    const page = parsePage(one)
    if (page === null) return
    if (position === current) kept = pages.length
    pages.push(page)
  })
  return { cwd, pages, current: kept }
}

function parsePage(raw: unknown): SavedPage | null {
  if (!isRecord(raw) || raw['partition'] !== 'persistent') return null
  const url = raw['url']
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL) return null
  let href: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    href = parsed.href
  } catch {
    return null
  }
  const title = typeof raw['title'] === 'string' ? raw['title'].trim().slice(0, MAX_TITLE) : ''
  return { url: href, title: title.length > 0 ? title : hostOf(href), partition: 'persistent' }
}

/** Whether this start skips the restore: the `restore` setting off, or `--no-restore` given. */
export function restoreSkipped(restore: boolean, argv: readonly string[]): boolean {
  return !restore || argv.includes(NO_RESTORE_SWITCH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
