import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '../_test'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * ADR 0007, "What a page can never reach, as a spec" (#28): the MCP door is
 * a Unix socket in the profile, mode 0600, behind a per-run token. A page has
 * no path to it: no bridge member names the socket, the token or the
 * profile, no invoke channel answers with any of them, and a page has no
 * API that opens a Unix socket. A process that has the path and not the
 * token is closed with nothing sent.
 */

interface BridgeWindow {
  readonly nemesis?: Record<string, unknown>
}

/** Connects, writes `hello` (if any), and resolves with what came back before the close. */
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

test('a page cannot reach the MCP socket, and a connection without the token gets nothing', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  try {
    const socket = join(nemesis.userData, 'mcp.sock')
    const tokenFile = join(nemesis.userData, 'mcp.token')
    await expect.poll(() => existsSync(socket)).toBe(true)
    expect(statSync(socket).mode & 0o777).toBe(0o600)
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    const token = readFileSync(tokenFile, 'utf8').trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const secrets = [nemesis.userData, 'mcp.sock', 'mcp.token', token]

    // A page buffer as the app holds one: no bridge at all.
    const plain = await nemesis.openPageBuffer(fixtures.secureUrl('node-probe.html'))
    expect(plain.loadError).toBeNull()
    expect(await plain.page.evaluate(() => (globalThis as BridgeWindow).nemesis)).toBeUndefined()

    // The strongest position a page can be given: the cockpit's preload on
    // a hostile origin. The bridge names nothing of the door, and what its
    // argument-free invokes answer (or refuse with) carries none of it.
    const hostile = await nemesis.openPageBuffer(fixtures.secureUrl('node-probe.html'), {
      withPreload: true,
    })
    expect(hostile.loadError).toBeNull()
    const seen = await hostile.page.evaluate(async () => {
      const bridge = (globalThis as BridgeWindow).nemesis ?? {}
      const members = Object.keys(bridge)
      const answers: string[] = []
      for (const name of ['buffers', 'bindings', 'promptState']) {
        const member = bridge[name]
        if (typeof member !== 'function') continue
        try {
          answers.push(JSON.stringify(await (member as () => Promise<unknown>)()))
        } catch (error) {
          answers.push(error instanceof Error ? error.message : String(error))
        }
      }
      return { members, answers }
    })
    expect(seen.members).toContain('name')
    for (const member of seen.members) expect(member).not.toMatch(/mcp|socket|token|userdata/i)
    for (const answer of seen.answers) {
      for (const secret of secrets) expect(answer).not.toContain(secret)
    }

    // The cockpit's own bridge names nothing of it either.
    const own = await nemesis.window.evaluate(() =>
      Object.keys((globalThis as BridgeWindow).nemesis ?? {}),
    )
    for (const member of own) expect(member).not.toMatch(/mcp|socket|token|userdata/i)

    // Without the token: closed within a second, with nothing sent.
    const silent = await exchange(socket, null)
    expect(silent.bytes).toBe(0)
    expect(silent.ms).toBeLessThan(1500)
    const wrong = await exchange(socket, `NEMESIS-MCP 1 ${'0'.repeat(64)}\n`)
    expect(wrong.bytes).toBe(0)
    const bare = await exchange(
      socket,
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    )
    expect(bare.bytes).toBe(0)

    await hostile.close()
    await plain.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
