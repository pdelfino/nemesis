import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * The door of ADR 0007 (#28): a Unix domain socket in the user data folder,
 * owned 0600, and a per-run token beside it. A client reaches it through
 * bin/nemesis-mcp, which sends the hello line and then forwards bytes; main
 * holds the one MCP implementation.
 *
 * A Unix socket has no port, no interface and no URL, so no other machine
 * and no web page can address it, and the no-network spec sees nothing of
 * it. The file permissions keep other users out; the token closes the case
 * they cannot see, a process that has the path and not the file, and ties a
 * connection to this run, so a shim that outlived a restart is refused.
 * Nothing in src/shared/, the preload or the renderer names any of this.
 */

export const SOCKET_FILE = 'mcp.sock'
export const TOKEN_FILE = 'mcp.token'
/** The first line of every connection, then the token. */
export const HELLO_PREFIX = 'NEMESIS-MCP 1 '

/** A connection that has not said hello by then is closed. */
const HELLO_TIMEOUT_MS = 1000
/** More than a hello line before the newline is not a hello. */
const HELLO_MAX = HELLO_PREFIX.length + 64 + 2
/** A stale socket that does not answer a connect within this is taken as dead. */
const PROBE_TIMEOUT_MS = 500

/** True when `line` is the hello of this run: the prefix and the token, nothing else. */
export function helloMatches(line: string, token: string): boolean {
  const expected = Buffer.from(`${HELLO_PREFIX}${token}`, 'utf8')
  const given = Buffer.from(line.replace(/\r$/, ''), 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** A fresh token: 32 random bytes as hex. */
export function newToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The MCP SDK's transport over one accepted socket: newline-delimited
 * JSON-RPC, the stdio framing, which is what the shim forwards. `rest` is
 * whatever arrived after the hello line.
 */
export class SocketTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly socket: Socket
  private readonly buffer = new ReadBuffer()
  private readonly rest: Buffer

  constructor(socket: Socket, rest: Buffer) {
    this.socket = socket
    this.rest = rest
  }

  async start(): Promise<void> {
    this.socket.on('data', (chunk: Buffer) => this.receive(chunk))
    this.socket.on('error', (error) => this.onerror?.(error))
    this.socket.once('close', () => this.onclose?.())
    if (this.rest.length > 0) this.receive(this.rest)
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error('The client has gone'))
        return
      }
      this.socket.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()))
    })
  }

  async close(): Promise<void> {
    this.socket.destroy()
  }

  private receive(chunk: Buffer): void {
    try {
      this.buffer.append(chunk)
      for (let message = this.buffer.readMessage(); message !== null;) {
        this.onmessage?.(message)
        message = this.buffer.readMessage()
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

export interface McpDoorOptions {
  /** The user data folder: the socket and the token live here. */
  readonly dir: string
  /** A connection that said hello, as a transport for the server. */
  readonly accept: (transport: Transport) => void
  /** The tests pass a short one. */
  readonly helloTimeoutMs?: number | undefined
}

export class McpDoorError extends Error {
  override readonly name = 'McpDoorError'
}

export class McpDoor {
  readonly socketPath: string
  readonly tokenPath: string
  private readonly accept: (transport: Transport) => void
  private readonly helloTimeoutMs: number
  private readonly token = newToken()
  private server: Server | null = null

  constructor(options: McpDoorOptions) {
    this.socketPath = join(options.dir, SOCKET_FILE)
    this.tokenPath = join(options.dir, TOKEN_FILE)
    this.accept = options.accept
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  }

  /**
   * Writes the token and listens. A socket file left by a crashed run is
   * probed and removed when nothing answers; one that answers belongs to a
   * running cockpit on the same profile, and this one opens no door.
   */
  async open(): Promise<void> {
    if (existsSync(this.socketPath)) {
      if (await answers(this.socketPath)) {
        throw new McpDoorError(`Another Nemesis answers on ${this.socketPath}`)
      }
      rmSync(this.socketPath, { force: true })
    }
    writeFileSync(this.tokenPath, `${this.token}\n`, { mode: 0o600 })
    chmodSync(this.tokenPath, 0o600)
    const server = createServer((socket) => this.greet(socket))
    // The socket file is created by bind with the umask's mode; a narrow
    // umask for that one call means it is never readable by anyone else.
    const umask = process.umask(0o177)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } finally {
      process.umask(umask)
    }
    chmodSync(this.socketPath, 0o600)
    this.server = server
  }

  /** At `will-quit`: no listener, no socket file, no token. */
  close(): void {
    this.server?.close()
    this.server = null
    rmSync(this.socketPath, { force: true })
    rmSync(this.tokenPath, { force: true })
  }

  /** Reads the hello line; anything else, or nothing in time, is closed with nothing sent. */
  private greet(socket: Socket): void {
    let received = Buffer.alloc(0)
    const refuse = (): void => {
      clearTimeout(timer)
      socket.destroy()
    }
    const timer = setTimeout(refuse, this.helloTimeoutMs)
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf('\n')
      if (end === -1) {
        if (received.length > HELLO_MAX) refuse()
        return
      }
      socket.off('data', onData)
      clearTimeout(timer)
      if (!helloMatches(received.toString('utf8', 0, end), this.token)) {
        socket.destroy()
        return
      }
      this.accept(new SocketTransport(socket, received.subarray(end + 1)))
    }
    socket.on('data', onData)
    socket.on('error', refuse)
  }
}

/** True when something accepts a connection on `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    const done = (alive: boolean): void => {
      clearTimeout(timer)
      probe.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS)
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
  })
}
