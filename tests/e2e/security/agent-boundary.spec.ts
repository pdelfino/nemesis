import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from '../_test'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org T4, the agent and web boundary (#55), against the mocked SDK.
 *
 * 1. Page text reaches the agent only as labeled data: `summarize-page` over
 *    the injection fixture sends the SDK one message whose instruction is
 *    the cockpit's and whose page text, every visible canary of it, sits
 *    inside the block `wrapUntrusted` heads with the fixture's origin. The
 *    text is the door's reader extraction (#142): the hidden and commented
 *    canaries never reach the agent, and the fixture server sees no second
 *    request for the page.
 * 2. A side-effect tool needs a yes while a page buffer is open: a mocked
 *    Bash call becomes a request in the transcript, with the tool name and
 *    its arguments, and does not run until answered; a no keeps it from
 *    running. An MCP tool that is not one of the cockpit's free tools asks
 *    the same way (#132).
 * 3. The hook denies without a user decision while a page is the current
 *    buffer: the same call is refused, no request is ever shown.
 * 4. The MCP page tier (#138, ADR 0008's case): `browser_snapshot` over the
 *    injection fixture returns every canary the snapshot carries inside the
 *    block headed by the fixture's origin and nowhere else, the hidden and
 *    commented ones not at all, and no side-effect tool ran.
 * 5. An acting page tool (#140): the cockpit session's `browser_click` waits
 *    on a `y` while a page is open, its request line naming the tool, the
 *    origin and the agent's element words, and is denied unasked while a
 *    page is the current buffer.
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

/** The canaries of the injection fixture a reader sees. */
const CANARIES = ['NEMESIS-INJECTION-CANARY.', 'Ignore all previous instructions']

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
    const pageRequests = fixtures.requested.filter((path) => path === '/injection.html').length
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
    // The hidden paragraph and the comment never reach the agent at all.
    expect(prompt).not.toContain('NEMESIS-INJECTION-CANARY-HIDDEN')
    expect(prompt).not.toContain('NEMESIS-INJECTION-CANARY-COMMENT')
    // The text came through the door: the page was not fetched again (#142).
    expect(fixtures.requested.filter((path) => path === '/injection.html')).toHaveLength(
      pageRequests,
    )
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

    // 2b. An MCP tool another server serves asks too, whatever its name (#132).
    const mcpTool = 'mcp__github__create_issue'
    await expect(window.locator('#prompt .cm-content')).toBeFocused()
    await window.keyboard.type(`tool: ${mcpTool}`)
    await window.keyboard.press('Control+c')
    await window.keyboard.press('Control+c')
    await expect(request).toBeVisible()
    expect(
      (await ofType(window, 'notice')).some((event) =>
        (event.text ?? '').includes(`Page boundary: ${mcpTool}`),
      ),
    ).toBe(true)
    await window.keyboard.press('n')
    await expect
      .poll(async () => (await ofType(window, 'assistant-text')).at(-1)?.text)
      .toBe(`Did not run ${mcpTool}.`)

    // 3. A page current: the hook denies, and nobody is asked.
    const second = await nemesis.openPageBuffer(fixtures.secureUrl('injection.html'))
    const secondIds = second.ids
    if (secondIds === undefined) throw new Error('The page buffer has no ids')
    const requestsBefore = (await ofType(window, 'permission-request')).length
    void run(app, secondIds.windowId, 'ask-codebase')
    await expect(window.locator('#palette-prompt')).toHaveText('Ask the codebase:')
    await window.keyboard.type('tool: Bash')
    await window.keyboard.press('Enter')
    await expect.poll(async () => (await ofType(window, 'turn-end')).length).toBe(4)
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

test('browser_snapshot over the injection fixture keeps every canary inside the block, in the content and in `untrusted`, and nothing runs (#138, #151)', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  const { app, window } = nemesis
  const client = new Client({ name: 'e2e-boundary-client', version: '1.0.0' })
  try {
    await window.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })
    const url = fixtures.secureUrl('injection.html')
    const buffer = await nemesis.openPageBuffer(url)
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('injection')

    const socket = join(nemesis.userData, 'mcp.sock')
    await expect.poll(() => existsSync(socket)).toBe(true)
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), 'bin', 'nemesis-mcp'), '--socket', socket],
      }),
    )
    const header = `--- untrusted content from ${fixtures.httpsOrigin} ---`
    const footer = `--- end of untrusted content from ${fixtures.httpsOrigin} ---`
    const result = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    expect(result.isError).toBeFalsy()
    const content = (result.content as readonly { type: string; text?: string }[]).map(
      (item) => item.text ?? '',
    )
    expect(content).toHaveLength(2)
    const [line = '', block = ''] = content
    expect(block.startsWith(header)).toBe(true)
    expect(block.endsWith(footer)).toBe(true)
    const body = block.slice(header.length, block.length - footer.length)
    // The structure carries the same block as `untrusted`, for a client that
    // hands the model the structure alone (#151), and the page in no other field.
    const { untrusted, ...own } = result.structuredContent as Record<string, unknown>
    expect(untrusted).toBe(block)
    for (const canary of ['NEMESIS-INJECTION-CANARY-BUTTON', 'Ignore all previous instructions']) {
      expect(body, canary).toContain(canary)
      expect(line, canary).not.toContain(canary)
      expect(JSON.stringify(own), canary).not.toContain(canary)
    }
    // The block closes once, at its end, and nothing hidden or commented is read.
    expect(block.indexOf(footer)).toBe(block.length - footer.length)
    expect(JSON.stringify(result)).not.toContain('NEMESIS-INJECTION-CANARY-HIDDEN')
    expect(JSON.stringify(result)).not.toContain('NEMESIS-INJECTION-CANARY-COMMENT')
    expect(result.structuredContent).toMatchObject({
      page: buffer.ids?.bufferId,
      origin: fixtures.httpsOrigin,
      truncated: false,
    })

    // No side-effect tool ran: the agent was sent nothing and called nothing,
    // nobody was asked, and the page is where it was.
    await expect
      .poll(async () =>
        (await ofType(window, 'notice')).some((event) =>
          (event.text ?? '').includes('MCP: e2e-boundary-client called browser_snapshot'),
        ),
      )
      .toBe(true)
    expect(await received(app)).toEqual([])
    expect(await ofType(window, 'tool-use')).toEqual([])
    expect(await ofType(window, 'permission-request')).toEqual([])
    expect(buffer.page.url()).toBe(url)
  } finally {
    await client.close().catch(() => undefined)
    await nemesis.close()
    await fixtures.close()
  }
})

test("the cockpit session's browser_click waits on a y while a page is open, and is denied unasked while one is current (#140)", async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  const { app, window } = nemesis
  const client = new Client({ name: 'e2e-boundary-client', version: '1.0.0' })
  try {
    await window.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })
    const buffer = await nemesis.openPageBuffer(fixtures.secureUrl('mcp-act.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('mcp-act')
    const ids = buffer.ids
    if (ids === undefined) throw new Error('The page buffer has no ids')

    // A live ref of the page, from the free snapshot.
    const socket = join(nemesis.userData, 'mcp.sock')
    await expect.poll(() => existsSync(socket)).toBe(true)
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), 'bin', 'nemesis-mcp'), '--socket', socket],
      }),
    )
    const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    const block = (snapshot.content as readonly { text?: string }[])[1]?.text ?? ''
    const ref = /\[(d\d+e\d+)\] button "Hover me"/.exec(block)?.[1]
    if (ref === undefined) throw new Error(`No button in the snapshot:\n${block}`)
    const tool = 'mcp__nemesis__browser_click'
    const call = `tool: ${tool} {"element":"the Hover me button","ref":"${ref}"}`

    // The page open, the point in the prompt: the click waits on a y.
    await run(app, ids.windowId, 'summarize-page')
    await expect.poll(async () => (await ofType(window, 'turn-end')).length).toBe(1)
    const request = window.locator('#request')
    await expect(window.locator('#prompt .cm-content')).toBeFocused()
    await window.keyboard.type(call)
    await window.keyboard.press('Control+c')
    await window.keyboard.press('Control+c')
    await expect(request).toBeVisible()
    await expect(window.locator('#request-title')).toHaveText(
      `the cockpit session asks browser_click on ${fixtures.httpsOrigin}: click "the Hover me button" in ${ids.bufferId}?`,
    )
    await expect(window.locator('#request-keys')).toHaveText('y allow this one call, n deny')
    expect(
      (await ofType(window, 'notice')).some((event) =>
        (event.text ?? '').includes(`Page boundary: ${tool}`),
      ),
    ).toBe(true)
    expect(await ofType(window, 'tool-result')).toEqual([])
    await window.keyboard.press('y')
    await expect
      .poll(async () => (await ofType(window, 'assistant-text')).at(-1)?.text)
      .toBe(`Ran ${tool}.`)

    // A page current: denied, and nobody is asked.
    const second = await nemesis.openPageBuffer(fixtures.secureUrl('mcp-act.html'))
    const secondIds = second.ids
    if (secondIds === undefined) throw new Error('The page buffer has no ids')
    const requestsBefore = (await ofType(window, 'permission-request')).length
    void run(app, secondIds.windowId, 'ask-codebase')
    await expect(window.locator('#palette-prompt')).toHaveText('Ask the codebase:')
    await window.keyboard.type(call)
    await window.keyboard.press('Enter')
    await expect.poll(async () => (await ofType(window, 'turn-end')).length).toBe(3)
    expect((await ofType(window, 'assistant-text')).at(-1)?.text).toBe(`Did not run ${tool}.`)
    const denied = (await ofType(window, 'tool-result')).at(-1)
    expect(denied).toMatchObject({ isError: true })
    expect(denied?.text).toContain('denied without a question')
    expect(await ofType(window, 'permission-request')).toHaveLength(requestsBefore)
    await expect(request).toBeHidden()
  } finally {
    await client.close().catch(() => undefined)
    await nemesis.close()
    await fixtures.close()
  }
})
