import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentEventListener } from './agent/events'
import { CommandError } from './commands/registry'

/**
 * Window screenshots (#81): the guide's "verify UI changes visually" wants
 * a screenshot of the running app under development in the prompt, so the
 * agent compares the result with what was asked. `screenshot-window` lists
 * the windows on the screen, captures the one picked and writes the image
 * under the sessions folder, the one place session data goes; the prompt
 * gets the path, which the agent reads as an image through its own Read
 * tool. The capture itself is the system's (Electron's desktopCapturer,
 * handed in from index.ts), with the user's screen-recording permission,
 * never the agent's.
 *
 * Plain data, no Electron: the unit tests drive it with a fake capturer
 * over a temporary folder.
 */

/** One window on the screen, as the capturer lists it. */
export interface WindowSource {
  readonly id: string
  /** The window's title, as its application sets it. */
  readonly name: string
}

/** What the command needs from the system: the windows, and the pixels of one. */
export interface WindowCapturer {
  list(): Promise<readonly WindowSource[]>
  /** The PNG bytes of the window, or null when it is gone from the screen. */
  capture(id: string): Promise<Uint8Array | null>
}

/** A screenshot written to disk. */
export interface Screenshot {
  readonly name: string
  readonly path: string
}

/** The folder under the sessions folder where the images go. */
export const SCREENSHOTS_FOLDER = 'screenshots'

/** A file name a shell and a prompt can both carry without quoting. */
const SLUG_LENGTH = 40

export function screenshotFileName(name: string, date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/:/g, '-')
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_LENGTH)
    .replace(/-+$/, '')
  return `${stamp}-${slug.length === 0 ? 'window' : slug}.png`
}

export interface ScreenshotsOptions {
  /** Where the images go; created on first use. */
  readonly dir: string
  readonly capturer: WindowCapturer
  readonly now?: (() => Date) | undefined
}

export class Screenshots {
  private readonly options: ScreenshotsOptions
  private readonly now: () => Date
  private readonly listeners = new Set<AgentEventListener>()
  private sources: readonly WindowSource[] = []

  constructor(options: ScreenshotsOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
  }

  /** The session bridge subscribes: the notice is shown and recorded like any event. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The windows as of the last refresh: what the palette lists. */
  get windows(): readonly WindowSource[] {
    return this.sources
  }

  /** Asks the system for the windows on the screen now. */
  async refresh(): Promise<readonly WindowSource[]> {
    this.sources = await this.options.capturer.list()
    return this.sources
  }

  /** Captures the window and writes the PNG; the notice names the file. */
  async take(id: string): Promise<Screenshot> {
    const source = this.sources.find((candidate) => candidate.id === id)
    if (source === undefined) throw new CommandError('That window is not among the ones listed')
    const png = await this.options.capturer.capture(id)
    if (png === null) throw new CommandError(`The window "${source.name}" is gone`)
    mkdirSync(this.options.dir, { recursive: true })
    const path = join(this.options.dir, screenshotFileName(source.name, this.now()))
    writeFileSync(path, png)
    this.notify(`Screenshot of "${source.name}" written to ${path}; its path is in the prompt.`)
    return { name: source.name, path }
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}
