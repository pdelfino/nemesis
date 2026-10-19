import { describe, expect, it, vi } from 'vitest'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { parseBufferSpec } from '../../src/main/buffers'
import { createCockpitRegistry } from '../../src/main/commands/keyscheme'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import { CATALOG, CATALOG_VERSION, TIER_PREFIX } from '../../src/main/mcp/catalog'
import { connectClient, fakeCockpit } from './mcp-fakes'

const COCKPIT_TOOLS = [
  'cockpit_list_commands',
  'cockpit_run_command',
  'cockpit_list_buffers',
  'cockpit_read_buffer',
  'cockpit_send_prompt',
  'cockpit_search_transcripts',
  'cockpit_session_info',
  'cockpit_name_session',
]

describe('the MCP catalog (#28, ADR 0008)', () => {
  it('is the eight cockpit tools, and tools/list serves exactly the table', async () => {
    expect(CATALOG.map((tool) => tool.name)).toEqual(COCKPIT_TOOLS)
    const client = await connectClient(fakeCockpit().mcp)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(CATALOG.map((tool) => tool.name))
    for (const tool of tools) {
      const row = CATALOG.find((entry) => entry.name === tool.name)
      expect(tool.description).toBe(row?.description)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.outputSchema?.type).toBe('object')
    }
  })

  it('gives every tool a class and the prefix of its tier', () => {
    for (const tool of CATALOG) {
      expect(['free', 'yes', 'command']).toContain(tool.confirmation)
      expect(tool.name.startsWith(TIER_PREFIX[tool.tier])).toBe(true)
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)+$/)
    }
  })

  it('has no page tool, no page buffer opened over IPC, and no eval tool at all', () => {
    expect(() => parseBufferSpec({ kind: 'page', title: 'A page' })).toThrow()
    expect(CATALOG.filter((tool) => tool.tier === 'browser')).toEqual([])
    expect(CATALOG.filter((tool) => tool.name.startsWith('browser_'))).toEqual([])
    expect(CATALOG.map((tool) => tool.name).filter((name) => /eval|_script/.test(name))).toEqual([])
  })

  it('hides cockpit_send_prompt from the session inside the cockpit', async () => {
    const client = await connectClient(fakeCockpit().mcp, 'in-app')
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(
      COCKPIT_TOOLS.filter((name) => name !== 'cockpit_send_prompt'),
    )
    const result = await client.callTool({ name: 'cockpit_send_prompt', arguments: { text: 'x' } })
    expect(result.isError).toBe(true)
  })

  it('answers a free tool at once, typed and as text', async () => {
    const client = await connectClient(fakeCockpit().mcp)
    const result = await client.callTool({ name: 'cockpit_list_buffers', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      buffers: [
        { id: 'b1', kind: 'transcript', title: 'Transcript', current: false },
        { id: 'b2', kind: 'prompt', title: 'Prompt', current: true },
      ],
    })
    expect(JSON.stringify(result.content)).toContain('b2 prompt Prompt (current)')

    const read = await client.callTool({ name: 'cockpit_read_buffer', arguments: { id: 'b2' } })
    expect(read.structuredContent).toEqual({
      id: 'b2',
      kind: 'prompt',
      title: 'Prompt',
      from: 1,
      lines: 1,
      truncated: false,
    })
    expect(read.content).toEqual([{ type: 'text', text: 'the draft' }])

    const info = await client.callTool({ name: 'cockpit_session_info', arguments: {} })
    expect(info.structuredContent).toMatchObject({ sessionId: null, catalog: CATALOG_VERSION })
  })

  it('answers a name outside the catalog with isError, not a protocol fault', async () => {
    const client = await connectClient(fakeCockpit().mcp)
    const result = await client.callTool({ name: 'cockpit_eval', arguments: {} })
    expect(result.isError).toBe(true)
  })

  it('lists the commands live from the registry, with their classes', async () => {
    const registry = new CommandRegistry()
    const { mcp } = fakeCockpit(registry)
    const client = await connectClient(mcp)
    registry.register(
      defineCommand({ name: 'later', doc: 'Registered after connect.', run: () => {} }),
    )
    registry.register(
      defineCommand({ name: 'peek', doc: 'Reads only.', mcp: 'free', run: () => {} }),
    )
    const result = await client.callTool({ name: 'cockpit_list_commands', arguments: {} })
    expect(result.structuredContent).toEqual({
      commands: [
        { name: 'later', doc: 'Registered after connect.', class: 'yes' },
        { name: 'peek', doc: 'Reads only.', class: 'free' },
      ],
    })
  })

  it('declares the classes ADR 0008 names on the cockpit commands', () => {
    const registry = createCockpitRegistry()
    for (const name of ['describe-command', 'describe-key', 'list-diffs']) {
      expect(registry.require(name).mcp).toBe('free')
    }
    for (const name of [
      'execute-command',
      'answer-yes',
      'answer-no',
      'allow-for-session',
      'approve-plan',
      'reject-plan',
      'choose-option-1',
    ]) {
      expect(registry.require(name).mcp).toBe('never')
    }
    expect(registry.require('kill-buffer').mcp).toBeUndefined()
  })

  it('tells every connected client the list changed after a reload', async () => {
    const { mcp } = fakeCockpit()
    const client = await connectClient(mcp)
    const heard = vi.fn()
    client.setNotificationHandler(ToolListChangedNotificationSchema, heard)
    mcp.toolsChanged()
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1))
  })

  it('feeds a free command its reads from answers, and fails when none is left', async () => {
    const registry = new CommandRegistry()
    const { mcp, prompter } = fakeCockpit(registry)
    const picked: string[] = []
    registry.register(
      defineCommand({
        name: 'pick-color',
        doc: 'Pick a color.',
        mcp: 'free',
        run: () => {
          prompter.read({ source: 'colors', prompt: 'Color:' }, (id) => {
            picked.push(id)
          })
        },
      }),
    )
    const client = await connectClient(mcp)
    const ok = await client.callTool({
      name: 'cockpit_run_command',
      arguments: { name: 'pick-color', answers: ['green'] },
    })
    expect(ok.isError).toBeFalsy()
    expect(ok.structuredContent).toEqual({ name: 'pick-color', notices: [] })
    expect(picked).toEqual(['g'])
    expect(prompter.pending).toBeNull()

    const short = await client.callTool({
      name: 'cockpit_run_command',
      arguments: { name: 'pick-color' },
    })
    expect(short.isError).toBe(true)
    expect(JSON.stringify(short.content)).toContain('Color:')
    expect(prompter.pending).toBeNull()
  })
})
