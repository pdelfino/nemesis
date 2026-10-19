import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test, type Page } from './_test'
import { fixtureServer, launchNemesis } from './security/_harness'

/**
 * The MCP page tier, navigation (#139, ADR 0008): a client outside the app,
 * through bin/nemesis-mcp, moves a real page buffer over the fixture pages,
 * each call after its own yes in the palette, whose line names the client,
 * the tool, the page's origin and the URL. A plain `http:` URL off loopback
 * and a `javascript:` URL come back refused, unasked. Inside the cockpit the
 * session's page tool call waits on a `y`: the request offers no `a`.
 */

const SHIM = join(process.cwd(), 'bin', 'nemesis-mcp')

const NAVIGATION_TOOLS = [
  'browser_navigate',
  'browser_go_back',
  'browser_go_forward',
  'browser_open_page',
  'browser_close_page',
]

type Result = Awaited<ReturnType<Client['callTool']>>

interface AgentEvent {
  readonly type: string
  readonly text?: string
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: { readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void }
}

function items(result: Result): string[] {
  return (result.content as readonly { type: string; text?: string }[]).map(
    (item) => item.text ?? '',
  )
}

/** Types into the open palette until `label` is the highlighted candidate, then picks it. */
async function pick(window: Page, label: string): Promise<void> {
  await expect(window.locator('#palette-input .cm-content')).toBeFocused()
  await window.keyboard.type(label)
  await expect
    .poll(() =>
      window
        .locator('#palette-candidates li[aria-selected="true"]')
        .evaluate((item) => item.firstChild?.textContent ?? ''),
    )
    .toBe(label)
  await window.keyboard.press('Enter')
}

test('a client navigates, goes back and forward, opens and closes a page, each after its own yes', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  const { window } = nemesis
  const client = new Client({ name: 'e2e-nav-client', version: '1.0.0' })
  try {
    const first = fixtures.secureUrl('mcp-page.html')
    const buffer = await nemesis.openPageBuffer(first)
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('NEMESIS-MCP-TITLE-CANARY')
    const pageId = buffer.ids?.bufferId
    if (pageId === undefined) throw new Error('The page buffer has no ids')

    const socket = join(nemesis.userData, 'mcp.sock')
    await expect.poll(() => existsSync(socket)).toBe(true)
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [SHIM, '--socket', socket] }),
    )
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    for (const name of NAVIGATION_TOOLS) expect(names).toContain(name)

    const origin = fixtures.httpsOrigin
    const header = `--- untrusted content from ${origin} ---`
    const prompt = window.locator('#palette-prompt')
    /** One call: its question is `line`, the yes is given, and the result has no error. */
    const allowed = async (
      name: string,
      args: Record<string, unknown>,
      line: string,
    ): Promise<Result> => {
      const call = client.callTool({ name, arguments: args })
      await expect(prompt).toHaveText(`e2e-nav-client asks ${line}`)
      await expect(window.locator('#palette-candidates li').first()).toContainText('Refuse')
      await pick(window, 'Allow this one call')
      const result = await call
      expect(result.isError, `${name} ${items(result).join(' ')}`).toBeFalsy()
      // The structure is Nemesis's own; the page's strings are in the block,
      // and in its one copy, `untrusted` (#151).
      const { untrusted, ...own } = result.structuredContent as Record<string, unknown>
      expect(JSON.stringify(own), name).not.toContain('NEMESIS-')
      expect(untrusted, name).toBe(items(result)[1])
      return result
    }

    // Navigate: the question names the page's origin and the URL, the page's title never.
    const second = fixtures.secureUrl('injection.html')
    const navigated = await allowed(
      'browser_navigate',
      { url: second, page: pageId },
      `browser_navigate on ${origin}: load "${second}" in ${pageId}?`,
    )
    expect(navigated.structuredContent).toEqual({
      page: pageId,
      origin,
      status: 'loaded',
      untrusted: items(navigated)[1],
    })
    expect(items(navigated)[1]?.startsWith(header)).toBe(true)
    expect(items(navigated)[1]).toContain('NEMESIS-INJECTION-CANARY')
    expect(await prompt.textContent()).not.toContain('NEMESIS-')

    // Back to the first page, and forward again, each asked on its own.
    const back = await allowed(
      'browser_go_back',
      { page: pageId },
      `browser_go_back on ${origin}: go back in ${pageId}?`,
    )
    expect(back.structuredContent).toEqual({
      page: pageId,
      origin,
      moved: true,
      untrusted: items(back)[1],
    })
    expect(items(back)[1]).toContain('NEMESIS-MCP-PAGE-CANARY')
    const forward = await allowed(
      'browser_go_forward',
      { page: pageId },
      `browser_go_forward on ${origin}: go forward in ${pageId}?`,
    )
    expect(forward.structuredContent).toEqual({
      page: pageId,
      origin,
      moved: true,
      untrusted: items(forward)[1],
    })
    expect(items(forward)[1]).toContain('NEMESIS-INJECTION-CANARY')

    // A new page buffer, which does not take the point, then closed by id.
    const opened = await allowed(
      'browser_open_page',
      { url: first },
      `browser_open_page on ${origin}: open "${first}" in a new page?`,
    )
    const fresh = (opened.structuredContent as { page: string }).page
    expect(fresh).not.toBe(pageId)
    expect(opened.structuredContent).toEqual({
      page: fresh,
      origin,
      status: 'loaded',
      untrusted: items(opened)[1],
    })
    expect(items(opened)[1]).toContain('NEMESIS-MCP-PAGE-CANARY')
    const listed = await client.callTool({ name: 'cockpit_list_buffers', arguments: {} })
    const buffers = (listed.structuredContent as { buffers: { id: string; current: boolean }[] })
      .buffers
    expect(buffers.find((one) => one.id === fresh)?.current).toBe(false)
    const closed = await allowed(
      'browser_close_page',
      { page: fresh },
      `browser_close_page on ${origin}: close ${fresh}?`,
    )
    expect(closed.structuredContent).toEqual({ page: fresh, closed: true })

    // Refused with the reason, before anyone is asked, and nothing loads.
    const loadsOf = (): number =>
      fixtures.requested.filter((path) => path === '/mcp-page.html').length
    const loadsBefore = loadsOf()
    for (const [url, reason] of [
      [fixtures.offLoopbackUrl('mcp-page.html'), 'plain http: URL off loopback'],
      ['javascript:alert(1)', 'javascript: is not a page URL'],
    ] as const) {
      const refused = await client.callTool({ name: 'browser_navigate', arguments: { url } })
      expect(refused.isError, url).toBe(true)
      expect(items(refused)[0]).toContain(reason)
      await expect(prompt).toBeHidden()
    }
    expect(loadsOf()).toBe(loadsBefore)
  } finally {
    await client.close().catch(() => undefined)
    await nemesis.close()
    await fixtures.close()
  }
})

test("the cockpit session's page tool call waits on a y, and a does not answer it", async () => {
  const nemesis = await launchNemesis()
  const { window } = nemesis
  try {
    await window.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })
    const assistant = (): Promise<(string | undefined)[]> =>
      window.evaluate(() =>
        ((globalThis as unknown as TestWindow).__agentEvents ?? [])
          .filter((event) => event.type === 'assistant-text')
          .map((event) => event.text),
      )
    const tool = 'mcp__nemesis__browser_navigate'
    const request = window.locator('#request')
    await expect(window.locator('#prompt .cm-content')).toBeFocused()
    await window.keyboard.type(`tool: ${tool}`)
    await window.keyboard.press('Control+c')
    await window.keyboard.press('Control+c')
    await expect(request).toBeVisible()
    await expect(window.locator('#request-keys')).toHaveText('y allow this one call, n deny')
    const lines = (): Promise<string[]> => window.locator('#transcript .cm-line').allTextContents()
    await expect.poll(lines).toContain('y allow this one call, n deny')

    // a is no answer for a page tool: the request stays, nothing ran.
    await window.keyboard.press('a')
    await expect(request).toBeVisible()
    expect(await assistant()).toEqual([])

    // y runs this one call.
    await window.keyboard.press('y')
    await expect.poll(assistant).toEqual([`Ran ${tool}.`])
    await expect(request).toBeHidden()

    // The next call asks again: the yes was for one call.
    await expect(window.locator('#prompt .cm-content')).toBeFocused()
    await window.keyboard.type(`tool: ${tool}`)
    await window.keyboard.press('Control+c')
    await window.keyboard.press('Control+c')
    await expect(request).toBeVisible()
    await window.keyboard.press('n')
    await expect.poll(assistant).toEqual([`Ran ${tool}.`, `Did not run ${tool}.`])
  } finally {
    await nemesis.close()
  }
})
