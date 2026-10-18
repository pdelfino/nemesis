import { expect, test } from '@playwright/test'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 7: "Permissions denied by default",
 * asserted the way the table asks, each listed permission resolves to denied
 * without a user decision (#49, threat T6).
 *
 * The permissions fixture has one button per permission. A page buffer
 * presses each and records the outcome the web API gave it; every outcome is
 * a refusal, none waits on anyone, and no window opened in the meantime.
 * Electron's own default is to grant, so the live evidence that this app's
 * policy decided is the line the main process writes per refusal, by origin
 * and never by URL, and the one-line note the cockpit's transcript shows the
 * user for each site and permission refused.
 */

interface PermissionsWindow {
  readonly __permissions?: Readonly<Record<string, string>>
}

/** The fixture's buttons, in the order they are pressed. */
const PROBES = [
  'geolocation',
  'notifications',
  'camera',
  'microphone',
  'clipboard-read',
  'midi',
  'bluetooth',
  'usb',
  'hid',
  'serial',
] as const

/**
 * The name the policy refuses each probe under. The fixture asks for MIDI
 * with sysex, which Chromium requests as `midiSysex`.
 */
const REFUSED: Readonly<Record<(typeof PROBES)[number], string>> = {
  geolocation: 'geolocation',
  notifications: 'notifications',
  camera: 'camera',
  microphone: 'microphone',
  'clipboard-read': 'clipboard-read',
  midi: 'midiSysex',
  bluetooth: 'bluetooth',
  usb: 'usb',
  hid: 'hid',
  serial: 'serial',
}

/** The line the main process writes for a refusal, and the whole of it. */
const DENIED = /^permissions: denied (\S+) \((\S+)\) for (\S+)$/gm

test('every device and data permission resolves denied, with no dialog and a note in the transcript', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  let stderr = ''
  nemesis.app.process().stderr?.on('data', (chunk: Buffer | string) => {
    stderr += String(chunk)
  })
  const denied = (): string[][] =>
    Array.from(stderr.matchAll(DENIED), (match) => [match[1] ?? '', match[3] ?? ''])
  try {
    const url = fixtures.url('permissions.html')
    const buffer = await nemesis.openPageBuffer(url)
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('permissions')
    const windowsBefore = nemesis.app.windows().length

    const outcomes: Record<string, string> = {}
    for (const probe of PROBES) {
      await buffer.page.click(`#request-${probe}`)
      // The fixture reports `pending` first and the API's answer after. A
      // refusal that waits on a user decision would never get past pending;
      // the fixture's own geolocation timeout is the longest wait there is.
      await expect
        .poll(
          async () =>
            (await buffer.page.evaluate(() => (globalThis as PermissionsWindow).__permissions))?.[
              probe
            ],
          { timeout: 10_000 },
        )
        .not.toMatch(/^(pending|untested)$/)
      const outcome = await buffer.page.evaluate(
        (name) => (globalThis as PermissionsWindow).__permissions?.[name] ?? '',
        probe,
      )
      outcomes[probe] = outcome
    }

    // Every probe is refused by the web API, and refused is the word: not
    // granted, and not unavailable either, which would mean the API was gone
    // rather than denied.
    for (const probe of PROBES) {
      expect(outcomes[probe], probe).toMatch(/^denied/)
    }
    await expect(buffer.page.locator('#results li')).toHaveCount(PROBES.length)

    // No dialog, no chooser, no window: nothing opened while the probes ran.
    expect(nemesis.app.windows().length).toBe(windowsBefore)

    // The policy decided, on this app's handlers, for each name, and logged
    // the origin alone. Bluetooth is the one Chromium may refuse on its own
    // first: with no adapter powered on, the chooser this app cancels is
    // never opened, so its line is required only where the chooser ran.
    const decided = PROBES.filter(
      (probe) => probe !== 'bluetooth' || denied().some(([name]) => name === 'bluetooth'),
    )
    for (const probe of decided) {
      await expect.poll(denied).toContainEqual([REFUSED[probe], fixtures.httpOrigin])
    }
    for (const line of stderr.split('\n').filter((one) => one.startsWith('permissions:'))) {
      expect(line).not.toContain('permissions.html')
    }

    // The user is told, once per site and permission, in the transcript.
    const notes = (): Promise<string[]> =>
      nemesis.window.locator('#transcript .cm-line').allTextContents()
    for (const probe of decided) {
      await expect
        .poll(notes)
        .toContain(
          `Denied ${REFUSED[probe]} for ${fixtures.httpOrigin}: permissions are off by default (SECURITY.org, T6)`,
        )
    }
    // Asking again adds a refusal to the log and nothing to the transcript.
    const before = (await notes()).length
    await buffer.page.click('#request-geolocation')
    await expect
      .poll(() => denied().filter(([name]) => name === 'geolocation').length)
      .toBeGreaterThanOrEqual(2)
    expect((await notes()).length).toBe(before)

    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
