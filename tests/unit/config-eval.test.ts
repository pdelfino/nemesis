import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BufferRegistry } from '../../src/main/buffers'
import type { Keymap } from '../../src/main/commands/keymap'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import { ConfigEval } from '../../src/main/config/eval'
import {
  Journal,
  journalPath,
  orgTimestamp,
  parseJournal,
  renderJournal,
} from '../../src/main/config/journal'
import { CONFIG_FILE, ConfigLoader, type ConfigTarget } from '../../src/main/config/loader'
import { Repl } from '../../src/main/repl'
import { defaultSettings } from '../../src/main/settings'

// Eval in the config scope and its journal (#72), through the real stripper
// and the real node:vm: a form defines a command that runs at once, the
// journal gets one entry, promote moves it into init.ts, and a reload keeps
// the command because the file now defines it.

interface Harness {
  readonly dir: string
  readonly path: string
  readonly loader: ConfigLoader
  readonly target: ConfigTarget
  readonly registry: CommandRegistry
  readonly journal: Journal
  readonly evaluator: ConfigEval
  readonly notices: string[]
  keymap(): Keymap | null
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-eval-'))
  const path = join(dir, CONFIG_FILE)
  const registry = new CommandRegistry()
  registry.register(defineCommand({ name: 'search-buffer', doc: 'Cockpit.', run: () => {} }))
  let keymap: Keymap | null = null
  const notices: string[] = []
  const loader = new ConfigLoader({
    path,
    base: () => defaultSettings('/documents'),
    buffers: () => [],
    run: (name) => registry.run(name, { source: 'config' }),
  })
  loader.on((event) => notices.push(event.text))
  const target: ConfigTarget = {
    registry,
    setUserKeymap: (next) => {
      keymap = next
    },
    applySettings: () => {},
    rebuilt: () => {},
  }
  const journal = new Journal({
    path: journalPath(path),
    configFile: path,
    now: () => new Date(2026, 9, 18, 22, 16),
  })
  const evaluator = new ConfigEval({
    loader,
    target,
    journal,
    buffers: () => [],
    run: (name) => registry.run(name, { source: 'config' }),
  })
  return {
    dir,
    path,
    loader,
    target,
    registry,
    journal,
    evaluator,
    notices,
    keymap: () => keymap,
  }
}

const DEFINE =
  "nemesis.defineCommand({ name: 'say-hi', doc: 'Says hi.', run(): void { nemesis.notice('hi from eval') } })"

describe('eval in the config scope', () => {
  it('prints a value and keeps a const for the next form', async () => {
    const h = harness()
    expect(await h.evaluator.evaluate('const n: number = 40')).toMatchObject({
      ok: true,
      text: 'undefined',
      defined: null,
    })
    expect(await h.evaluator.evaluate('n + 2')).toMatchObject({ ok: true, text: '42' })
    expect(await h.evaluator.evaluate("'two words'")).toMatchObject({ text: '"two words"' })
    expect(h.journal.count).toBe(0)
  })

  it('reports an error without applying anything', async () => {
    const h = harness()
    const outcome = await h.evaluator.evaluate("require('node:fs')")
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toMatch(/^ReferenceError: require is not defined/)
    const settings = await h.evaluator.evaluate(`${DEFINE}; nemesis.settings.set('theme', 'dark')`)
    expect(settings.ok).toBe(false)
    expect(settings.text).toMatch(/settings\.set is not applied at eval/)
    expect(h.registry.has('say-hi')).toBe(false)
    expect(h.journal.count).toBe(0)
  })

  it('refuses a cockpit command name and a binding to an unknown command', async () => {
    const h = harness()
    const taken = await h.evaluator.evaluate(
      "nemesis.defineCommand({ name: 'search-buffer', doc: 'Mine.', run() {} })",
    )
    expect(taken.text).toMatch(/is the cockpit's/)
    const unknown = await h.evaluator.evaluate("nemesis.bindKey('C-c z', 'no-such-command')")
    expect(unknown.text).toMatch(/unknown command "no-such-command"/)
    expect(h.keymap()).toBeNull()
  })

  it('defines a command and a binding at once, and journals the form', async () => {
    const h = harness()
    const outcome = await h.evaluator.evaluate(`${DEFINE}; nemesis.bindKey('C-c h', 'say-hi')`)
    expect(outcome).toMatchObject({ ok: true, defined: 'command say-hi, binding C-c h' })
    expect(outcome.journal).toBe(
      `Journaled command say-hi, binding C-c h as entry 1 of ${journalPath(h.path)}: 1 unpromoted.`,
    )
    await h.registry.run('say-hi', { source: 'test' })
    expect(h.notices).toContain('hi from eval')
    expect(h.keymap()?.commandFor('C-c h')).toBe('say-hi')
    expect(h.journal.list()).toEqual([
      {
        id: '1',
        at: '[2026-10-18 Sun 22:16]',
        summary: 'command say-hi, binding C-c h',
        form: `${DEFINE}; nemesis.bindKey('C-c h', 'say-hi')`,
      },
    ])
  })

  it('redefines a command made at eval, journaling each definition', async () => {
    const h = harness()
    await h.evaluator.evaluate(DEFINE)
    await h.evaluator.evaluate(
      "nemesis.defineCommand({ name: 'say-hi', doc: 'Says hi again.', run() { nemesis.notice('hi again') } })",
    )
    expect(h.registry.get('say-hi')?.doc).toBe('Says hi again.')
    expect(h.journal.count).toBe(2)
  })

  it('promote moves the entry into init.ts, and a reload keeps the command', async () => {
    const h = harness()
    writeFileSync(h.path, "nemesis.notice('init')")
    await h.evaluator.evaluate(DEFINE)
    h.journal.promote('1')
    expect(h.journal.count).toBe(0)
    const file = readFileSync(h.path, 'utf8')
    expect(file).toBe(
      `nemesis.notice('init')\n\n// Promoted from the eval journal, [2026-10-18 Sun 22:16]: command say-hi\n${DEFINE}\n`,
    )
    const reloaded = h.loader.reload(h.target)
    expect(reloaded.ok).toBe(true)
    expect(h.loader.status).toMatchObject({ state: 'loaded', counts: { commands: 1 } })
    h.notices.length = 0
    await h.registry.run('say-hi', { source: 'test' })
    expect(h.notices).toEqual(['hi from eval'])
  })

  it('a reload keeps an unpromoted definition the file does not make', async () => {
    const h = harness()
    await h.evaluator.evaluate(`${DEFINE}; nemesis.bindKey('C-c h', 'say-hi')`)
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.registry.has('say-hi')).toBe(true)
    expect(h.keymap()?.commandFor('C-c h')).toBe('say-hi')
  })

  it('discard deletes the entry and leaves init.ts alone', async () => {
    const h = harness()
    await h.evaluator.evaluate(DEFINE)
    h.journal.discard('1')
    expect(h.journal.count).toBe(0)
    expect(existsSync(h.path)).toBe(false)
    expect(() => h.journal.discard('1')).toThrow(/no entry 1/)
  })
})

describe('the journal file', () => {
  it('is Org, and a form with a heading-like line survives the round trip', () => {
    const entries = [
      { at: '[2026-10-18 Sun 22:16]', summary: 'command a', form: 'one()\n* not a heading\n#+x' },
      {
        at: '[2026-10-18 Sun 22:17]',
        summary: 'binding C-c a',
        form: "nemesis.bindKey('C-c a', 'a')",
      },
    ]
    const text = renderJournal(entries)
    expect(text).toContain('#+TITLE: Nemesis eval journal')
    expect(text).toContain(
      '* [2026-10-18 Sun 22:16] command a\n#+begin_src typescript\none()\n,* not a heading\n,#+x\n#+end_src',
    )
    expect(parseJournal(text)).toEqual(
      entries.map((entry, index) => ({ id: String(index + 1), ...entry })),
    )
  })

  it('writes an Org inactive timestamp in local time', () => {
    expect(orgTimestamp(new Date(2026, 0, 5, 9, 3))).toBe('[2026-01-05 Mon 09:03]')
  })

  it('tells its listeners the count on every change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nemesis-journal-'))
    const journal = new Journal({
      path: join(dir, 'journal.org'),
      configFile: join(dir, 'init.ts'),
    })
    const counts: number[] = []
    journal.on((count) => counts.push(count))
    journal.append('a()', 'command a')
    journal.append('b()', 'command b')
    journal.discard('1')
    expect(counts).toEqual([1, 2, 1])
    expect(journal.list().map((entry) => entry.summary)).toEqual(['command b'])
  })
})

describe('the *repl* buffer', () => {
  it('opens once, logs each form with its value, and echoes for eval-expression', async () => {
    const buffers = new BufferRegistry()
    const repl = new Repl(buffers, {
      evaluate: (form) =>
        Promise.resolve({ ok: true, text: String(form.length), defined: null, journal: null }),
    })
    const shown: string[] = []
    const notices: string[] = []
    repl.onShown((content) => shown.push(content.text))
    repl.on((event) => notices.push(event.text))
    const buffer = repl.open()
    expect(buffer).toMatchObject({ kind: 'repl', title: '*repl*', elementId: 'repl' })
    expect(repl.open().id).toBe(buffer.id)
    await repl.evaluate('1 + 1', false)
    await repl.evaluate('abc', true)
    expect(shown.at(-1)).toBe('> 1 + 1\n=> 5\n\n> abc\n=> 3')
    expect(notices).toEqual(['=> 3'])
  })

  it('refuses every form without an evaluator', async () => {
    const repl = new Repl(new BufferRegistry())
    expect(await repl.evaluate('1', false)).toMatchObject({ ok: false })
  })
})
