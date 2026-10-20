import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** The shim a client spawns, from this checkout (#28). */
const SHIM = join(process.cwd(), 'bin', 'nemesis-mcp')
/** The terminal client of #182, from this checkout. */
const EVAL = join(process.cwd(), 'bin', 'nemesis-eval')

interface Exited {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs bin/nemesis-eval with `args` and resolves when it exits. */
function nemesisEval(args: readonly string[]): Promise<Exited> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EVAL, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

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
    expect(tools).toHaveLength(27)
    expect(tools.filter((tool) => tool.name.startsWith('cockpit_'))).toHaveLength(8)
    expect(tools.filter((tool) => tool.name.startsWith('browser_'))).toHaveLength(19)
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

// The terminal client (#182): bin/nemesis-eval is an MCP client of the same
// door. With a token that is not this run's, the app closes the connection
// and nothing is evaluated; with the run's token, eval-expression is a `yes`
// command, so the app asks in the palette, names the client and the form,
// and the value comes back only after the yes. A no is an error.
test('bin/nemesis-eval is refused without the token, and with it the app asks before it evaluates', async () => {
  const { app, userData } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    const socket = join(userData, 'mcp.sock')
    await expect.poll(() => existsSync(socket)).toBe(true)

    // The same socket through a link in a folder whose mcp.token is wrong.
    const elsewhere = mkdtempSync(join(tmpdir(), 'nemesis-eval-'))
    symlinkSync(socket, join(elsewhere, 'mcp.sock'))
    writeFileSync(join(elsewhere, 'mcp.token'), `${'0'.repeat(64)}\n`, { mode: 0o600 })
    const refused = await nemesisEval(['--socket', join(elsewhere, 'mcp.sock'), '40 + 2'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('Nemesis closed the connection')
    expect(refused.stdout).toBe('')
    await expect(page.locator('#transcript .cm-content')).not.toContainText('=> 42')

    // With the run's token: the question first, nothing evaluated before the yes.
    const allowed = nemesisEval(['--socket', socket, '40 + 2'])
    await expect(page.locator('#palette-prompt')).toHaveText(
      'nemesis-eval asks cockpit_run_command: run eval-expression with "40 + 2"?',
    )
    await expect(page.locator('#palette-candidates li').first()).toContainText('Refuse')
    await expect(page.locator('#transcript .cm-content')).not.toContainText('=> 42')
    await pick(page, 'Allow this one call')
    const ran = await allowed
    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
    expect(ran.stdout).toBe('=> 42\n')

    // A no is the client's error, and nothing runs.
    const denied = nemesisEval(['--socket', socket, '"not evaluated"'])
    await expect(page.locator('#palette-prompt')).toHaveText(
      'nemesis-eval asks cockpit_run_command: run eval-expression with ""not evaluated""?',
    )
    await pick(page, 'Refuse')
    const no = await denied
    expect(no.code).toBe(1)
    expect(no.stderr).toContain('The user refused the call')
    await expect(page.locator('#transcript .cm-content')).not.toContainText('=> "not evaluated"')
  } finally {
    await app.close()
  }
})
