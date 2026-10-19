import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentNoticeEvent } from '../../src/main/agent/events'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import { DiffBuffers } from '../../src/main/diffs'
import { HelpBuffers, type HelpListener } from '../../src/main/help'
import { diffText } from '../../src/main/mcp/buffer-texts'
import type { PageTierDeps } from '../../src/main/mcp/page-tier'
import type { BufferRegistry } from '../../src/main/buffers'
import { helloMatches, HELLO_PREFIX, McpDoor } from '../../src/main/mcp/socket'
import { connectClient, fakeCockpit } from './mcp-fakes'

const opened: { door: McpDoor; dir: string }[] = []

/**
 * One page buffer for the navigation questions (#139): its title and the
 * path of its URL are page-controlled and carry a canary, its origin is
 * what Nemesis reads off the committed URL. Each load is recorded.
 */
function onePage(loads: string[]): (buffers: BufferRegistry) => PageTierDeps {
  return (buffers) => {
    const page = buffers.create({ kind: 'page', title: 'NEMESIS-TITLE-CANARY', elementId: 'page' })
    buffers.update(page.id, { url: 'https://pages.example/NEMESIS-PATH-CANARY' })
    const never = (): never => {
      throw new Error('not read here')
    }
    return {
      list: () => buffers.list().filter((buffer) => buffer.kind === 'page'),
      committedUrl: (id) => buffers.get(id)?.url,
      snapshot: async () => ({
        pageId: page.id,
        url: buffers.get(page.id)?.url ?? '',
        origin: 'https://pages.example',
        nodes: [],
        count: 0,
      }),
      resolve: () => null,
      reader: never,
      text: never,
      form: never,
      console: { read: () => ({ entries: [], truncated: false }) },
      events: () => () => undefined,
      moves: {
        load: async (id, url) => {
          loads.push(`${id} ${url}`)
          return null
        },
        create: never,
        step: never,
        close: (id) => buffers.kill(id),
      },
      buffers,
    }
  }
}

afterEach(() => {
  for (const { door, dir } of opened.splice(0)) {
    door.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function openDoor(accept = vi.fn()) {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-mcp-'))
  const door = new McpDoor({ dir, accept, helloTimeoutMs: 200 })
  opened.push({ door, dir })
  await door.open()
  const token = readFileSync(door.tokenPath, 'utf8').trim()
  return { door, dir, token, accept }
}

/** Connects, writes `hello` (if any), and resolves with every byte received before the close. */
function exchange(path: string, hello: string | null): Promise<{ bytes: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let bytes = 0
    const socket = connect(path)
    socket.on('connect', () => {
      if (hello !== null) socket.write(hello)
    })
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    socket.on('error', reject)
    socket.on('close', () => resolve({ bytes, ms: Date.now() - started }))
  })
}

describe('the MCP door (#28, ADR 0007)', () => {
  it('owns the socket and the token 0600, a 64-hex token new on every open', async () => {
    const { door, token } = await openDoor()
    expect(statSync(door.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(door.tokenPath).mode & 0o777).toBe(0o600)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const other = await openDoor()
    expect(other.token).not.toBe(token)
  })

  it('closes a bad hello with nothing sent, and a silent connection within a second', async () => {
    const { door, token, accept } = await openDoor()
    const wrong = await exchange(door.socketPath, `${HELLO_PREFIX}${'0'.repeat(64)}\n`)
    expect(wrong.bytes).toBe(0)
    const garbage = await exchange(
      door.socketPath,
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    )
    expect(garbage.bytes).toBe(0)
    const silent = await exchange(door.socketPath, null)
    expect(silent.bytes).toBe(0)
    expect(silent.ms).toBeLessThan(1000)
    expect(accept).not.toHaveBeenCalled()
    expect(helloMatches(`${HELLO_PREFIX}${token}`, token)).toBe(true)
    expect(helloMatches(`${HELLO_PREFIX}${token} `, token)).toBe(false)
  })

  it('serves MCP after the right hello', async () => {
    const { mcp } = fakeCockpit()
    const dir = mkdtempSync(join(tmpdir(), 'nemesis-mcp-'))
    const door = new McpDoor({ dir, accept: (transport) => void mcp.connect(transport) })
    opened.push({ door, dir })
    await door.open()
    const token = readFileSync(door.tokenPath, 'utf8').trim()
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(door.socketPath)
      let text = ''
      socket.on('connect', () => {
        const initialize = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'raw', version: '1' },
          },
        }
        socket.write(`${HELLO_PREFIX}${token}\n${JSON.stringify(initialize)}\n`)
      })
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
        if (text.includes('\n')) {
          socket.destroy()
          resolve(text)
        }
      })
      socket.on('error', reject)
    })
    expect(JSON.parse(reply)).toMatchObject({ id: 1, result: { serverInfo: { name: 'nemesis' } } })
  })

  it('refuses a never command without running it', async () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register(defineCommand({ name: 'answer-yes', doc: 'Allow.', mcp: 'never', run }))
    const { mcp, prompter } = fakeCockpit(registry)
    for (const door of ['socket', 'in-app'] as const) {
      const result = await mcp.call(
        'cockpit_run_command',
        { name: 'answer-yes' },
        { door, client: 'claude' },
      )
      expect(result.isError).toBe(true)
    }
    expect(run).not.toHaveBeenCalled()
    expect(prompter.pending).toBeNull()
  })

  it('makes a yes-per-call tool wait for the prompter, the client named, the no first', async () => {
    const { mcp, prompter, submit } = fakeCockpit()
    const call = mcp.call(
      'cockpit_send_prompt',
      { text: 'hello there' },
      {
        door: 'socket',
        client: 'claude-code',
      },
    )
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    const question = prompter.pending
    expect(question?.source).toBe('mcp')
    expect(question?.prompt).toBe(
      'claude-code asks cockpit_send_prompt: send the prompt "hello there"?',
    )
    expect(question?.candidates[0]?.id).toBe('no')
    expect(submit).not.toHaveBeenCalled()

    await prompter.answer({ id: question?.id ?? '', choice: 'yes' })
    const result = await call
    expect(result.isError).toBeFalsy()
    expect(submit).toHaveBeenCalledWith('hello there')
    expect(result.structuredContent).toEqual({ id: 'p-11', status: 'sent', position: 0 })
  })

  it('refuses the call on a no, and asks nothing for the in-app door', async () => {
    const { mcp, prompter, submit, nameSession } = fakeCockpit()
    const call = mcp.call(
      'cockpit_name_session',
      { name: 'refactor' },
      {
        door: 'socket',
        client: 'claude',
      },
    )
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null })
    expect((await call).isError).toBe(true)
    expect(nameSession).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()

    const inside = await mcp.call(
      'cockpit_name_session',
      { name: 'refactor' },
      {
        door: 'in-app',
        client: 'the cockpit session',
      },
    )
    expect(inside.isError).toBeFalsy()
    expect(prompter.pending).toBeNull()
    expect(nameSession).toHaveBeenCalledWith('refactor')
  })

  it('asks one question at a time, in arrival order', async () => {
    const { mcp, prompter } = fakeCockpit()
    const first = mcp.call('cockpit_name_session', { name: 'one' }, { door: 'socket', client: 'a' })
    const second = mcp.call(
      'cockpit_name_session',
      { name: 'two' },
      { door: 'socket', client: 'b' },
    )
    await vi.waitFor(() => expect(prompter.pending?.prompt).toContain('"one"'))
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    expect((await first).isError).toBeFalsy()
    await vi.waitFor(() => expect(prompter.pending?.prompt).toContain('"two"'))
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    expect((await second).isError).toBeFalsy()
  })

  it('withdraws a question whose client disconnected before the answer (#117)', async () => {
    const { mcp, prompter, submit } = fakeCockpit()
    const heard: AgentNoticeEvent[] = []
    mcp.on((event) => heard.push(event))
    const gone = new AbortController()
    const call = mcp.call(
      'cockpit_send_prompt',
      { text: 'nobody waits for this' },
      { door: 'socket', client: 'claude-code', signal: gone.signal },
    )
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    const question = prompter.pending
    gone.abort()
    const result = await call
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('disconnected')
    expect(prompter.pending).toBeNull()
    expect(heard.map((event) => event.text)).toContain(
      'MCP: claude-code disconnected; its question was withdrawn',
    )
    // The window's late answer to the stale question runs nothing.
    await prompter.answer({ id: question?.id ?? '', choice: 'yes' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('withdraws the question of a run_command when the real client closes (#117)', async () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register(defineCommand({ name: 'kill-buffer', doc: 'Kill.', run }))
    const { mcp, prompter } = fakeCockpit(registry)
    const heard: string[] = []
    mcp.on((event) => heard.push(event.text))
    const client = await connectClient(mcp)
    const call = client
      .callTool({ name: 'cockpit_run_command', arguments: { name: 'kill-buffer' } })
      .catch(() => undefined)
    await vi.waitFor(() => expect(prompter.pending?.prompt).toContain('run kill-buffer'))
    await client.close()
    await call
    await vi.waitFor(() => expect(prompter.pending).toBeNull())
    expect(heard).toContain('MCP: test-client disconnected; its question was withdrawn')
    expect(run).not.toHaveBeenCalled()
    // The next question is asked: the queue did not stall on the gone one.
    const next = mcp.call(
      'cockpit_name_session',
      { name: 'after' },
      { door: 'socket', client: 'b' },
    )
    await vi.waitFor(() => expect(prompter.pending?.prompt).toContain('"after"'))
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    expect((await next).isError).toBeFalsy()
  })

  it('reads a help buffer and a diff buffer as the window shows them (#117)', async () => {
    const { mcp, deps, texts } = fakeCockpit()
    const help = new HelpBuffers(deps.buffers)
    texts.follow({ onShown: (listener: HelpListener) => help.on(listener) }, (c) => c.text)
    const diffs = new DiffBuffers(deps.buffers, {
      confirm: async () => false,
      open: async () => '',
    })
    texts.follow(diffs, (content) => diffText(content.diff))
    const client = await connectClient(mcp)

    const shownHelp = help.show('describe-key\nC-x b runs switch-buffer.')
    const readHelp = await client.callTool({
      name: 'cockpit_read_buffer',
      arguments: { id: shownHelp.id },
    })
    expect(readHelp.isError).toBeFalsy()
    expect(readHelp.structuredContent).toMatchObject({ kind: 'help', lines: 2, truncated: false })
    expect(readHelp.content).toEqual([
      { type: 'text', text: 'describe-key\nC-x b runs switch-buffer.' },
    ])

    diffs.observe({
      type: 'started',
      sessionId: 's1',
      model: 'm',
      permissionMode: 'default',
      cwd: '/work',
      tools: [],
    })
    diffs.observe({
      type: 'tool-use',
      toolUseId: 't1',
      name: 'Edit',
      input: { file_path: '/work/a.ts', old_string: 'one\ntwo', new_string: 'three' },
    })
    const shownDiff = diffs.show('t1')
    const readDiff = await client.callTool({
      name: 'cockpit_read_buffer',
      arguments: { id: shownDiff.id, from: 2, lines: 2 },
    })
    expect(readDiff.structuredContent).toMatchObject({ kind: 'diff', from: 2, lines: 2 })
    expect(readDiff.content).toEqual([{ type: 'text', text: '-one\n-two' }])
    const wholeDiff = await client.callTool({
      name: 'cockpit_read_buffer',
      arguments: { id: shownDiff.id },
    })
    expect(wholeDiff.content).toEqual([
      { type: 'text', text: 'Edit /work/a.ts\n-one\n-two\n+three' },
    ])

    // A killed buffer, like an id never given, is an error.
    deps.buffers.kill(shownHelp.id)
    for (const id of [shownHelp.id, 'b99']) {
      const missing = await client.callTool({ name: 'cockpit_read_buffer', arguments: { id } })
      expect(missing.isError).toBe(true)
    }
  })

  it('asks once per call for a navigation tool, the origin and the URL in the line, never the page (#139)', async () => {
    const loads: string[] = []
    const { mcp, prompter, buffers } = fakeCockpit(undefined, onePage(loads))
    const pageId = buffers.list().find((buffer) => buffer.kind === 'page')?.id ?? ''
    const navigate = (): ReturnType<typeof mcp.call> =>
      mcp.call(
        'browser_navigate',
        { url: 'next.example/a?b=1' },
        { door: 'socket', client: 'claude-code' },
      )

    const first = navigate()
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    const question = prompter.pending
    expect(question?.source).toBe('mcp')
    expect(question?.prompt).toBe(
      `claude-code asks browser_navigate on https://pages.example: load "https://next.example/a?b=1" in ${pageId}?`,
    )
    expect(question?.prompt).not.toContain('CANARY')
    expect(question?.candidates[0]?.id).toBe('no')
    expect(loads).toEqual([])
    await prompter.answer({ id: question?.id ?? '', choice: 'yes' })
    expect((await first).isError).toBeFalsy()
    expect(loads).toEqual([`${pageId} https://next.example/a?b=1`])

    // The yes was for that call: the next one asks again, and a no loads nothing.
    const second = navigate()
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    expect(prompter.pending?.id).not.toBe(question?.id)
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null })
    expect((await second).isError).toBe(true)
    expect(loads).toHaveLength(1)

    // The other moves name the page's origin, and the URL when the client gave one.
    const lines: [string, Record<string, unknown>, string][] = [
      ['browser_go_back', {}, `browser_go_back on https://pages.example: go back in ${pageId}?`],
      [
        'browser_go_forward',
        { page: pageId },
        `browser_go_forward on https://pages.example: go forward in ${pageId}?`,
      ],
      [
        'browser_open_page',
        { url: 'https://other.example/x' },
        'browser_open_page on https://other.example: open "https://other.example/x" in a new page?',
      ],
      [
        'browser_close_page',
        { page: pageId },
        `browser_close_page on https://pages.example: close ${pageId}?`,
      ],
    ]
    for (const [name, args, line] of lines) {
      const call = mcp.call(name, args, { door: 'socket', client: 'claude-code' })
      await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
      expect(prompter.pending?.prompt).toBe(`claude-code asks ${line}`)
      await prompter.answer({ id: prompter.pending?.id ?? '', choice: null })
      expect((await call).isError).toBe(true)
    }

    // A refusal comes back before anyone is asked.
    for (const url of ['http://example.com/', 'javascript:alert(1)']) {
      const refused = await mcp.call('browser_navigate', { url }, { door: 'socket', client: 'c' })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('Refused')
      expect(prompter.pending).toBeNull()
    }
    expect(loads).toHaveLength(1)
    expect(buffers.get(pageId)).toBeDefined()

    // The yes is for the page the question named, whatever is current by the answer.
    const pinned = navigate()
    await vi.waitFor(() => expect(prompter.pending?.prompt).toContain(`in ${pageId}?`))
    const other = buffers.create({ kind: 'page', title: 'Other', elementId: 'page' })
    buffers.update(other.id, { url: 'https://other.example/' })
    buffers.switchTo(other.id)
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    expect((await pinned).isError).toBeFalsy()
    expect(loads.at(-1)).toBe(`${pageId} https://next.example/a?b=1`)
  })
})
