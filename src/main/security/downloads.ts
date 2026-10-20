import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { DownloadItem, Event, Session } from 'electron'
import type { AgentNoticeEvent } from '../agent/events'
import { originOf, type NoticeListener } from './permissions'

/**
 * Downloads opt-in, quarantined, never opened (#51, SECURITY.org T2).
 *
 * Nothing a page offers reaches the downloads folder without a yes. The
 * first request is refused in `will-download` the moment it arrives, after
 * reading what it was: filename, size and origin. Refusing
 * (`event.preventDefault()`) is the only way to be sure, because Chromium
 * writes a download as the bytes come and a paused item that already has
 * every byte completes on its own; for a small file that is before any
 * prompt could be answered. The user is then asked. On a yes, the policy
 * requests the same URL again itself, and that second item is recognized,
 * pinned to a path inside the quarantine folder and allowed to run; the
 * file keeps the name the user said yes to.
 *
 * Chromium buffers an offer before `will-download` fires: the first bytes,
 * and for a small file all of them, go to a hidden temporary file in the
 * app's downloads path (#137, traced 2026-OCTOBER-19). So the app's
 * downloads path is not the user's: startup points it at this run's staging
 * folder in the profile (`prepareStaging`), owner-only and removed at quit,
 * and a dead run's folder goes at the next start. A no is a no: nothing
 * reaches the downloads folder, and Chromium deletes the buffer of the item
 * it refused. A yes is good for one request
 * within `APPROVAL_TTL_MS` (#100): when the re-request never arrives (a
 * network error), the approval would otherwise sit by URL until any page
 * asked for that URL again, so a late item is refused and asked about anew.
 *
 * Every file lands in `~/Downloads/nemesis-quarantine/` (`QUARANTINE_FOLDER`
 * under the user's downloads folder) and nowhere else: the save path is set
 * here, never read from a dialog, and the session's own download path is the
 * same folder, so no fallback could put a finished file elsewhere; the only
 * other place an offer's bytes exist is the staging folder above. On macOS a completed
 * file is checked for the `com.apple.quarantine` attribute Gatekeeper reads;
 * a file that has none is given one, and a file that cannot be marked is
 * removed. Nothing is ever opened: no `shell.openPath`. The one door out is
 * reveal-download (#177): it selects a finished, quarantined file in Finder,
 * from the downloads list, when the user asks, and opens nothing; Gatekeeper
 * decides when the user opens it from there.
 *
 * Every approved item is listed for the session (#177): its URL, name, size
 * and state, fed from the item's own `updated` and `done` events, so
 * list-downloads can show it and cancel-download can stop it while it runs.
 *
 * The policy knows nothing of the palette: `confirm` is a function that
 * answers yes or no, and the cockpit wires it to the prompt buffer
 * (src/main/commands/confirm.ts). `apply()` installs on a session once, from
 * `web-contents-created` and from the partitions, the way #49 does.
 */

/** The folder under the user's downloads folder. Nothing lands outside it. */
export const QUARANTINE_FOLDER = 'nemesis-quarantine'

/** The folder in the profile where Chromium buffers an offer before anyone is asked (#137). */
export const STAGING_FOLDER = 'download-staging'

/** The attribute Gatekeeper reads before a downloaded file opens. */
export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'

/** How long a yes waits for the request the policy makes for it. */
export const APPROVAL_TTL_MS = 30_000

/** The name a file gets when the page offered none worth keeping. */
const FALLBACK_FILENAME = 'download'

/** Longer names are cut, extension kept: a name is for reading, not for hiding in. */
const MAX_FILENAME = 120

/**
 * Makes this run's staging folder, `<root>/<pid>`, owner-only, and removes
 * every other entry of the root except the folder of a run that is still
 * alive: two runs can share a profile, and a live run's buffer is in use.
 * Removal never follows a link: a symlink in the root is unlinked and its
 * target is left alone. Returns the folder to give Chromium (#137).
 */
export function prepareStaging(
  root: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = processAlive,
): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const owner = /^[1-9][0-9]{0,9}$/.test(entry.name) ? Number(entry.name) : 0
    if (entry.isDirectory() && owner !== 0 && owner !== pid && alive(owner)) continue
    rmSync(join(root, entry.name), { recursive: true, force: true })
  }
  const dir = join(root, String(pid))
  mkdirSync(dir, { mode: 0o700 })
  return dir
}

/** Removes this run's staging folder at quit, with whatever Chromium still buffered in it. */
export function removeStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** A process that exists, ours or not: signal 0 checks without sending anything. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What the user is asked about, in words that are safe to show. */
export interface DownloadRequest {
  /** The name the file will have on disk, already sanitized. */
  readonly filename: string
  /** From the response, or 0 when the server did not say. */
  readonly bytes: number
  /** Scheme and host of the page that started it, or null when unknown. */
  readonly origin: string | null
}

export type DownloadConfirm = (request: DownloadRequest) => Promise<boolean>

/** Reads and writes the quarantine attribute. The default shells out to xattr; a fake stands in for the unit tests. */
export interface QuarantineAttributes {
  read(path: string): Promise<string | null>
  write(path: string, value: string): Promise<boolean>
}

/** The minimum of a Session the policy installs on. */
export type DownloadSurface = Pick<Session, 'on' | 'setDownloadPath' | 'downloadURL'>

/** The minimum of a DownloadItem the policy reads and steers. */
export type DownloadItemSurface = Pick<
  DownloadItem,
  | 'getFilename'
  | 'getTotalBytes'
  | 'getReceivedBytes'
  | 'getURL'
  | 'getInitiatorOrigin'
  | 'setSavePath'
  | 'on'
  | 'once'
  | 'cancel'
>

/** Where a listed download stands (#177). `done` is a file kept in quarantine; `failed` kept nothing. */
export type DownloadState = 'started' | 'progress' | 'done' | 'failed' | 'cancelled'

/** One approved download of the session, as list-downloads shows it (#177). */
export interface DownloadEntry {
  readonly id: string
  readonly url: string
  readonly filename: string
  /** Inside the quarantine folder; the file exists only while `state` is `done`. */
  readonly path: string
  readonly totalBytes: number
  readonly receivedBytes: number
  readonly state: DownloadState
}

/** How many entries the list keeps; the oldest finished ones go first. */
export const DOWNLOAD_LIST_LIMIT = 200

export interface DownloadPolicyOptions {
  readonly quarantineDir: string
  readonly confirm: DownloadConfirm
  readonly attributes?: QuarantineAttributes | undefined
  /** `process.platform` unless a test says otherwise; the attribute is a macOS thing. */
  readonly platform?: string | undefined
  /** `Date.now` unless a test says otherwise; dates the approvals. */
  readonly now?: (() => number) | undefined
}

/** A yes, and when it was given. */
interface Approval {
  readonly request: DownloadRequest
  readonly at: number
}

/** Control characters, bidi overrides and zero-width marks: nothing a name needs, everything a trick does. */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * The name a download lands under: one path segment, printable, not hidden,
 * not empty, not longer than a name needs to be. Chromium sanitizes the
 * suggested name already; this is the second lock on the same door.
 */
export function safeFilename(suggested: string): string {
  let name = basename(suggested.replace(/\\/g, '/'))
    .replace(UNPRINTABLE, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (name.length > MAX_FILENAME) {
    const extension = extname(name).slice(0, 16)
    name = `${name.slice(0, MAX_FILENAME - extension.length)}${extension}`
  }
  return name.length === 0 ? FALLBACK_FILENAME : name
}

/** `1.0 KB`, `12.3 MB`, `unknown size`: what the user reads beside the name. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The question, as the prompt buffer shows it. */
export function describeDownload(request: DownloadRequest): string {
  return `Download ${request.filename} (${formatBytes(request.bytes)}) from ${siteOf(request.origin)}?`
}

function siteOf(origin: string | null): string {
  return origin ?? 'an unknown origin'
}

/** A path inside `dir` for `filename` that no existing file holds: `name (2).ext` when `name.ext` is taken. */
export function uniquePath(dir: string, filename: string): string {
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  let candidate = join(dir, filename)
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(dir, `${stem} (${n})${extension}`)
  }
  return candidate
}

/** The value LaunchServices would write: flags, seconds since the epoch in hex, the agent, an id. */
export function quarantineValue(now = Date.now()): string {
  return `0081;${Math.floor(now / 1000).toString(16)};Nemesis;${randomUUID().toUpperCase()}`
}

/** `xattr`, by absolute path, with arguments and never a shell. */
const XATTR = '/usr/bin/xattr'

export const xattrAttributes: QuarantineAttributes = {
  read: (path) =>
    new Promise((done) => {
      execFile(XATTR, ['-p', QUARANTINE_ATTRIBUTE, path], (error, stdout) => {
        const value = stdout.trim()
        done(error || value.length === 0 ? null : value)
      })
    }),
  write: (path, value) =>
    new Promise((done) => {
      execFile(XATTR, ['-w', QUARANTINE_ATTRIBUTE, value, path], (error) => done(!error))
    }),
}

export class DownloadPolicy {
  readonly quarantineDir: string
  private readonly confirm: DownloadConfirm
  private readonly attributes: QuarantineAttributes
  private readonly platform: string
  private readonly now: () => number
  private readonly sessions = new WeakSet<DownloadSurface>()
  private readonly listeners = new Set<NoticeListener>()
  /** The URLs the user said yes to, by URL, each good for the one request the policy makes, for a while. */
  private readonly approved = new Map<string, Approval>()
  /** The session's downloads, oldest first (#177). */
  private readonly entries: DownloadEntry[] = []
  /** The items still running, by entry id, so a cancel reaches them. */
  private readonly running = new Map<string, DownloadItemSurface>()
  private counter = 0

  constructor(options: DownloadPolicyOptions) {
    this.quarantineDir = options.quarantineDir
    this.confirm = options.confirm
    this.attributes = options.attributes ?? xattrAttributes
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => Date.now())
  }

  /** Forgets every approval. The app calls this on quit, the way it empties the permission allow set. */
  clear(): void {
    this.approved.clear()
  }

  /** The session's downloads, oldest first (#177). */
  list(): readonly DownloadEntry[] {
    return [...this.entries]
  }

  /** Cancels a running download; false when `id` is not running. The `done` event records the end. */
  cancel(id: string): boolean {
    const item = this.running.get(id)
    if (item === undefined) return false
    item.cancel()
    return true
  }

  /** The transcript subscribes: one line per refusal, per file saved, per file removed. */
  on(listener: NoticeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Installs the handler on a session, once. The session's own download path is the quarantine folder too. */
  apply(session: DownloadSurface): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    session.setDownloadPath(this.quarantineDir)
    session.on('will-download', (event: Event, item: DownloadItemSurface) => {
      const url = item.getURL()
      const approved = this.approved.get(url)
      if (approved !== undefined) {
        this.approved.delete(url)
        if (this.now() - approved.at <= APPROVAL_TTL_MS) {
          this.save(item, approved.request)
          return
        }
        // Too late to be the request the yes was for: refused like any other, and asked about again.
        this.notify(`Approval for ${approved.request.filename} expired, ask again`)
      }
      // Read what it is, then refuse it: no byte of this item lands anywhere.
      const request: DownloadRequest = {
        filename: safeFilename(item.getFilename()),
        bytes: item.getTotalBytes(),
        origin: originOf(item.getInitiatorOrigin()) ?? originOf(url),
      }
      event.preventDefault()
      void this.ask(session, url, request)
    })
  }

  private async ask(
    session: DownloadSurface,
    url: string,
    request: DownloadRequest,
  ): Promise<void> {
    let yes = false
    try {
      yes = await this.confirm(request)
    } catch (error) {
      console.error('downloads: the confirmation failed:', error)
    }
    const what = `${request.filename} (${formatBytes(request.bytes)}) from ${siteOf(request.origin)}`
    if (!yes) {
      this.notify(`Refused download of ${what}: nothing was written (SECURITY.org, T2)`)
      return
    }
    mkdirSync(this.quarantineDir, { recursive: true })
    this.approved.set(url, { request, at: this.now() })
    session.downloadURL(url)
  }

  /** The approved item: pinned to the quarantine folder, then checked when it is done. */
  private save(item: DownloadItemSurface, request: DownloadRequest): void {
    const path = uniquePath(this.quarantineDir, request.filename)
    item.setSavePath(path)
    const what = `${request.filename} (${formatBytes(request.bytes)}) from ${siteOf(request.origin)}`
    const id = this.track(item, request, path)
    item.on('updated', () => {
      this.update(id, { state: 'progress', receivedBytes: item.getReceivedBytes() })
    })
    item.once('done', (_event: Event, state: string) => {
      this.running.delete(id)
      if (state !== 'completed') {
        this.update(id, { state: state === 'cancelled' ? 'cancelled' : 'failed' })
        this.notify(`Download of ${what} ${state}: nothing was kept`)
        return
      }
      this.update(id, { receivedBytes: item.getReceivedBytes() })
      void this.quarantine(path, what).then((kept) => {
        this.update(id, { state: kept ? 'done' : 'failed' })
      })
    })
  }

  /** Lists an approved item as started, dropping the oldest finished entry past the limit. */
  private track(item: DownloadItemSurface, request: DownloadRequest, path: string): string {
    this.counter += 1
    const id = `d${this.counter}`
    this.entries.push({
      id,
      url: item.getURL(),
      filename: request.filename,
      path,
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'started',
    })
    this.running.set(id, item)
    if (this.entries.length > DOWNLOAD_LIST_LIMIT) {
      const oldest = this.entries.findIndex((entry) => !this.running.has(entry.id))
      if (oldest !== -1) this.entries.splice(oldest, 1)
    }
    return id
  }

  private update(
    id: string,
    change: Partial<Pick<DownloadEntry, 'state' | 'receivedBytes'>>,
  ): void {
    const index = this.entries.findIndex((entry) => entry.id === id)
    const entry = this.entries[index]
    if (entry !== undefined) this.entries[index] = { ...entry, ...change }
  }

  /**
   * The attribute check after completion. Chromium marks what it saves on
   * macOS; this reads the mark back rather than trusting that, writes one
   * when it is missing, and removes a file that cannot be marked.
   */
  private async quarantine(path: string, what: string): Promise<boolean> {
    const where = `to ${this.quarantineDir}`
    if (this.platform !== 'darwin') {
      this.notify(`Saved ${what} ${where}: not opened`)
      return true
    }
    let value = await this.attributes.read(path)
    if (value === null) {
      await this.attributes.write(path, quarantineValue())
      value = await this.attributes.read(path)
    }
    if (value === null) {
      rmSync(path, { force: true })
      this.notify(`Removed ${what}: the file could not be quarantined (SECURITY.org, T2)`)
      return false
    }
    this.notify(`Saved ${what} ${where}: quarantined, not opened`)
    return true
  }

  private notify(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text }
    for (const listener of this.listeners) listener(event)
  }
}
