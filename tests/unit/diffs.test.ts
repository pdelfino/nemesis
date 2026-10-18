import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentToolUseEvent } from '../../src/main/agent/events'
import { createCockpitBuffers, type BufferRegistry } from '../../src/main/buffers'
import { createCockpitRegistry, resolveCockpitDeps } from '../../src/main/commands/keyscheme'
import { CommandError } from '../../src/main/commands/registry'
import { describeDiff, DiffBuffers, diffTitle, displayPath, parseDiff } from '../../src/main/diffs'

// The diffs of the session (#68): every Edit and Write call, listed and
// opened in a diff buffer, the file handed to the system after a yes.

function toolUse(name: string, input: Record<string, unknown>, id = 't1'): AgentToolUseEvent {
  return { type: 'tool-use', toolUseId: id, name, input }
}

const EDIT = toolUse('Edit', {
  file_path: '/work/notes.txt',
  old_string: 'alpha\nbeta\ngamma\n',
  new_string: 'alpha\nbeta changed\ngamma\n',
})
const WRITE = toolUse('Write', { file_path: '/work/new.txt', content: 'one\ntwo' }, 't2')

function started(sessionId: string): AgentEvent {
  return { type: 'started', sessionId, model: 'm', permissionMode: 'default', cwd: '/', tools: [] }
}

interface Harness {
  readonly buffers: BufferRegistry
  readonly diffs: DiffBuffers
  readonly confirm: ReturnType<typeof vi.fn<(question: string) => Promise<boolean>>>
  readonly open: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
  readonly notices: string[]
}

function harness(answer = true, failure = ''): Harness {
  const buffers = createCockpitBuffers()
  const confirm = vi.fn<(question: string) => Promise<boolean>>(() => Promise.resolve(answer))
  const open = vi.fn<(path: string) => Promise<string>>(() => Promise.resolve(failure))
  const diffs = new DiffBuffers(buffers, { confirm, open })
  const notices: string[] = []
  diffs.on((event) => notices.push(event.text))
  return { buffers, diffs, confirm, open, notices }
}

describe('a tool call as a diff', () => {
  it('reads an Edit and a Write off their arguments, and nothing else', () => {
    expect(parseDiff(EDIT, 1)).toEqual({
      id: 't1',
      index: 1,
      tool: 'Edit',
      filePath: '/work/notes.txt',
      oldText: 'alpha\nbeta\ngamma\n',
      newText: 'alpha\nbeta changed\ngamma\n',
    })
    expect(parseDiff(WRITE, 2)).toMatchObject({ tool: 'Write', oldText: '', newText: 'one\ntwo' })
    expect(parseDiff(toolUse('Read', { file_path: '/work/notes.txt' }), 1)).toBeNull()
    expect(
      parseDiff(toolUse('Edit', { file_path: '/work/notes.txt', old_string: 'a' }), 1),
    ).toBeNull()
    expect(
      parseDiff(toolUse('Edit', { file_path: 7, old_string: 'a', new_string: 'b' }), 1),
    ).toBeNull()
    expect(parseDiff(toolUse('Write', { file_path: '/w', content: ['no'] }), 1)).toBeNull()
  })

  it('is titled by its number and file name, and described by its size', () => {
    const edit = parseDiff(EDIT, 1)
    const write = parseDiff(WRITE, 2)
    if (edit === null || write === null) throw new Error('parseDiff refused the fixtures')
    expect(diffTitle(edit)).toBe('Diff 1: notes.txt')
    expect(describeDiff(edit)).toBe('Edit: 3 lines replaced by 3')
    expect(describeDiff(write)).toBe('Write: the whole file, 2 lines')
    expect(describeDiff({ ...edit, oldText: 'x', newText: '' })).toBe('Edit: 1 line replaced by 0')
  })

  it('shows a path printable and no longer than a line', () => {
    expect(displayPath('/work/a​b\u0007c.txt')).toBe('/work/abc.txt')
    expect(displayPath(`/${'x'.repeat(200)}`)).toHaveLength(123)
  })
})

describe('the diffs of a session', () => {
  it('collects the Edit and Write calls in order and starts over with a new session', () => {
    const { diffs } = harness()
    diffs.observe(started('s1'))
    diffs.observe(EDIT)
    diffs.observe(toolUse('Bash', { command: 'ls' }, 't9'))
    diffs.observe(WRITE)
    expect(diffs.list().map((diff) => [diff.index, diff.tool, diff.id])).toEqual([
      [1, 'Edit', 't1'],
      [2, 'Write', 't2'],
    ])
    // The same session starting again (a resume) keeps the list.
    diffs.observe(started('s1'))
    expect(diffs.list()).toHaveLength(2)
    diffs.observe(started('s2'))
    expect(diffs.list()).toEqual([])
  })

  it('opens a diff in a buffer with the content pushed first, and reuses the buffer', () => {
    const { buffers, diffs } = harness()
    const pushed: string[] = []
    diffs.onShown((content) => {
      pushed.push(`${content.bufferId} ${content.diff.id} ${buffers.current?.id ?? ''}`)
    })
    diffs.observe(EDIT)
    diffs.observe(WRITE)
    const first = diffs.show('t1')
    expect(first).toMatchObject({ kind: 'diff', title: 'Diff 1: notes.txt', elementId: 'diff' })
    expect(buffers.current?.id).toBe(first.id)
    expect(diffs.current?.id).toBe('t1')
    // The push carries the buffer id and happens before the point moves.
    expect(pushed).toEqual([`${first.id} t1 b2`])

    const second = diffs.show('t2')
    expect(second.id).not.toBe(first.id)
    expect(diffs.current?.id).toBe('t2')
    expect(diffs.show('t1').id).toBe(first.id)
    expect(buffers.list().filter((buffer) => buffer.kind === 'diff')).toHaveLength(2)

    // A killed buffer is forgotten: the point goes to the next buffer, the
    // other diff, and the next show of the first opens a new one.
    buffers.kill(first.id)
    expect(diffs.current?.id).toBe('t2')
    expect(diffs.show('t1').id).not.toBe(first.id)
    expect(() => diffs.show('nope')).toThrow(CommandError)
  })

  it('has no current diff while the point is elsewhere', () => {
    const { buffers, diffs } = harness()
    diffs.observe(EDIT)
    diffs.show('t1')
    buffers.switchToNext()
    expect(diffs.current).toBeNull()
  })
})

describe('C-c C-o on a diff buffer', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-diffs-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function editOf(filePath: string): AgentToolUseEvent {
    return toolUse('Edit', { file_path: filePath, old_string: 'a', new_string: 'b' })
  }

  it('hands the file to the system after a yes, and says so', async () => {
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'b')
    const { diffs, confirm, open, notices } = harness(true)
    diffs.observe(editOf(file))
    diffs.show('t1')
    expect(await diffs.openCurrent()).toBe(true)
    expect(confirm).toHaveBeenCalledWith(`Open ${file} with the default application?`)
    expect(open).toHaveBeenCalledWith(file)
    expect(notices).toEqual([`Opened ${file} with the default application`])
  })

  it('launches nothing without a yes', async () => {
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'b')
    const { diffs, open, notices } = harness(false)
    diffs.observe(editOf(file))
    diffs.show('t1')
    expect(await diffs.openCurrent()).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(notices).toEqual([`Not opened: ${file}; nothing was launched (SECURITY.org, promise 2)`])
  })

  it('refuses a path that is not a regular file on disk, before asking', async () => {
    const { diffs, confirm, open, notices } = harness(true)
    diffs.observe(editOf(join(dir, 'missing.txt')))
    diffs.observe(toolUse('Edit', { file_path: dir, old_string: 'a', new_string: 'b' }, 't2'))
    diffs.observe(
      toolUse('Edit', { file_path: 'notes.txt', old_string: 'a', new_string: 'b' }, 't3'),
    )
    for (const id of ['t1', 't2', 't3']) {
      diffs.show(id)
      expect(await diffs.openCurrent()).toBe(false)
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(notices).toEqual([
      `Not opened: ${join(dir, 'missing.txt')} is not a file on disk`,
      `Not opened: ${dir} is not a file on disk`,
      'Not opened: notes.txt is not a file on disk',
    ])
  })

  it("reports the system's refusal, and refuses when the current buffer is not a diff", async () => {
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'b')
    const { buffers, diffs, notices } = harness(true, 'No application')
    diffs.observe(editOf(file))
    diffs.show('t1')
    expect(await diffs.openCurrent()).toBe(false)
    expect(notices).toEqual([`The system could not open ${file}: No application`])
    buffers.switchToNext()
    await expect(diffs.openCurrent()).rejects.toThrow(/not a diff/)
  })
})

describe('the commands and the palette source (#68)', () => {
  it('list-diffs answers in the help buffer when there is nothing to list', async () => {
    const deps = resolveCockpitDeps()
    const shown: string[] = []
    deps.help.on((content) => shown.push(content.text))
    const registry = createCockpitRegistry(deps)
    await registry.run('list-diffs', { source: 'palette' })
    expect(shown).toEqual([
      'No diffs yet: the agent has made no Edit or Write call in this session.',
    ])
    expect(deps.prompter.pending).toBeNull()
  })

  it('list-diffs reads one of the diffs and opens it; open-diff-file acts on the current one', async () => {
    const deps = resolveCockpitDeps()
    const registry = createCockpitRegistry(deps)
    deps.diffs.observe(EDIT)
    deps.diffs.observe(WRITE)
    await registry.run('list-diffs', { source: 'palette' })
    const read = deps.prompter.pending
    expect(read).toMatchObject({ source: 'diffs', prompt: 'Show diff:' })
    expect(read?.candidates).toEqual([
      { id: 't1', label: '1. Edit /work/notes.txt', doc: 'Edit: 3 lines replaced by 3' },
      { id: 't2', label: '2. Write /work/new.txt', doc: 'Write: the whole file, 2 lines' },
    ])
    if (read === null) throw new Error('no read')
    await deps.prompter.answer({ id: read.id, choice: 't2' })
    expect(deps.buffers.current).toMatchObject({ kind: 'diff', title: 'Diff 2: new.txt' })
    expect(deps.diffs.current?.id).toBe('t2')
    // The default deps have nobody to ask: the file is not on disk anyway.
    const notices: string[] = []
    deps.diffs.on((event) => notices.push(event.text))
    await registry.run('open-diff-file', { source: 'palette' })
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toBe('Not opened: /work/new.txt is not a file on disk')
  })
})
