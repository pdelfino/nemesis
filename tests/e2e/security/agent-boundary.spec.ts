import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '../_test'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org T4, the agent and web boundary (#55), against the mocked SDK.
 *
 * 1. Page text reaches the agent only as labeled data: `summarize-page` over
 *    the injection fixture sends the SDK one message whose instruction is
 *    the cockpit's and whose page text, every canary of it, sits inside the
 *    block `wrapUntrusted` heads with the fixture's origin.
 * 2. A side-effect tool needs a yes while a page buffer is open: a mocked
 *    Bash call becomes a request in the transcript, with the tool name and
 *    its arguments, and does not run until answered; a no keeps it from
 *    running.
 * 3. The hook denies without a user decision while a page is the current
 *    buffer: the same call is refused, no request is ever shown.
 */

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly isError?: boolean
  readonly name?: string
  readonly toolName?: string
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: { readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void }
}

interface ReceivedBlock {
  readonly type: string
  readonly text?: string
}

/** The test-only door src/main/index.ts installs for the page buffers. */
interface PageDoor {
  run(windowId: number, name: string): Promise<void>
}

const CANARIES = [
  'NEMESIS-INJECTION-CANARY.',
  'NEMESIS-INJECTION-CANARY-HIDDEN',
  'Ignore all previous instructions',
]

function events(window: Page): Promise<AgentEvent[]> {
  return window.evaluate(() => (globalThis as unknown as TestWindow).__agentEvents ?? [])
}

async function ofType(window: Page, type: string): Promise<AgentEvent[]> {
  return (await events(window)).filter((event) => event.type === type)
}

/** The text of every user message the mock SDK read, in order. */
async function received(app: ElectronApplication): Promise<string[]> {
  const messages = await app.evaluate(
    () =>
      (globalThis as { __nemesisMockReceived?: { blocks: ReceivedBlock[] }[] })
        .__nemesisMockReceived ?? [],
  )
  return messages.map((message) =>
    message.blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n'),
  )
}

function run(app: ElectronApplication, windowId: number, name: string): Promise<void> {
  return app.evaluate(
    async (_main, args) => {
      const door = (globalThis as { __nemesisPages?: PageDoor }).__nemesisPages
      if (door === undefined) throw new Error('No page door')
      await door.run(args.windowId, args.name)
    },
    { windowId, name },
  )
}

test('page text reaches the agent wrapped, and a side-effect tool asks while a page is open and is denied while one is current', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  const { app, window } = nemesis
  try {
    await window.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })
    const buffer = await nemesis.openPageBuffer(fixtures.secureUrl('injection.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('injection')
    const ids = buffer.ids
    if (ids === undefined) throw new Error('The page buffer has no ids')

    // 1. Summarize: the SDK gets the block, the canaries inside it only.
    await run(app, ids.windowId, 'summarize-page')
    const header = `--- untrusted content from ${fixtures.httpsOrigin} ---`
    const footer = `--- end of untrusted content from ${fixtures.httpsOrigin} ---`
    await expect.poll(async () => (await received(app)).some((t) => t.includes(header))).toBe(true)
    const prompt = (await received(app)).find((t) => t.includes(header)) ?? ''
    const start = prompt.indexOf(header)
    const end = prompt.indexOf(footer)
    expect(prompt.startsWith('Summarize the web page below')).toBe(true)
    expect(end).toBeGreaterThan(start)
    expect(prompt.slice(end + footer.length)).toBe('')
    const outside = prompt.slice(0, start)
    for (const canary of CANARIES) {
      const at = prompt.indexOf(canary)
      expect(at, canary).toBeGreaterThan(start)
      expect(at, canary).toBeLessThan(end)
      expect(outside).not.toContain(canary)
    }
    // The comment never reaches the agent at all.
    expect(prompt).not.toContain('NEMESIS-INJECTION-CANARY-COMMENT')
    await expect.poll(async () => (await ofType(window, 'turn-end')).length).toBe(1)
    // The instruction text was not executed: the turn called no tool.
    expect(await ofType(window, 'tool-use')).toEqual([])

    // 2. The point is in the prompt, the page still open: Bash asks.
    const request = window.locator('#request')
    await expect(window.locator('#prompt .cm-content')).toBeFocused()
    await window.keyboard.type('tool: Bash')
    await window.keyboard.press('Control+c')
    await window.keyboard.press('Control+c')
    await expect(request).toBeVisible()
    await expect(window.locator('#request-title')).toHaveText('Bash wants to run')
    // The action log: the call, with its name and arguments, in the transcript.
    const lines = (): Promise<string[]> => window.locator('#transcript .cm-line').allTextContents()
    await expect.poll(lines).toContain('Tool: Bash')
    expect(await lines()).toContain('  "path": "/mock/notes.txt"')
    expect(await ofType(window, 'tool-use')).toMatchObject([{ name: 'Bash' }])
    expect(
      (await ofType(window, 'notice')).some((event) =>
        (event.text ?? '').includes('Page boundary: Bash'),
      ),
    ).toBe(true)
    // Not run without a yes.
    expect(await ofType(window, 'tool-result')).toEqual([])
    await window.keyboard.press('n')
    await expect
      .poll(async () => (await ofType(window, 'assistant-text')).at(-1)?.text)
      .toBe('Did not run Bash.')
    expect((await ofType(window, 'tool-result')).at(-1)).toMatchObject({ isError: true })

    // 3. A page current: the hook denies, and nobody is asked.
    const second = await nemesis.openPageBuffer(fixtures.secureUrl('injection.html'))
    const secondIds = second.ids
    if (secondIds === undefined) throw new Error('The page buffer has no ids')
    const requestsBefore = (await ofType(window, 'permission-request')).length
    void run(app, secondIds.windowId, 'ask-codebase')
    await expect(window.locator('#palette-prompt')).toHaveText('Ask the codebase:')
    await window.keyboard.type('tool: Bash')
    await window.keyboard.press('Enter')
    await expect.poll(async () => (await ofType(window, 'turn-end')).length).toBe(3)
    expect((await ofType(window, 'assistant-text')).at(-1)?.text).toBe('Did not run Bash.')
    const denied = (await ofType(window, 'tool-result')).at(-1)
    expect(denied).toMatchObject({ isError: true })
    expect(denied?.text).toContain('denied without a question')
    expect(await ofType(window, 'permission-request')).toHaveLength(requestsBefore)
    await expect(request).toBeHidden()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
