import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** The shim a client spawns, from this checkout (#28). */
const SHIM = join(process.cwd(), 'bin', 'nemesis-mcp')

interface Listed {
  readonly buffers: readonly { id: string; kind: string; title: string; current: boolean }[]
}

/** Types into the open palette until `label` is the highlighted candidate, then picks it. */
async function pick(page: Page, label: string): Promise<void> {
  await expect(page.locator('#palette-input .cm-content')).toBeFocused()
  await page.keyboard.type(label)
  await expect
    .poll(() =>
      page
        .locator('#palette-candidates li[aria-selected="true"]')
        .evaluate((item) => item.firstChild?.textContent ?? ''),
    )
    .toBe(label)
  await page.keyboard.press('Enter')
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as readonly { type: string; text?: string }[]
  return content.map((item) => item.text ?? '').join('\n')
}

// ADR 0007's positive half: a client outside the app spawns the shim against
// the launched profile's socket, lists the eight cockpit tools, the six
// page-reading tools (#138), the five navigation tools (#139) and the events resource, reads the buffers without a question, and sends a prompt
// that waits for the user's yes in the palette before the mock session gets
// it.
test('a client through bin/nemesis-mcp lists, reads, and sends a prompt after the yes', async () => {
  const { app, userData } = await launchApp()
  const client = new Client({ name: 'e2e-client', version: '1.0.0' })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    const socket = join(userData, 'mcp.sock')
    await expect.poll(() => existsSync(socket)).toBe(true)

    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [SHIM, '--socket', socket] }),
    )
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(19)
    expect(tools.filter((tool) => tool.name.startsWith('cockpit_'))).toHaveLength(8)
    expect(tools.filter((tool) => tool.name.startsWith('browser_'))).toHaveLength(11)
    // The one resource of the tier, the session's event log (#117).
    const { resources } = await client.listResources()
    expect(resources.map((resource) => resource.uri)).toEqual(['nemesis://session/events'])

    const listed = await client.callTool({ name: 'cockpit_list_buffers', arguments: {} })
    const { buffers } = listed.structuredContent as unknown as Listed
    expect(buffers.map((buffer) => buffer.kind)).toEqual(['transcript', 'prompt'])
    const prompt = buffers.find((buffer) => buffer.kind === 'prompt')
    expect(prompt?.current).toBe(true)

    // The draft the window parks is what the prompt buffer reads as.
    await page.keyboard.type('a draft in the window')
    await expect
      .poll(async () =>
        text(await client.callTool({ name: 'cockpit_read_buffer', arguments: { id: prompt?.id } })),
      )
      .toBe('a draft in the window')

    // A yes-per-call tool: the question opens in the palette with the
    // client's name, the no first; nothing is sent until the yes.
    const sent = client.callTool({
      name: 'cockpit_send_prompt',
      arguments: { text: 'hello from outside' },
    })
    await expect(page.locator('#palette-prompt')).toHaveText(
      'e2e-client asks cockpit_send_prompt: send the prompt "hello from outside"?',
    )
    await expect(page.locator('#palette-candidates li').first()).toContainText('Refuse')
    await expect(page.locator('#transcript .cm-content')).not.toContainText('hello from outside')
    await pick(page, 'Allow this one call')
    const receipt = await sent
    expect(receipt.isError).toBeFalsy()
    expect(receipt.structuredContent).toMatchObject({ status: 'sent', position: 0 })
    await expect(page.locator('#transcript .cm-content')).toContainText(
      'You said: hello from outside',
    )
    // And the call itself is a notice in the transcript, with the client's name.
    await expect(page.locator('#transcript .cm-content')).toContainText(
      'MCP: e2e-client called cockpit_send_prompt',
    )
  } finally {
    await client.close().catch(() => undefined)
    await app.close()
  }
})
