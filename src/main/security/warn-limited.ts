/**
 * Refusal logs, bounded (#100, SECURITY.org T1, T2, T6).
 *
 * Every refusal in the main process writes one stderr line: a dropped IPC
 * call (src/main/ipc.ts), a denied permission (permissions.ts), a blocked
 * navigation (navigation-policy.ts). The refusal itself is free; the line is
 * not, and a hostile page that loops can flood stderr with it. `warnLimited`
 * writes at most `WARN_LIMIT` lines per key per `WARN_WINDOW_MS`, then, when
 * the window has ended, one line saying how many more it held back.
 *
 * A key is the kind of refusal and the scheme, channel or permission name
 * it was about, never a URL, an origin or a path: the key is printed. The
 * window closes lazily, on the next call after it ended, so there is no
 * timer to leak and the clock is a plain function a test can fake. `flush`
 * writes the summaries still pending, for `will-quit`, so a quiet app does
 * not lose its last one.
 */

/** Lines written per key before the rest of the window is held back. */
export const WARN_LIMIT = 5

/** How long a key's window lasts. */
export const WARN_WINDOW_MS = 60_000

export interface WarnLimiterOptions {
  readonly limit?: number | undefined
  readonly windowMs?: number | undefined
  /** `Date.now` unless a test says otherwise. */
  readonly now?: (() => number) | undefined
  /** `console.warn` unless a test says otherwise. */
  readonly write?: ((line: string) => void) | undefined
}

export interface WarnLimited {
  (key: string, line: string): void
  /** Writes every pending summary now and forgets the windows, so none is written twice. */
  flush(): void
}

interface WarnWindow {
  readonly start: number
  count: number
}

export function createWarnLimiter(options: WarnLimiterOptions = {}): WarnLimited {
  const limit = options.limit ?? WARN_LIMIT
  const windowMs = options.windowMs ?? WARN_WINDOW_MS
  const now = options.now ?? (() => Date.now())
  const write = options.write ?? ((line: string) => console.warn(line))
  const windows = new Map<string, WarnWindow>()
  const warn = (key: string, line: string): void => {
    const at = now()
    // Every window that has ended is closed here, this key's included, and
    // the one summary line each owes is written then.
    for (const [other, window] of windows) {
      if (at - window.start < windowMs) continue
      windows.delete(other)
      if (window.count > limit) write(`suppressed ${window.count - limit} more for ${other}`)
    }
    let window = windows.get(key)
    if (window === undefined) {
      window = { start: at, count: 0 }
      windows.set(key, window)
    }
    window.count += 1
    if (window.count <= limit) write(line)
  }
  const flush = (): void => {
    for (const [key, window] of windows) {
      if (window.count > limit) write(`suppressed ${window.count - limit} more for ${key}`)
    }
    windows.clear()
  }
  return Object.assign(warn, { flush })
}

/** The app's one limiter: the five refusal sites share it, each under its own keys. */
export const warnLimited: WarnLimited = createWarnLimiter()
