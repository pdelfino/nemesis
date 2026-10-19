import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../src/main/agent/events'
import type { PromptQueue } from '../../src/main/agent/prompt-queue'
import { attachCheckPrompt, screenshotPrompt } from '../../src/main/commands/guide-prompts'
import { confirm, CONFIRM_SOURCES, VERIFY_SOURCE } from '../../src/main/commands/confirm'
import { createCockpitRegistry, resolveCockpitDeps } from '../../src/main/commands/keyscheme'
import { Prompter } from '../../src/main/commands/prompter'
import { CommandError } from '../../src/main/commands/registry'
import { IssueAttachment } from '../../src/main/issues'
import { Screenshots } from '../../src/main/screenshots'
import { Verifier, verifyQuestion } from '../../src/main/verify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The verify practice as commands (#81): the key, the attached issue, the
// criterion for the prompt and the window screenshot, over the palette. The
// issue's command is confirmed through the same prompter before it runs (#98).

function harness() {
  const prompter = new Prompter()
  for (const source of CONFIRM_SOURCES) prompter.addSource(source)
  const events: AgentEvent[] = []
  const issues = new IssueAttachment({
    cwd: '/work',
    fetch: (number) =>
      Promise.resolve({
        number,
        title: 'Verify',
        body: '## Verify\n- `make check` is green.\n',
      }),
  })
  const runs: string[] = []
  const verifier = new Verifier({
    cwd: '/work',
    settingsCommand: 'npm test',
    issueBody: () => issues.current?.body ?? null,
    confirm: (command) => confirm(prompter, VERIFY_SOURCE, verifyQuestion(command)),
    run: (command) => {
      runs.push(command)
      return Promise.resolve({ exitCode: 0, signal: null, output: 'ok\n' })
    },
    now: () => 0,
  })
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-shots-'))
  const screenshots = new Screenshots({
    dir,
    now: () => new Date(Date.UTC(2026, 9, 17, 16, 30, 45)),
    capturer: {
      list: () => Promise.resolve([{ id: 'window:1', name: 'App under test' }]),
      capture: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    },
  })
  for (const source of [issues, verifier, screenshots]) source.on((event) => events.push(event))
  const deps = resolveCockpitDeps({ prompter, issues, verifier, screenshots })
  const inserted: string[] = []
  ;(deps.prompts as PromptQueue).onInsert((insert) => inserted.push(insert.text))
  const registry = createCockpitRegistry(deps)
  return { deps, prompter, registry, events, runs, inserted, dir }
}

describe('the verify commands', () => {
  it('runs the check of the settings, then of the issue once one is attached and confirmed, as evidence', async () => {
    const { deps, prompter, registry, events, runs } = harness()
    const idle = (): Promise<void> => vi.waitFor(() => expect(deps.verifier.running).toBeNull())
    await registry.run('verify', { source: 'test' })
    await vi.waitFor(() =>
      expect(events.map((event) => event.type)).toEqual(['notice', 'evidence']),
    )
    expect(runs).toEqual(['npm test'])
    expect(events[1]).toMatchObject({ type: 'evidence', command: 'npm test', source: 'settings' })

    await registry.run('attach-issue', { source: 'test' })
    const read = prompter.pending
    expect(read).toMatchObject({ prompt: 'Attach issue:', freeText: true, candidates: [] })
    if (read === null) throw new Error('No read')
    await prompter.answer({ id: read.id, choice: null, text: '#81' })
    expect(events.at(-1)).toEqual({
      type: 'notice',
      text: 'Attached issue #81: Verify. C-c C-v runs its check: make check.',
    })
    // The issue's command is remote text: the key asks first, "Do not run"
    // first among the candidates, and a cancel is a no (#98).
    await registry.run('verify', { source: 'test' })
    const question = prompter.pending
    expect(question).toMatchObject({
      source: 'verify',
      prompt: "Run the attached issue's check in a shell? make check",
    })
    expect(question?.candidates.map((candidate) => candidate.label)).toEqual([
      'Do not run',
      'Run it with your permissions',
    ])
    await prompter.answer({ id: question?.id ?? '', choice: null })
    await vi.waitFor(() =>
      expect(events.at(-1)).toEqual({ type: 'notice', text: 'Not run: make check' }),
    )
    expect(runs).toEqual(['npm test'])
    await idle()
    // A yes runs it, and the next press on the same issue runs without asking.
    await registry.run('verify', { source: 'test' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    await vi.waitFor(() => expect(runs).toEqual(['npm test', 'make check']))
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ type: 'evidence', source: 'issue' }),
    )
    await idle()
    await registry.run('verify', { source: 'test' })
    expect(prompter.pending).toBeNull()
    await vi.waitFor(() => expect(runs).toEqual(['npm test', 'make check', 'make check']))
    await idle()
    // Attaching again, even the same issue, asks again.
    await registry.run('attach-issue', { source: 'test' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null, text: '#81' })
    await registry.run('verify', { source: 'test' })
    expect(prompter.pending).toMatchObject({ source: 'verify' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null })
    expect(runs).toHaveLength(3)
    await idle()
    // So does a new task.
    await registry.run('verify', { source: 'test' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: 'yes' })
    await vi.waitFor(() => expect(runs).toHaveLength(4))
    await idle()
    await registry.run('new-task', { source: 'test' })
    await registry.run('verify', { source: 'test' })
    expect(prompter.pending).toMatchObject({ source: 'verify' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null })
  })

  it('attach-issue answers a refused number or a failed fetch in the help buffer', async () => {
    const { deps, prompter, registry } = harness()
    const shown = vi.fn()
    deps.help.on(shown)
    await registry.run('attach-issue', { source: 'test' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null, text: 'eighty-one' })
    expect(shown.mock.calls[0]?.[0]).toMatchObject({
      text: 'Could not attach the issue: Not an issue number: eighty-one',
    })
    expect(deps.issues.current).toBeNull()
  })

  it('refuses a second check while one runs, as the key reports it', async () => {
    let release: () => void = () => undefined
    const prompter = new Prompter()
    const verifier = new Verifier({
      cwd: '/work',
      settingsCommand: 'sleep',
      issueBody: () => null,
      confirm: () => Promise.resolve(true),
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ exitCode: 0, signal: null, output: '' })
        }),
    })
    const registry = createCockpitRegistry(resolveCockpitDeps({ prompter, verifier }))
    await registry.run('verify', { source: 'test' })
    await expect(registry.run('verify', { source: 'test' })).rejects.toThrow(CommandError)
    await expect(registry.run('verify', { source: 'test' })).rejects.toThrow(
      'A check is already running: sleep',
    )
    release()
    await vi.waitFor(() => expect(verifier.running).toBeNull())
  })

  it('attach-check reads the cases and the check, the verify command as the candidate, and adds the criterion to the prompt', async () => {
    const { deps, prompter, registry, inserted } = harness()
    deps.buffers.switchTo(deps.buffers.list()[0]?.id ?? '')
    expect(deps.buffers.current?.kind).toBe('transcript')
    await registry.run('attach-check', { source: 'test' })
    const cases = prompter.pending
    expect(cases).toMatchObject({ prompt: 'Example cases (input is output):', freeText: true })
    if (cases === null) throw new Error('No read')
    await prompter.answer({ id: cases.id, choice: null, text: 'a@b.com is true, bad is false' })
    const check = prompter.pending
    expect(check).toMatchObject({
      prompt: 'Run after implementing:',
      freeText: true,
      candidates: [
        {
          id: 'npm test',
          label: 'npm test',
          doc: 'The check C-c C-v runs, from the settings. Type another to use it instead.',
        },
      ],
    })
    if (check === null) throw new Error('No read')
    await prompter.answer({ id: check.id, choice: 'npm test' })
    expect(inserted).toEqual([
      'Example cases: a@b.com is true, bad is false. Run `npm test` after implementing, show its output, and iterate until it passes.',
    ])
    expect(deps.buffers.current?.kind).toBe('prompt')

    // Another check typed is taken as is.
    await registry.run('attach-check', { source: 'test' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null, text: ' 2+2 is 4 ' })
    await prompter.answer({ id: prompter.pending?.id ?? '', choice: null, text: 'make check' })
    expect(inserted[1]).toBe(attachCheckPrompt('2+2 is 4', 'make check'))
  })

  it('screenshot-window lists the windows, captures the one picked and puts its path in the prompt', async () => {
    const { prompter, registry, inserted, events, dir } = harness()
    try {
      await registry.run('screenshot-window', { source: 'test' })
      await vi.waitFor(() => expect(prompter.pending).not.toBeNull())
      const read = prompter.pending
      expect(read).toMatchObject({
        prompt: 'Screenshot window:',
        candidates: [{ id: 'window:1', label: 'App under test', doc: 'Window window:1' }],
      })
      expect(read?.freeText).toBeUndefined()
      if (read === null) throw new Error('No read')
      await prompter.answer({ id: read.id, choice: 'window:1' })
      const path = join(dir, '2026-10-17T16-30-45-app-under-test.png')
      expect(inserted).toEqual([screenshotPrompt('App under test', path)])
      expect(inserted[0]).toContain(`at ${path}: read it as an image`)
      expect(events.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining(path) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('screenshot-window answers in the help buffer when the system lists no window', async () => {
    const prompter = new Prompter()
    const screenshots = new Screenshots({
      dir: '/nowhere',
      capturer: { list: () => Promise.resolve([]), capture: () => Promise.resolve(null) },
    })
    const deps = resolveCockpitDeps({ prompter, screenshots })
    const registry = createCockpitRegistry(deps)
    const shown = vi.fn()
    deps.help.on(shown)
    await registry.run('screenshot-window', { source: 'test' })
    await vi.waitFor(() => expect(shown).toHaveBeenCalledTimes(1))
    expect(shown.mock.calls[0]?.[0]).toMatchObject({
      text: 'No window to capture: the system listed none.',
    })
    expect(prompter.pending).toBeNull()
  })
})
