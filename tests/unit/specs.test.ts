import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentToolUseEvent } from '../../src/main/agent/events'
import { mockDriver } from '../../src/main/agent/mock'
import { denyEveryTool } from '../../src/main/agent/session'
import { SessionManager } from '../../src/main/agent/session-manager'
import { createCockpitBuffers, type BufferRegistry } from '../../src/main/buffers'
import {
  askCodebasePrompt,
  freshSessionPrompt,
  interviewPrompt,
  investigatePrompt,
} from '../../src/main/commands/guide-prompts'
import { createCockpitRegistry, resolveCockpitDeps } from '../../src/main/commands/keyscheme'
import { Prompter } from '../../src/main/commands/prompter'
import { CommandError } from '../../src/main/commands/registry'
import { parseSpecWrite, SpecBuffers } from '../../src/main/specs'

// The guide's communication practices as commands (#85): interview, with the
// spec it ends with as a buffer and a fresh session from it; investigate,
// wrapped in the guide's words; ask-codebase, as typed.

const SPEC = '# Spec: a calendar widget\n\n- Priority: beta\n'

function write(filePath: string, content: unknown, toolUseId = 't1'): AgentToolUseEvent {
  return { type: 'tool-use', toolUseId, name: 'Write', input: { file_path: filePath, content } }
}

function result(toolUseId: string, isError = false): AgentEvent {
  return { type: 'tool-result', toolUseId, isError, text: isError ? 'denied' : 'Wrote it' }
}

interface Harness {
  readonly buffers: BufferRegistry
  readonly specs: SpecBuffers
  readonly notices: string[]
  readonly shown: { bufferId: string; filePath: string; text: string }[]
}

function harness(): Harness {
  const buffers = createCockpitBuffers()
  const specs = new SpecBuffers(buffers)
  const notices: string[] = []
  specs.on((event) => {
    if (event.type === 'notice') notices.push(event.text)
  })
  const shown: Harness['shown'] = []
  specs.onShown((content) => shown.push(content))
  return { buffers, specs, notices, shown }
}

describe("the guide's prompts", () => {
  it("are the guide's words with the one line in the place of the description", () => {
    expect(interviewPrompt('  a calendar\n widget ')).toBe(
      [
        'I want to build a calendar widget. Interview me in detail using the AskUserQuestion tool.',
        '',
        "Ask about technical implementation, UI/UX, edge cases, concerns, and tradeoffs. Don't ask obvious questions, dig into the hard parts I might not have considered.",
        '',
        "Keep interviewing until we've covered everything, then write a complete spec to SPEC.md.",
      ].join('\n'),
    )
    expect(investigatePrompt(' how tokens refresh ')).toBe(
      'Use subagents to investigate how tokens refresh',
    )
    expect(askCodebasePrompt(' how does logging work ')).toBe('how does logging work')
  })

  it('open the fresh session with the spec itself after one line saying what it is', () => {
    const prompt = freshSessionPrompt('/work/SPEC.md', `${SPEC}\n\n`)
    expect(prompt.startsWith('Implement the spec below. It was written to /work/SPEC.md')).toBe(
      true,
    )
    expect(prompt.endsWith(`\n\n${SPEC.trimEnd()}`)).toBe(true)
  })
})

describe('the spec of a Write call', () => {
  it('is the content of a Write to a file named SPEC.md, in any folder', () => {
    expect(parseSpecWrite(write('/work/SPEC.md', SPEC))).toEqual({
      filePath: '/work/SPEC.md',
      text: SPEC,
    })
    expect(parseSpecWrite(write('/work/docs/SPEC.md', SPEC))).toMatchObject({
      filePath: '/work/docs/SPEC.md',
    })
  })

  it('is nothing for another file, another tool or arguments out of shape', () => {
    expect(parseSpecWrite(write('/work/spec.md', SPEC))).toBeNull()
    expect(parseSpecWrite(write('/work/README.md', SPEC))).toBeNull()
    expect(parseSpecWrite(write('/work/SPEC.md', 42))).toBeNull()
    expect(parseSpecWrite({ ...write('/work/SPEC.md', SPEC), name: 'Edit' })).toBeNull()
  })
})

describe('the spec buffers', () => {
  it('open a spec buffer with the point once the Write went through, and say so', () => {
    const { buffers, specs, notices, shown } = harness()
    specs.observe(write('/work/SPEC.md', SPEC))
    // Asked, not yet answered: nothing opens.
    expect(buffers.list().map((buffer) => buffer.kind)).toEqual(['transcript', 'prompt'])
    specs.observe(result('t1'))
    const buffer = buffers.current
    expect(buffer).toMatchObject({ kind: 'spec', title: 'Spec: SPEC.md', elementId: 'spec' })
    expect(specs.current).toEqual({ bufferId: buffer?.id, filePath: '/work/SPEC.md', text: SPEC })
    expect(shown).toEqual([{ bufferId: buffer?.id, filePath: '/work/SPEC.md', text: SPEC }])
    expect(notices).toEqual([
      'Spec written to /work/SPEC.md: C-c C-c in the spec buffer starts a fresh session with it as the first message.',
    ])
  })

  it('open nothing for a Write that was denied, or asked by a session that stopped', () => {
    const { buffers, specs } = harness()
    specs.observe(write('/work/SPEC.md', SPEC))
    specs.observe(result('t1', true))
    specs.observe(write('/work/SPEC.md', SPEC, 't2'))
    specs.observe({ type: 'stopped', reason: 'ended' })
    specs.observe(result('t2'))
    expect(buffers.list().map((buffer) => buffer.kind)).toEqual(['transcript', 'prompt'])
    expect(specs.current).toBeNull()
  })

  it('answer for the current spec buffer first, then the last one opened, and forget a killed one', () => {
    const { buffers, specs } = harness()
    specs.observe(write('/work/SPEC.md', 'one', 't1'))
    specs.observe(result('t1'))
    const first = buffers.current
    specs.observe(write('/work/docs/SPEC.md', 'two', 't2'))
    specs.observe(result('t2'))
    const second = buffers.current
    if (first === null || second === null) throw new Error('no spec buffers')
    expect(specs.list().map((spec) => spec.text)).toEqual(['one', 'two'])
    expect(specs.current?.text).toBe('two')
    buffers.switchTo(first.id)
    expect(specs.current?.text).toBe('one')
    buffers.switchTo(buffers.list()[0]?.id ?? '')
    expect(specs.current?.text).toBe('two')
    buffers.kill(second.id)
    expect(specs.list().map((spec) => spec.text)).toEqual(['one'])
    expect(specs.current).toBeNull()
    buffers.switchTo(first.id)
    expect(specs.current?.text).toBe('one')
  })

  it('hand the spec over on take: the buffer closes, the point goes to the prompt, the stream says so', () => {
    const { buffers, specs, notices } = harness()
    specs.observe(write('/work/SPEC.md', SPEC))
    specs.observe(result('t1'))
    const buffer = buffers.current
    if (buffer === null) throw new Error('no spec buffer')
    expect(specs.take(buffer.id)).toEqual({
      bufferId: buffer.id,
      filePath: '/work/SPEC.md',
      text: SPEC,
    })
    expect(buffers.get(buffer.id)).toBeUndefined()
    expect(buffers.current?.kind).toBe('prompt')
    expect(specs.current).toBeNull()
    expect(notices.at(-1)).toBe(
      'Fresh session from the spec in /work/SPEC.md: the context is cleared and the spec is the first message.',
    )
    expect(() => specs.take(buffer.id)).toThrow(CommandError)
  })
})

describe('the three commands and the fresh session', () => {
  function cockpit() {
    const buffers = createCockpitBuffers()
    const prompter = new Prompter()
    const submit = vi.fn<(text: string) => Promise<never>>(() =>
      Promise.reject(new Error('unused')),
    )
    const specs = new SpecBuffers(buffers)
    const agent = new SessionManager({
      cwd: '/tmp/nemesis-unit',
      model: null,
      permissionHandler: denyEveryTool,
      driver: mockDriver(),
    })
    const deps = resolveCockpitDeps({
      buffers,
      prompter,
      specs,
      agent,
      prompts: {
        submit: submit as unknown as (text: string) => Promise<never>,
        insert: () => undefined,
        attachImage: () => {
          throw new Error('unused')
        },
        draft: '',
        state: () => ({ busy: false, queued: [] }),
        edit: () => undefined,
        remove: () => undefined,
        mergeAll: () => 0,
        steer: () => {
          throw new Error('unused')
        },
      },
    })
    const registry = createCockpitRegistry(deps)
    return { buffers, prompter, submit, specs, agent, registry }
  }

  it('read one line each and send the prompt the guide names, or the question as typed', async () => {
    const { prompter, submit, registry } = cockpit()
    submit.mockImplementation(() =>
      Promise.resolve({ id: 'p1', status: 'sent', position: 0 } as never),
    )
    for (const [name, prompt, typed, sent] of [
      ['ask-codebase', 'Ask the codebase:', 'how does logging work', 'how does logging work'],
      [
        'investigate',
        'Investigate:',
        'how tokens refresh',
        'Use subagents to investigate how tokens refresh',
      ],
      [
        'interview',
        'Interview me about:',
        'a calendar widget',
        interviewPrompt('a calendar widget'),
      ],
    ] as const) {
      await registry.run(name, { source: 'palette' })
      const read = prompter.pending
      expect(read).toMatchObject({ source: 'question', prompt, freeText: true, candidates: [] })
      if (read === null) throw new Error('no read')
      await prompter.answer({ id: read.id, choice: null, text: typed })
      expect(submit).toHaveBeenLastCalledWith(sent)
    }
    expect(submit).toHaveBeenCalledTimes(3)
    // The palette lists the three side by side.
    expect(registry.list().map((command) => command.name)).toEqual(
      expect.arrayContaining(['ask-codebase', 'investigate', 'interview']),
    )
  })

  it('start-fresh-session-from-spec drops the session and sends the spec first', async () => {
    const { buffers, submit, specs, agent, registry } = cockpit()
    submit.mockImplementation(() =>
      Promise.resolve({ id: 'p1', status: 'sent', position: 0 } as never),
    )
    await expect(
      registry.run('start-fresh-session-from-spec', { source: 'palette' }),
    ).rejects.toThrow('No spec buffer is open')
    // A session with a turn behind it, then the spec arrives.
    const turn = new Promise<void>((resolve) => {
      const off = agent.on((event) => {
        if (event.type === 'turn-end') {
          off()
          resolve()
        }
      })
    })
    await agent.send('hello')
    await turn
    expect(agent.sessionId).toBe('mock-session')
    const notices: string[] = []
    agent.on((event) => {
      if (event.type === 'notice') notices.push(event.text)
    })
    specs.observe(write('/work/SPEC.md', SPEC))
    specs.observe(result('t1'))
    expect(buffers.current?.kind).toBe('spec')
    await registry.run('start-fresh-session-from-spec', {
      source: 'key',
      chord: 'C-c C-c',
      bufferType: 'spec',
    })
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit).toHaveBeenCalledWith(freshSessionPrompt('/work/SPEC.md', SPEC))
    expect(agent.sessionId).toBeNull()
    expect(buffers.current?.kind).toBe('prompt')
    expect(notices).toEqual(['New task: the next prompt starts a fresh session.'])
  })
})
