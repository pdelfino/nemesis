import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import { helloMatches, HELLO_PREFIX, McpDoor } from '../../src/main/mcp/socket'
import { fakeCockpit } from './mcp-fakes'

const opened: { door: McpDoor; dir: string }[] = []

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
})
