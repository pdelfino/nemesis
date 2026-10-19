import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { assertBindingsAreRegistered } from '../../src/main/commands/dispatcher'
import type { Keymap } from '../../src/main/commands/keymap'
import { defineCommand, CommandRegistry } from '../../src/main/commands/registry'
import {
  CONFIG_FILE,
  ConfigLoader,
  configPath,
  renderProblem,
  type ConfigTarget,
} from '../../src/main/config/loader'
import { defaultSettings, type Settings } from '../../src/main/settings'

// The config file (#71, ADR 0006) through the real stripper and the real
// node:vm: a temp init.ts adds a command and a binding; an error reports its
// line and column and keeps the previous config; a runtime require is not in
// scope.

interface Harness {
  readonly path: string
  readonly loader: ConfigLoader
  readonly target: ConfigTarget
  readonly registry: CommandRegistry
  readonly notices: string[]
  readonly applied: Settings[]
  keymap(): Keymap | null
  rebuilds(): number
  write(source: string): void
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-config-'))
  const path = join(dir, CONFIG_FILE)
  const registry = new CommandRegistry()
  registry.register(defineCommand({ name: 'search-buffer', doc: 'Cockpit.', run: () => {} }))
  let keymap: Keymap | null = null
  let rebuilds = 0
  const applied: Settings[] = []
  const notices: string[] = []
  const loader = new ConfigLoader({
    path,
    base: () => defaultSettings('/documents'),
    buffers: () => [{ id: 'b1', kind: 'prompt', title: 'Prompt', elementId: null }],
    run: (name) => registry.run(name, { source: 'config' }),
  })
  loader.on((event) => notices.push(event.text))
  const target: ConfigTarget = {
    registry,
    setUserKeymap: (next) => {
      keymap = next
    },
    applySettings: (settings) => applied.push(settings),
    rebuilt: () => {
      rebuilds += 1
    },
  }
  return {
    path,
    loader,
    target,
    registry,
    notices,
    applied,
    keymap: () => keymap,
    rebuilds: () => rebuilds,
    write: (source) => writeFileSync(path, source, 'utf8'),
  }
}

const GOOD = `import type { Settings } from 'nemesis'

interface Greeting {
  readonly text: string
}
const greeting: Greeting = { text: 'hello from init' }

nemesis.settings.set('theme', 'dark' satisfies Settings['theme'])
nemesis.defineCommand({
  name: 'say-hello',
  doc: 'Says hello.',
  run(): void {
    nemesis.notice(greeting.text + ', ' + nemesis.buffers.list().length + ' buffer')
  },
})
nemesis.defineKeymap('user', { 'C-c h': 'say-hello', 'C-s': 'search-buffer' })
nemesis.bindKey('C-c j', 'say-hello')
`

describe('the config loader', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('adds a command and its bindings, and overrides a setting in memory', async () => {
    h.write(GOOD)
    const result = h.loader.reload(h.target)
    expect(result).toEqual({
      ok: true,
      line: `Config reloaded from ${h.path}: 1 command, 3 bindings, 1 setting overridden.`,
    })
    expect(h.registry.has('say-hello')).toBe(true)
    const keymap = h.keymap()
    expect(keymap?.name).toBe('user')
    expect(keymap?.commandFor('C-c h')).toBe('say-hello')
    expect(keymap?.commandFor('C-c j')).toBe('say-hello')
    expect(keymap?.commandFor('C-s')).toBe('search-buffer')
    expect(() => assertBindingsAreRegistered(h.registry, [keymap as Keymap])).not.toThrow()
    expect(h.applied.at(-1)?.theme).toBe('dark')
    expect(h.loader.settings.theme).toBe('dark')
    expect(h.rebuilds()).toBe(1)
    expect(h.loader.status).toMatchObject({
      state: 'loaded',
      path: h.path,
      counts: { commands: 1, bindings: 3, settings: 1 },
    })
    // The body runs later, with the API still live for notices and reads.
    await h.registry.run('say-hello', { source: 'test' })
    expect(h.notices).toEqual(['hello from init, 1 buffer'])
    // settings.json is never written: the override is in memory only.
    expect(() => readFileSync(join(h.path, '..', 'settings.json'))).toThrow()
  })

  it('reports a syntax error with its line and column and keeps the previous config', () => {
    h.write(GOOD)
    expect(h.loader.reload(h.target).ok).toBe(true)
    h.write("nemesis.defineCommand({\n  name: 'other',\n  doc: 'x',\n  run() {} ]\n")
    const result = h.loader.reload(h.target)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.line).toBe(4)
    expect(result.problem.column).toBeGreaterThan(0)
    expect(result.problem.message).toMatch(/SyntaxError/)
    expect(renderProblem(result.problem)).toContain(`${h.path}, line 4, column`)
    // Nothing committed: the first load's command, keys and settings stand.
    expect(h.registry.has('say-hello')).toBe(true)
    expect(h.registry.has('other')).toBe(false)
    expect(h.keymap()?.commandFor('C-c h')).toBe('say-hello')
    expect(h.loader.settings.theme).toBe('dark')
    expect(h.rebuilds()).toBe(1)
    expect(h.loader.status).toMatchObject({ state: 'error', problem: { line: 4 } })
  })

  it('reports a runtime error on its own line and column, half a file applying nothing', () => {
    h.write(
      "nemesis.defineCommand({ name: 'early', doc: 'Defined first.', run() {} })\nconst x: number = 1\n    missing.call(x)\n",
    )
    const result = h.loader.reload(h.target)
    expect(result).toMatchObject({
      ok: false,
      problem: { line: 3, column: 5, message: 'ReferenceError: missing is not defined' },
    })
    expect(h.registry.has('early')).toBe(false)
    expect(h.keymap()).toBeNull()
  })

  it('has no runtime require, process or import in scope, and says so by name', () => {
    h.write("const fs = require('node:fs')\n")
    const required = h.loader.reload(h.target)
    expect(required).toMatchObject({ ok: false, problem: { line: 1, column: 12 } })
    if (!required.ok) {
      expect(required.problem.message).toContain('require is not defined')
      expect(required.problem.message).toContain('only `import type` is erased')
    }
    h.write("nemesis.notice(typeof process + ' ' + typeof require + ' ' + typeof module)\n")
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.notices).toEqual(['undefined undefined undefined'])
    h.write("import { readFileSync } from 'node:fs'\n")
    const imported = h.loader.reload(h.target)
    expect(imported).toMatchObject({ ok: false, problem: { line: 1 } })
    if (!imported.ok) expect(imported.problem.message).toContain('runtime require or import')
  })

  it('rejects non-erasable syntax with its line', () => {
    h.write('const a = 1\nenum Color { Red }\n')
    expect(h.loader.reload(h.target)).toMatchObject({ ok: false, problem: { line: 2 } })
  })

  it('rejects a binding to an unknown command on the line of the binding, committing nothing', () => {
    h.write(
      "nemesis.defineCommand({ name: 'ok-one', doc: 'Fine.', run() {} })\nnemesis.bindKey('C-c k', 'no-such-command')\n",
    )
    const result = h.loader.reload(h.target)
    expect(result).toMatchObject({ ok: false, problem: { line: 2, column: 9 } })
    if (!result.ok) expect(result.problem.message).toContain('no-such-command')
    expect(h.registry.has('ok-one')).toBe(false)
  })

  it('rejects an unknown setting, a bad value, a cockpit name and a bad chord by name', () => {
    const cases: [string, RegExp][] = [
      ["nemesis.settings.set('colour', 'dark')", /Unknown setting "colour"/],
      ["nemesis.settings.set('theme', 'purple')", /"theme" is not one of/],
      [
        "nemesis.defineCommand({ name: 'search-buffer', doc: 'Mine.', run() {} })",
        /is the cockpit's/,
      ],
      ["nemesis.defineCommand({ name: 'Not Kebab', doc: 'Bad.', run() {} })", /not kebab-case/],
      ["nemesis.bindKey('C-<nope>', 'search-buffer')", /Unknown key/],
      ["nemesis.defineKeymap('global', {})", /"user" keymap only/],
    ]
    for (const [source, message] of cases) {
      h.write(`// line one\n${source}\n`)
      const result = h.loader.reload(h.target)
      expect(result, source).toMatchObject({ ok: false, problem: { line: 2 } })
      if (!result.ok) expect(result.problem.message).toMatch(message)
    }
  })

  it('drops the previous load on a reload: commands and bindings go, the cockpit stays', () => {
    h.write(GOOD)
    h.loader.reload(h.target)
    h.write("nemesis.defineCommand({ name: 'say-bye', doc: 'Bye.', run() {} })\n")
    expect(h.loader.reload(h.target)).toMatchObject({ ok: true })
    expect(h.registry.has('say-hello')).toBe(false)
    expect(h.registry.has('say-bye')).toBe(true)
    expect(h.registry.has('search-buffer')).toBe(true)
    expect(h.keymap()).toBeNull()
    expect(h.loader.settings.theme).toBe('system')
    // The same name again on a later load is no duplicate.
    h.write("nemesis.defineCommand({ name: 'say-bye', doc: 'Bye again.', run() {} })\n")
    expect(h.loader.reload(h.target)).toMatchObject({ ok: true })
    expect(h.registry.get('say-bye')?.doc).toBe('Bye again.')
  })

  it('names a setting read once at start as needing a restart', () => {
    h.write('// nothing yet\n')
    h.loader.reload(h.target)
    h.write("nemesis.settings.set('sessionsDir', '/elsewhere')\n")
    const result = h.loader.reload(h.target)
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.line).toContain('sessionsDir needs a restart.')
  })

  it('ends a loop at the top level with an error instead of hanging', () => {
    const loader = new ConfigLoader({
      path: h.path,
      base: () => defaultSettings('/documents'),
      buffers: () => [],
      run: () => Promise.resolve(),
      timeoutMs: 50,
    })
    h.write('while (true) {}\n')
    expect(loader.reload(h.target)).toMatchObject({ ok: false })
  })

  it('is silent about an absent file and refuses a definition after the load', async () => {
    expect(h.loader.reload(h.target)).toEqual({
      ok: true,
      line: `No config at ${h.path}: the defaults are live.`,
    })
    expect(h.loader.status).toEqual({ state: 'absent', path: h.path })
    h.write(
      "nemesis.defineCommand({ name: 'late', doc: 'Defines later.', run() { nemesis.defineCommand({ name: 'later', doc: 'x', run() {} }) } })\n",
    )
    h.loader.reload(h.target)
    await expect(h.registry.run('late', { source: 'test' })).rejects.toThrow(/reload-config/)
  })
})

describe('the worked example of docs/config.org', () => {
  it('loads as written', () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'config.org'), 'utf8')
    const example = /#\+begin_src typescript\n([\s\S]*?)#\+end_src/.exec(doc)?.[1]
    expect(example).toBeDefined()
    const h = harness()
    h.registry.register(
      defineCommand({ name: 'search-transcripts', doc: 'Cockpit.', run: () => {} }),
    )
    h.write(example ?? '')
    expect(h.loader.reload(h.target)).toEqual({
      ok: true,
      line: `Config reloaded from ${h.path}: 1 command, 3 bindings, 1 setting overridden.`,
    })
  })
})

describe('the config path', () => {
  it('is the user config folder, a test folder under test only, and none under --no-config', () => {
    expect(configPath({ home: '/home/u', env: {}, argv: [] })).toBe(
      '/home/u/.config/nemesis/init.ts',
    )
    expect(configPath({ home: '/home/u', env: { NEMESIS_CONFIG_DIR: '/tmp/c' }, argv: [] })).toBe(
      '/home/u/.config/nemesis/init.ts',
    )
    expect(
      configPath({
        home: '/home/u',
        env: { NODE_ENV: 'test', NEMESIS_CONFIG_DIR: '/tmp/c' },
        argv: [],
      }),
    ).toBe('/tmp/c/init.ts')
    expect(configPath({ home: '/home/u', env: { NODE_ENV: 'test' }, argv: [] })).toBeNull()
    expect(configPath({ home: '/home/u', env: {}, argv: ['electron', '--no-config'] })).toBeNull()
  })
})

describe('the config module boundary', () => {
  it('has no runtime import from the agent, security or preload code', () => {
    for (const file of ['loader.ts', 'api.ts']) {
      const source = readFileSync(join(process.cwd(), 'src', 'main', 'config', file), 'utf8')
      const runtime = source
        .split('\n')
        .filter((line) => /^import /.test(line) && !/^import type /.test(line))
      expect(runtime.join('\n'), file).not.toMatch(/agent|security|preload|electron/)
    }
  })
})
