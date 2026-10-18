import { expect, test } from '@playwright/test'
import { BUFFERS_CHANNEL } from '../../../src/shared/buffers'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 10: "IPC validates the sender", asserted
 * the way the table asks, a message from a page origin to a privileged
 * channel is dropped (#53, threat T1).
 *
 * A page buffer has no preload, so it has no bridge at all, which
 * no-node-in-pages.spec.ts proves. The hostile case here goes further: the
 * node-probe fixture is loaded with the cockpit's preload attached, so the
 * bridge is there and the page can call a privileged channel. `handle()` in
 * src/main/ipc.ts then rejects the call on the sender's origin alone, logs
 * the channel name and that origin and nothing else, and the cockpit's own
 * call on the same channel keeps answering with a typed list.
 */

interface BridgeWindow {
  readonly nemesis?: {
    readonly name: string
    buffers(): Promise<{
      buffers: readonly { id: string; kind: string }[]
      currentId: string | null
    }>
  }
}

/** The line the main process writes for a dropped call, and the whole of it. */
const DROPPED = /^ipc: dropped (\S+) from (\S+)$/gm

test('a page origin posting to a privileged channel gets nothing, the cockpit gets a typed answer', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  let stderr = ''
  nemesis.app.process().stderr?.on('data', (chunk: Buffer | string) => {
    stderr += String(chunk)
  })
  try {
    // The positive case: the internal page gets a typed response.
    const before = await nemesis.window.evaluate(() =>
      (globalThis as BridgeWindow).nemesis?.buffers(),
    )
    expect(before).toBeDefined()
    expect(Array.isArray(before?.buffers)).toBe(true)
    expect(before?.buffers.length).toBeGreaterThan(0)
    for (const buffer of before?.buffers ?? []) {
      expect(typeof buffer.id).toBe('string')
      expect(typeof buffer.kind).toBe('string')
    }
    expect(before?.currentId).not.toBeNull()

    // The hostile case: a web page that somehow has the bridge.
    const hostile = await nemesis.openPageBuffer(fixtures.url('node-probe.html'), {
      withPreload: true,
    })
    expect(hostile.loadError).toBeNull()
    await expect(hostile.page).toHaveTitle('node probe')
    // Non-vacuous: the bridge is there, so the rejection below is the
    // handler's doing and not the absence of a preload.
    expect(await hostile.page.evaluate(() => (globalThis as BridgeWindow).nemesis?.name)).toBe(
      'nemesis',
    )

    const outcome = await hostile.page.evaluate(async () => {
      try {
        const list = await (globalThis as BridgeWindow).nemesis?.buffers()
        return { status: 'answered', got: JSON.stringify(list) }
      } catch (error) {
        return { status: 'rejected', got: error instanceof Error ? error.message : String(error) }
      }
    })
    expect(outcome.status).toBe('rejected')
    // The rejection carries no data: not the list, not an id, not a title.
    expect(outcome.got).not.toContain('"buffers"')
    for (const buffer of before?.buffers ?? []) expect(outcome.got).not.toContain(buffer.id)

    // Dropped and logged: the channel and the fixture's origin, and nothing else
    // on that line. A log that printed the payload or the path would not match.
    await expect
      .poll(() => Array.from(stderr.matchAll(DROPPED), (match) => [match[1], match[2]]))
      .toContainEqual([BUFFERS_CHANNEL, fixtures.httpOrigin])

    // The cockpit is unchanged and still answers.
    const after = await nemesis.window.evaluate(() =>
      (globalThis as BridgeWindow).nemesis?.buffers(),
    )
    expect(after).toEqual(before)

    await hostile.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
