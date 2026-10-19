import { describe, expect, it } from 'vitest'
import { createWarnLimiter, WARN_LIMIT, WARN_WINDOW_MS } from '../../src/main/security/warn-limited'

/**
 * The bound on refusal logs (#100): five lines per key per minute, one
 * summary when the window ends, keys independent. On a fake clock; the
 * five call sites are exercised by their own unit tests and the security
 * specs, which still see every refusal they count.
 */

function setUp() {
  let clock = 1_000
  const lines: string[] = []
  const warn = createWarnLimiter({ now: () => clock, write: (line) => lines.push(line) })
  return {
    lines,
    warn,
    advance(ms: number) {
      clock += ms
    },
  }
}

describe('warnLimited (SECURITY.org T1, T2, T6)', () => {
  it('passes the first five lines for a key and holds the sixth', () => {
    const { lines, warn } = setUp()
    for (let n = 1; n <= WARN_LIMIT + 1; n += 1) warn('navigation https:', `line ${n}`)
    expect(lines).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5'])
  })

  it('writes the count it held back once, when the window has ended, then starts over', () => {
    const { advance, lines, warn } = setUp()
    for (let n = 1; n <= 12; n += 1) warn('ipc nemesis:key', `line ${n}`)
    advance(WARN_WINDOW_MS - 1)
    warn('ipc nemesis:key', 'still inside')
    expect(lines).toHaveLength(WARN_LIMIT)
    advance(1)
    warn('ipc nemesis:key', 'first of the next window')
    expect(lines.slice(WARN_LIMIT)).toEqual([
      'suppressed 8 more for ipc nemesis:key',
      'first of the next window',
    ])
    // Once: the next window has nothing to report unless it fills up too.
    advance(WARN_WINDOW_MS)
    warn('ipc nemesis:key', 'after a quiet window')
    expect(lines.slice(WARN_LIMIT + 2)).toEqual(['after a quiet window'])
  })

  it('writes no summary for a window that never went over', () => {
    const { advance, lines, warn } = setUp()
    warn('permissions camera', 'one')
    advance(WARN_WINDOW_MS)
    warn('permissions camera', 'two')
    expect(lines).toEqual(['one', 'two'])
  })

  it('keeps one key from using up another', () => {
    const { lines, warn } = setUp()
    for (let n = 1; n <= 20; n += 1) warn('navigation file:', `file ${n}`)
    warn('navigation javascript:', 'javascript 1')
    expect(lines).toHaveLength(WARN_LIMIT + 1)
    expect(lines.at(-1)).toBe('javascript 1')
  })

  it('settles the summary of any ended window on the next call, whatever its key', () => {
    const { advance, lines, warn } = setUp()
    for (let n = 1; n <= 7; n += 1) warn('navigation file:', `file ${n}`)
    advance(WARN_WINDOW_MS)
    warn('ipc nemesis:key', 'other key')
    expect(lines.slice(WARN_LIMIT)).toEqual(['suppressed 2 more for navigation file:', 'other key'])
  })

  it('flush writes each pending summary once and never again', () => {
    const { lines, warn } = setUp()
    for (let n = 1; n <= 8; n += 1) warn('ipc nemesis:key', `line ${n}`)
    for (let n = 1; n <= WARN_LIMIT; n += 1) warn('navigation https:', `nav ${n}`)
    warn.flush()
    expect(lines.slice(-1)).toEqual(['suppressed 3 more for ipc nemesis:key'])
    const written = lines.length
    warn.flush()
    expect(lines).toHaveLength(written)
  })
})
