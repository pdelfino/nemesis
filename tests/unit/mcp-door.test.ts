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
import { buildTree } from '../../src/main/pages/semantic'
import { FORM_FLAGS, SEMANTIC_STATES, type SemanticRole } from '../../src/shared/page-door'
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

/** A PNG's signature and header, enough for the tier to check and measure it. */
function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

/**
 * One page buffer to act on (#140), scrolled 1000 px down: a link and a
 * search field in view, a masked password field, an image the hint read does
 * not report, a region far below the fold, and two dropdowns, a country and
 * a masked card expiry (#141). Every string the page wrote carries a canary;
 * what the acts did is recorded in order.
 */
/** The secret field the acting fake reports while it holds the focus (#140 review). */
const PASSWORD_FIELD = {
  id: 3,
  kind: 'password' as const,
  label: 'Password',
  name: 'password',
  placeholder: '',
  choices: '',
  message: '',
  value: '',
  flags: 1 << FORM_FLAGS.indexOf('masked'),
}

function actingPage(acted: string[], focus = { id: 0 }): (buffers: BufferRegistry) => PageTierDeps {
  return (buffers) => {
    const page = buffers.create({ kind: 'page', title: 'NEMESIS-TITLE-CANARY', elementId: 'page' })
    buffers.update(page.id, { url: 'https://shop.example/NEMESIS-PATH-CANARY' })
    const masked = 1 << SEMANTIC_STATES.indexOf('masked')
    const node = (id: number, role: SemanticRole, name: string, y: number, state = 0) => ({
      id,
      depth: 0,
      role,
      name,
      value: '',
      state,
      level: 0,
      x: 10,
      y,
      width: role === 'img' ? 50 : 100,
      height: role === 'img' ? 50 : 20,
    })
    const tree = buildTree(4, {
      nodes: [
        node(1, 'link', 'NEMESIS-NAME-CANARY', 1010),
        node(2, 'textbox', 'Search', 1050),
        node(3, 'textbox', 'Password', 1090, masked),
        node(4, 'img', 'NEMESIS-IMG-CANARY', 1200),
        node(5, 'button', 'Far below', 5000),
        node(6, 'combobox', 'Country', 1130),
        node(7, 'combobox', 'Expiry', 1170, masked),
      ],
    })
    const never = (): never => {
      throw new Error('not read here')
    }
    return {
      list: () => buffers.list().filter((buffer) => buffer.kind === 'page'),
      committedUrl: (id) => buffers.get(id)?.url,
      snapshot: async () => ({
        pageId: page.id,
        url: buffers.get(page.id)?.url ?? '',
        origin: 'https://shop.example',
        ...tree,
      }),
      resolve: (ref) => {
        const match = /^d4e([0-9]+)$/.exec(ref)
        return match === null ? null : { pageId: page.id, element: Number(match[1]) }
      },
      reader: never,
      text: never,
      form: async () => ({
        document: 4,
        answer: {
          version: 1,
          same: 0,
          focused: focus.id,
          fields: focus.id === 3 ? [PASSWORD_FIELD] : [],
          alerts: [],
        },
      }),
      console: { read: () => ({ entries: [], truncated: false }) },
      events: () => () => undefined,
      moves: { load: never, create: never, step: never, close: never },
      selects: {
        options: async (_id, element) => ({
          document: 4,
          answer:
            element === 6
              ? {
                  status: 'ok',
                  multiple: 0,
                  options: [
                    { value: 'ca', label: 'Canada', disabled: 0 },
                    { value: 'fr', label: 'NEMESIS-OPTION-CANARY', disabled: 0 },
                    { value: 'xx', label: 'Closed', disabled: 1 },
                  ],
                }
              : { status: element === 7 ? 'masked' : 'not-select', multiple: 0, options: [] },
        }),
        select: async (_id, element, count, indexes) => {
          acted.push(`select ${element} ${count} ${indexes.join(',')}`)
          return { document: 4, answer: { status: 'ok', selected: indexes.length } }
        },
      },
      acts: {
        hints: async () => ({
          nodes: [1, 2, 3].map((id) => ({
            id,
            href: '',
            x: 10,
            y: 10 + (id - 1) * 40,
            width: 100,
            height: 20,
          })),
        }),
        viewport: () => ({ width: 800, height: 600 }),
        click: (_id, at) => {
          acted.push(`click ${at.x},${at.y}`)
          // A click at the search field's centre gives it the focus.
          if (at.y === 60) focus.id = 2
        },
        hover: (_id, at) => acted.push(`hover ${at.x},${at.y}`),
        drag: (_id, from, to) => acted.push(`drag ${from.x},${from.y} ${to.x},${to.y}`),
        type: async (_id, text) => {
          acted.push(`type ${text}`)
        },
        key: (_id, key) => acted.push(`key ${key}`),
        capture: async (_id, box) => {
          acted.push(`capture ${JSON.stringify(box ?? null)}`)
          return png(box?.width ?? 800, box?.height ?? 600)
        },
        captureFull: async () => {
          acted.push('capture full')
          return png(800, 3000)
        },
      },
      buffers,
      sleep: async () => undefined,
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

  it('refuses a run_command whose answer the question would cut, before asking (#182)', async () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register(defineCommand({ name: 'eval-expression', doc: 'Eval.', run }))
    const { mcp, prompter } = fakeCockpit(registry)
    const hidden = `${'1 + '.repeat(60)}1; /* past the cut */ 0`
    const result = await mcp.call(
      'cockpit_run_command',
      { name: 'eval-expression', answers: [hidden] },
      { door: 'socket', client: 'nemesis-eval' },
    )
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('longer than the question can show')
    expect(prompter.pending).toBeNull()
    expect(run).not.toHaveBeenCalled()
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
  it('refuses browser_type into a masked field before any question, and acts on nothing (#140)', async () => {
    const acted: string[] = []
    const { mcp, prompter } = fakeCockpit(undefined, actingPage(acted))
    const result = await mcp.call(
      'browser_type',
      { element: 'Password', ref: 'd4e3', text: 'hunter2' },
      { door: 'socket', client: 'claude-code' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'masked field: the human types it' }])
    expect(prompter.pending).toBeNull()
    expect(acted).toEqual([])
    // The in-app door is refused the same way, before the bridge asks.
    await expect(
      mcp.inAppQuestion('browser_type', { element: 'Password', ref: 'd4e3', text: 'x' }),
    ).rejects.toThrow('masked field: the human types it')
  })

  it('refuses a select_option the dropdown cannot take before any question, and chooses nothing (#141)', async () => {
    const acted: string[] = []
    const { mcp, prompter } = fakeCockpit(undefined, actingPage(acted))
    const refusals: [Record<string, unknown>, string][] = [
      [{ ref: 'd4e7', values: ['12'] }, 'masked field: the human chooses it'],
      [{ ref: 'd4e1', values: ['a'] }, 'is not a <select>'],
      [{ ref: 'd4e6', values: ['de'] }, 'No option of d4e6 has the value or label "de"'],
      [{ ref: 'd4e6', values: ['xx'] }, 'The option "xx" of d4e6 is disabled'],
      [{ ref: 'd4e6', values: ['ca', 'fr'] }, 'takes one choice'],
      [{ ref: 'd3e6', values: ['ca'] }, 'take a new snapshot'],
    ]
    for (const [args, said] of refusals) {
      const result = await mcp.call(
        'browser_select_option',
        { element: 'the dropdown', ...args },
        { door: 'socket', client: 'claude-code' },
      )
      expect(result.isError, said).toBe(true)
      const [item] = result.content as readonly { readonly text?: string }[]
      expect(item?.text, said).toContain(said)
      expect(prompter.pending, said).toBeNull()
    }
    // The in-app door is refused the same way, before the bridge asks.
    await expect(
      mcp.inAppQuestion('browser_select_option', {
        element: 'Expiry',
        ref: 'd4e7',
        values: ['12'],
      }),
    ).rejects.toThrow('masked field: the human chooses it')
    expect(acted).toEqual([])
  })

  it('answers a stale ref with isError and a word to take a new snapshot, unasked (#140)', async () => {
    const acted: string[] = []
    const { mcp, prompter } = fakeCockpit(undefined, actingPage(acted))
    for (const [name, args] of [
      ['browser_click', { element: 'Buy', ref: 'd3e1' }],
      ['browser_hover', { element: 'Menu', ref: 'd3e1' }],
      ['browser_type', { element: 'Search', ref: 'd3e2', text: 'a' }],
      ['browser_drag', { startElement: 'a', startRef: 'd4e1', endElement: 'b', endRef: 'd3e2' }],
      ['browser_screenshot', { ref: 'd3e4' }],
    ] as const) {
      const result = await mcp.call(name, args, { door: 'socket', client: 'claude-code' })
      expect(result.isError, name).toBe(true)
      expect(JSON.stringify(result.content), name).toContain('take a new snapshot')
      expect(prompter.pending, name).toBeNull()
    }
    // A ref out of view is refused at the act, after the yes, with nothing done.
    const far = mcp.call(
      'browser_click',
      { element: 'Far', ref: 'd4e5' },
      { door: 'socket', client: 'c' },
    )
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    expect(JSON.stringify((await far).content)).toContain('out of view')
    expect(acted).toEqual([])
  })

  it("puts the tool, the origin and the agent's element words, quoted and cut, in the line, never the page's text (#140)", async () => {
    const acted: string[] = []
    const { mcp, prompter, buffers } = fakeCockpit(undefined, actingPage(acted))
    const pageId = buffers.list().find((buffer) => buffer.kind === 'page')?.id ?? ''
    const on = 'https://shop.example'
    const lines: [string, Record<string, unknown>, string, string[]][] = [
      [
        'browser_click',
        { element: 'the Buy link', ref: 'd4e1' },
        `browser_click on ${on}: click "the Buy link" in ${pageId}?`,
        ['click 60,20'],
      ],
      [
        'browser_hover',
        { element: 'the Buy link', ref: 'd4e1' },
        `browser_hover on ${on}: hover over "the Buy link" in ${pageId}?`,
        ['hover 60,20'],
      ],
      [
        'browser_type',
        { element: 'Search box', ref: 'd4e2', text: 'shoes', submit: true },
        `browser_type on ${on}: type "shoes" (5 characters) into "Search box" in ${pageId}, then press Enter to submit it?`,
        ['click 60,60', 'type shoes', 'key Enter'],
      ],
      [
        'browser_select_option',
        { element: 'the country', ref: 'd4e6', values: ['fr'] },
        `browser_select_option on ${on}: choose "fr" in "the country" in ${pageId}?`,
        ['select 6 3 1'],
      ],
      [
        'browser_select_option',
        { element: 'the country', ref: 'd4e6', values: ['Canada', 'ca'] },
        `browser_select_option on ${on}: choose "Canada", "ca" in "the country" in ${pageId}?`,
        ['select 6 3 0'],
      ],
      [
        'browser_press_key',
        { key: 'Enter' },
        `browser_press_key on ${on}: press "Enter" in ${pageId}, which may submit a form?`,
        ['key Enter'],
      ],
      [
        'browser_drag',
        { startElement: 'the link', startRef: 'd4e1', endElement: 'the field', endRef: 'd4e2' },
        `browser_drag on ${on}: drag "the link" onto "the field" in ${pageId}?`,
        ['drag 60,20 60,60'],
      ],
      [
        'browser_screenshot',
        { ref: 'd4e4' },
        `browser_screenshot on ${on}: capture the element d4e4 of ${pageId} as an image, secret fields as the page draws them?`,
        // The image is placed in the viewport by the scroll the link gives.
        [`capture ${JSON.stringify({ x: 10, y: 200, width: 50, height: 50 })}`],
      ],
    ]
    for (const [name, args, line, did] of lines) {
      acted.length = 0
      const call = mcp.call(name, args, { door: 'socket', client: 'claude-code' })
      await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
      expect(prompter.pending?.prompt).toBe(`claude-code asks ${line}`)
      expect(prompter.pending?.prompt).not.toContain('CANARY')
      expect(acted, name).toEqual([])
      await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
      const result = await call
      expect(result.isError, `${name} ${JSON.stringify(result.content)}`).toBeFalsy()
      expect(acted, name).toEqual(did)
      // The page's strings reach the structure only as `untrusted`, the labeled block (#151).
      const { untrusted, ...own } = result.structuredContent as Record<string, unknown>
      expect(JSON.stringify(own), name).not.toContain('CANARY')
      const block = (result.content as readonly { text?: string }[])[1]?.text
      expect(untrusted, name).toBe(block)
      if (typeof untrusted === 'string') {
        expect(untrusted.startsWith('--- untrusted content from '), name).toBe(true)
        expect(untrusted.endsWith(' ---'), name).toBe(true)
      }
    }

    // A long description is cut to the screen, on one line.
    const long = mcp.call(
      'browser_click',
      { element: `a\n${'x'.repeat(300)}`, ref: 'd4e1' },
      { door: 'socket', client: 'claude-code' },
    )
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    expect(prompter.pending?.prompt).toContain(`click "a ${'x'.repeat(198)}..." in ${pageId}?`)
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null })
    expect((await long).isError).toBe(true)

    // The in-app line is the same, with the cockpit session as the client.
    const inApp = await mcp.inAppQuestion('browser_click', { element: 'Buy', ref: 'd4e1' })
    expect(inApp).toEqual({
      title: `the cockpit session asks browser_click on ${on}: click "Buy" in ${pageId}?`,
      args: { element: 'Buy', ref: 'd4e1', page: pageId },
    })
    expect(await mcp.inAppQuestion('browser_navigate', { url: 'https://a.example' })).toBeNull()

    // A key the tier does not press, and a chord, are refused unasked.
    for (const key of ['Control+a', 'F13']) {
      const refused = await mcp.call('browser_press_key', { key }, { door: 'socket', client: 'c' })
      expect(refused.isError, key).toBe(true)
      expect(prompter.pending).toBeNull()
    }
  })

  it('returns a screenshot as one image/png item and its size, the whole page through captureFull (#140)', async () => {
    const acted: string[] = []
    const { mcp, buffers } = fakeCockpit(undefined, actingPage(acted))
    const pageId = buffers.list().find((buffer) => buffer.kind === 'page')?.id ?? ''
    const inApp = { door: 'in-app', client: 'the cockpit session' } as const
    const full = await mcp.call('browser_screenshot', { fullPage: true }, inApp)
    expect(full.structuredContent).toEqual({
      page: pageId,
      origin: 'https://shop.example',
      width: 800,
      height: 3000,
    })
    const content = full.content as readonly { type: string; mimeType?: string; data?: string }[]
    expect(content.map((item) => item.type)).toEqual(['text', 'image'])
    expect(content[1]?.mimeType).toBe('image/png')
    expect(content[1]?.data).toBe(png(800, 3000))
    const typed = await mcp.call(
      'browser_type',
      { element: 'Search', ref: 'd4e2', text: 'a' },
      inApp,
    )
    expect(typed.structuredContent).toMatchObject({ ref: 'd4e2', submitted: false })
    expect(acted).toEqual(['capture full', 'click 60,60', 'type a'])
    const both = await mcp.call('browser_screenshot', { fullPage: true, ref: 'd4e4' }, inApp)
    expect(both.isError).toBe(true)
  })
})

describe('the human types secrets, one key at a time too (review of #140)', () => {
  it('refuses a key that types into a focused secret field, unasked, at either door', async () => {
    const acted: string[] = []
    const { mcp, prompter } = fakeCockpit(undefined, actingPage(acted, { id: 3 }))
    for (const key of ['a', 'Space']) {
      const refused = await mcp.call('browser_press_key', { key }, { door: 'socket', client: 'c' })
      expect(refused.isError, key).toBe(true)
      expect(JSON.stringify(refused.content), key).toContain('masked field: the human types it')
      expect(prompter.pending).toBeNull()
    }
    await expect(mcp.inAppQuestion('browser_press_key', { key: 'a' })).rejects.toThrow(
      'masked field: the human types it',
    )
    expect(acted).toEqual([])
  })

  it('lets Enter through on a secret field, and any key on an ordinary one', async () => {
    const acted: string[] = []
    const focus = { id: 3 }
    const { mcp, prompter } = fakeCockpit(undefined, actingPage(acted, focus))
    const enter = mcp.call('browser_press_key', { key: 'Enter' }, { door: 'socket', client: 'c' })
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    expect((await enter).isError).toBeFalsy()
    expect(acted).toEqual(['key Enter'])

    focus.id = 2
    const letter = mcp.call('browser_press_key', { key: 'a' }, { door: 'socket', client: 'c' })
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    expect((await letter).isError).toBeFalsy()
    expect(acted).toEqual(['key Enter', 'key a'])
  })

  it('refuses at the act when the focus moved to a secret field after the yes', async () => {
    const acted: string[] = []
    const focus = { id: 2 }
    const { mcp, prompter } = fakeCockpit(undefined, actingPage(acted, focus))
    const call = mcp.call('browser_press_key', { key: 'a' }, { door: 'socket', client: 'c' })
    await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
    focus.id = 3
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    const result = await call
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('masked field: the human types it')
    expect(acted).toEqual([])
  })
})
