import { vi, type Mock } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AgentEvent } from '../../src/main/agent/events'
import { createCockpitBuffers } from '../../src/main/buffers'
import { CONFIRM_SOURCES } from '../../src/main/commands/confirm'
import { Prompter } from '../../src/main/commands/prompter'
import { CommandRegistry } from '../../src/main/commands/registry'
import { BufferTexts } from '../../src/main/mcp/buffer-texts'
import { CockpitMcp, type CockpitMcpDeps, type McpDoorKind } from '../../src/main/mcp/server'

export interface FakeCockpit {
  readonly mcp: CockpitMcp
  readonly deps: CockpitMcpDeps
  readonly registry: CommandRegistry
  readonly prompter: Prompter
  readonly submit: Mock<CockpitMcpDeps['prompts']['submit']>
  readonly nameSession: Mock<(name: string) => void>
  /** What the window was pushed of the other buffer kinds (#117). */
  readonly texts: BufferTexts
  /** Sends an event down the fake session's stream. */
  emit(event: AgentEvent): void
  /** Points the server at a session folder, as the recorder would once it had one. */
  setFolder(folder: string | null): void
}

/** The MCP specs' cockpit (#28): the real registry, buffers and prompter, a fake session and queue. */
export function fakeCockpit(registry = new CommandRegistry()): FakeCockpit {
  const prompter = new Prompter()
  for (const source of CONFIRM_SOURCES) prompter.addSource(source)
  prompter.addSource({
    name: 'colors',
    candidates: () => [
      { id: 'r', label: 'red', doc: 'Red.' },
      { id: 'g', label: 'green', doc: 'Green.' },
    ],
  })
  const listeners = new Set<(event: AgentEvent) => void>()
  const submit = vi.fn<CockpitMcpDeps['prompts']['submit']>(async (text) => ({
    id: `p-${text.length}`,
    status: 'sent',
    position: 0,
  }))
  const nameSession = vi.fn<(name: string) => void>()
  const buffers = createCockpitBuffers()
  const texts = new BufferTexts(buffers)
  let folder: string | null = null
  const deps: CockpitMcpDeps = {
    registry,
    buffers,
    prompter,
    agent: {
      sessionId: null,
      busy: false,
      permissionMode: 'default',
      nameSession,
      on: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    prompts: { draft: 'the draft', submit, state: () => ({ queued: [] }) },
    sessionsDir: null,
    sessionFolder: () => folder,
    notices: { on: () => () => undefined },
    cwd: '/work',
    version: '0.0.1',
    texts,
  }
  return {
    mcp: new CockpitMcp(deps),
    deps,
    registry,
    prompter,
    submit,
    nameSession,
    texts,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    setFolder: (next) => {
      folder = next
    },
  }
}

/** A client connected to one fresh server of `mcp` over the SDK's in-memory pair. */
export async function connectClient(
  mcp: CockpitMcp,
  door: McpDoorKind = 'socket',
): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await mcp.serve(door).connect(serverSide)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientSide)
  return client
}
