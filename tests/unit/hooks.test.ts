import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BufferRegistry } from '../../src/main/buffers'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import { CONFIG_FILE, ConfigLoader, type ConfigTarget } from '../../src/main/config/loader'
import {
  HOOK_POINTS,
  HookError,
  HookRegistry,
  renderHooks,
  type HookEvents,
  type HookHandler,
  type HookPoint,
} from '../../src/main/hooks'
import { defaultSettings } from '../../src/main/settings'

// The hooks of ADR 0005 (#165): one order, oldest first; named handlers,
// duplicates refused; a throw is a notice and the chain goes on; the one
// interceptor stops the command on a veto or a timeout; a point fired from
// its own handler runs nothing; and nothing here reaches the permission path.

const root = join(import.meta.dirname, '../..')

function registry(): { hooks: HookRegistry; notices: string[] } {
  const notices: string[] = []
  return { hooks: new HookRegistry((text) => notices.push(text)), notices }
}

function handler<P extends HookPoint>(
  name: string,
  run: HookHandler<P>['run'] = () => undefined,
): HookHandler<P> {
  return { name, doc: `The ${name} handler.`, run }
}

const BUFFER: HookEvents['buffer-created']['buffer'] = Object.freeze({
  id: 'b1',
  kind: 'prompt',
  title: 'Prompt',
  elementId: null,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the hook registry (ADR 0005)', () => {
  it('runs handlers oldest first, in the order on() was called', async () => {
    const { hooks } = registry()
    const order: string[] = []
    for (const name of ['first', 'second', 'third']) {
      hooks.on(
        'buffer-created',
        handler(name, () => void order.push(name)),
        'config',
      )
    }
    await hooks.fire('buffer-created', { buffer: BUFFER })
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('refuses a second handler of the same name on a point, and a name that is not kebab-case', () => {
    const { hooks } = registry()
    hooks.on('buffer-created', handler('say-hi'), 'config')
    expect(() => hooks.on('buffer-created', handler('say-hi'), 'repl')).toThrow(HookError)
    expect(() => hooks.on('buffer-created', handler('say-hi'), 'config')).toThrow(/already has/)
    // The same name on another point is another handler.
    hooks.on('buffer-killed', handler('say-hi'), 'config')
    expect(() => hooks.on('buffer-killed', handler('Say Hi'), 'config')).toThrow(/kebab-case/)
    expect(() => hooks.on('nope' as HookPoint, handler('x'), 'config')).toThrow(/No hook point/)
  })

  it('skips a throwing or rejecting handler with a notice, runs the next, and keeps it', async () => {
    const { hooks, notices } = registry()
    const ran: string[] = []
    hooks.on(
      'buffer-created',
      handler('breaks', () => {
        throw new Error('boom')
      }),
      'config',
    )
    hooks.on(
      'buffer-created',
      handler('rejects', () => Promise.reject(new Error('later'))),
      'config',
    )
    hooks.on(
      'buffer-created',
      handler('works', () => void ran.push('works')),
      'config',
    )
    expect(await hooks.fire('buffer-created', { buffer: BUFFER })).toBeNull()
    expect(ran).toEqual(['works'])
    expect(notices).toEqual([
      'Hook buffer-created: handler breaks (config) failed: boom',
      'Hook buffer-created: handler rejects (config) failed: later',
    ])
    expect(hooks.list().map((entry) => entry.name)).toEqual(['breaks', 'rejects', 'works'])
  })

  it('stops the interceptor chain at the first veto; a throw there is no change', async () => {
    const { hooks, notices } = registry()
    const ran: string[] = []
    hooks.on(
      'before-command',
      handler('buggy', () => {
        throw new Error('oops')
      }),
      'config',
    )
    hooks.on(
      'before-command',
      handler('guard', (event) => {
        ran.push('guard')
        return event.command === 'kill-buffer' ? { veto: true, reason: 'not now' } : undefined
      }),
      'config',
    )
    hooks.on(
      'before-command',
      handler('after', () => void ran.push('after')),
      'config',
    )
    const context = { source: 'test' } as const
    expect(await hooks.fire('before-command', { command: 'kill-buffer', context })).toEqual({
      veto: true,
      reason: 'not now',
    })
    expect(ran).toEqual(['guard'])
    expect(notices.at(-1)).toBe('Hook before-command: handler guard (config) refused it: not now')
    ran.length = 0
    expect(await hooks.fire('before-command', { command: 'switch-buffer', context })).toBeNull()
    expect(ran).toEqual(['guard', 'after'])
  })

  it('ignores what an observer returns', async () => {
    const { hooks } = registry()
    hooks.on(
      'buffer-created',
      handler('says-no', () => ({ veto: true, reason: 'no' })),
      'config',
    )
    expect(await hooks.fire('buffer-created', { buffer: BUFFER })).toBeNull()
  })

  it('vetoes the command when an interceptor does not answer in time, and aborts its signal', async () => {
    vi.useFakeTimers()
    const { hooks, notices } = registry()
    const signals: AbortSignal[] = []
    hooks.on(
      'before-command',
      handler('asks-forever', (_event, given) => {
        signals.push(given)
        return new Promise(() => {})
      }),
      'config',
    )
    const fired = hooks.fire('before-command', {
      command: 'kill-buffer',
      context: { source: 'test' },
    })
    await vi.advanceTimersByTimeAsync(HOOK_POINTS['before-command'].timeoutMs)
    expect(await fired).toEqual({ veto: true, reason: 'asks-forever did not answer in time' })
    expect(signals[0]?.aborted).toBe(true)
    expect(notices).toEqual([
      'Hook before-command: handler asks-forever (config) did not answer in 30000 ms.',
    ])
  })

  it('moves on from an observer past its timeout, with a notice', async () => {
    vi.useFakeTimers()
    const { hooks, notices } = registry()
    const ran: string[] = []
    hooks.on(
      'turn-ended',
      handler('hangs', () => new Promise(() => {})),
      'config',
    )
    hooks.on(
      'turn-ended',
      handler('next', () => void ran.push('next')),
      'config',
    )
    const fired = hooks.fire('turn-ended', {
      sessionId: 's1',
      isError: false,
      durationMs: 5,
      numTurns: 1,
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await fired).toBeNull()
    expect(ran).toEqual(['next'])
    expect(notices).toEqual(['Hook turn-ended: handler hangs (config) did not answer in 2000 ms.'])
  })

  it('does not re-enter: a fire from inside a handler of the same point runs nothing', async () => {
    const { hooks, notices } = registry()
    let calls = 0
    hooks.on(
      'buffer-created',
      handler('loops', async () => {
        calls += 1
        await Promise.resolve()
        await hooks.fire('buffer-created', { buffer: BUFFER })
      }),
      'config',
    )
    await hooks.fire('buffer-created', { buffer: BUFFER })
    expect(calls).toBe(1)
    expect(notices).toEqual([
      'Hook buffer-created: fired while its handlers were running; skipped.',
    ])
  })

  it('does not take a concurrent fire from unrelated work for re-entry', async () => {
    const { hooks, notices } = registry()
    let calls = 0
    hooks.on(
      'buffer-created',
      handler('slow', async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
      }),
      'config',
    )
    await Promise.all([
      hooks.fire('buffer-created', { buffer: BUFFER }),
      hooks.fire('buffer-created', { buffer: BUFFER }),
    ])
    expect(calls).toBe(2)
    expect(notices).toEqual([])
  })

  it('removes one handler with off, every handler of a source with dropSource, and lists the rest', () => {
    const { hooks } = registry()
    hooks.on('buffer-created', handler('from-config'), 'config')
    hooks.on('before-command', handler('also-config'), 'config')
    hooks.on('buffer-created', handler('from-mode'), 'mode:dark')
    hooks.on('after-command', handler('from-repl'), 'repl')
    expect(hooks.off('after-command', 'from-repl')).toBe(true)
    expect(hooks.off('after-command', 'from-repl')).toBe(false)
    expect(hooks.dropSource('config')).toBe(2)
    expect(hooks.list()).toEqual([
      {
        point: 'buffer-created',
        name: 'from-mode',
        doc: 'The from-mode handler.',
        source: 'mode:dark',
      },
    ])
    expect(renderHooks(hooks.list())).toBe(
      [
        'Hooks',
        '',
        'buffer-created (observer)',
        '  from-mode (mode:dark): The from-mode handler.',
      ].join('\n'),
    )
    expect(renderHooks([])).toContain('No handler is registered.')
  })
})

describe('the fire sites (ADR 0005 table)', () => {
  it('fires before-command, and a veto stops the command and skips after-command', async () => {
    const { hooks } = registry()
    const commands = new CommandRegistry()
    const run = vi.fn()
    commands.register(defineCommand({ name: 'kill-buffer', doc: 'Kills.', run }))
    commands.useHooks(hooks)
    const after = vi.fn()
    hooks.on('after-command', handler('after', after), 'config')
    hooks.on(
      'before-command',
      handler('no', () => ({ veto: true, reason: 'kept' })),
      'config',
    )
    await commands.run('kill-buffer', { source: 'key' })
    expect(run).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
    hooks.off('before-command', 'no')
    await commands.run('kill-buffer', { source: 'key' })
    expect(run).toHaveBeenCalledOnce()
    expect(after.mock.calls[0]?.[0]).toMatchObject({
      command: 'kill-buffer',
      context: { source: 'key' },
      ok: true,
    })
  })

  it('fires after-command with ok false when the command throws, and the error still propagates', async () => {
    const { hooks } = registry()
    const commands = new CommandRegistry()
    commands.register(
      defineCommand({
        name: 'fails',
        doc: 'Fails.',
        run: () => {
          throw new Error('nope')
        },
      }),
    )
    commands.useHooks(hooks)
    const after = vi.fn()
    hooks.on('after-command', handler('after', after), 'config')
    await expect(commands.run('fails', { source: 'test' })).rejects.toThrow('nope')
    expect(after.mock.calls[0]?.[0]).toMatchObject({ command: 'fails', ok: false })
  })

  it('fires the buffer points before the list is announced, switched only on a change', () => {
    const { hooks } = registry()
    const buffers = new BufferRegistry(hooks)
    const seen: string[] = []
    buffers.subscribe(() => seen.push('announce'))
    hooks.on(
      'buffer-created',
      handler('created', (e) => void seen.push(`created ${e.buffer.title}`)),
      'config',
    )
    hooks.on(
      'buffer-switched',
      handler(
        'switched',
        (e) => void seen.push(`switched ${e.from?.title ?? 'none'} ${e.to.title}`),
      ),
      'config',
    )
    hooks.on(
      'buffer-killed',
      handler('killed', (e) => void seen.push(`killed ${e.buffer.title}`)),
      'config',
    )
    const one = buffers.create({ kind: 'transcript', title: 'One' })
    const two = buffers.create({ kind: 'prompt', title: 'Two' })
    buffers.switchTo(two.id)
    buffers.switchTo(two.id)
    buffers.kill(one.id)
    expect(seen).toEqual([
      'created One',
      'announce',
      'created Two',
      'announce',
      'switched One Two',
      'announce',
      'killed One',
      'announce',
    ])
  })
})

describe('the config source (#165)', () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'nemesis-hooks-'))
    const path = join(dir, CONFIG_FILE)
    const { hooks, notices } = registry()
    const commands = new CommandRegistry()
    const loader = new ConfigLoader({
      path,
      base: () => defaultSettings('/documents'),
      buffers: () => [],
      run: (name) => commands.run(name, { source: 'config' }),
      hooks,
    })
    const config: string[] = []
    loader.on((event) => config.push(event.text))
    const target: ConfigTarget = {
      registry: commands,
      setUserKeymap: () => {},
      applySettings: () => {},
      rebuilt: () => {},
    }
    return {
      hooks,
      notices,
      config,
      loader,
      target,
      write: (source: string) => writeFileSync(path, source, 'utf8'),
    }
  }

  const ON_CREATED = `nemesis.on('buffer-created', {
  name: 'say-created',
  doc: 'Says which buffer was made.',
  run(event: { buffer: { title: string } }): void {
    nemesis.notice('created ' + event.buffer.title)
  },
})
`

  it('registers a handler with the source config, and a reload swaps it instead of adding one', async () => {
    const h = harness()
    h.write(ON_CREATED)
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.hooks.list()).toEqual([
      {
        point: 'buffer-created',
        name: 'say-created',
        doc: 'Says which buffer was made.',
        source: 'config',
      },
    ])
    await h.hooks.fire('buffer-created', { buffer: BUFFER })
    expect(h.config.filter((text) => text.startsWith('created'))).toEqual(['created Prompt'])
    h.write('')
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.hooks.list()).toEqual([])
  })

  it("reports a bad point, a bad name or a duplicate on the file's line, and keeps the previous load", () => {
    const h = harness()
    h.write(ON_CREATED)
    h.loader.reload(h.target)
    h.write(`\nnemesis.on('buffer-made', { name: 'x', doc: 'X.', run() {} })\n`)
    expect(h.loader.reload(h.target)).toMatchObject({
      ok: false,
      problem: { line: 2, message: 'HookError: No hook point named "buffer-made"' },
    })
    h.write(`${ON_CREATED}${ON_CREATED}`)
    expect(h.loader.reload(h.target)).toMatchObject({ ok: false, problem: { line: 8 } })
    expect(h.hooks.list().map((entry) => entry.name)).toEqual(['say-created'])
  })

  it('refuses a name another source holds on the point before anything is swapped', () => {
    const h = harness()
    h.hooks.on('buffer-created', handler('say-created'), 'cockpit')
    h.write(ON_CREATED)
    expect(h.loader.reload(h.target)).toMatchObject({ ok: false, problem: { line: 1 } })
    expect(h.hooks.list().map((entry) => entry.source)).toEqual(['cockpit'])
  })

  it('takes a veto from the file, and off removes a handler', async () => {
    const h = harness()
    h.hooks.on('before-command', handler('cockpit-guard'), 'cockpit')
    h.write(`nemesis.off('before-command', 'cockpit-guard')
nemesis.on('before-command', {
  name: 'keep-transcript',
  doc: 'Refuses kill-buffer.',
  run(event: { command: string }) {
    return event.command === 'kill-buffer' ? { veto: true, reason: 'kept' } : undefined
  },
})
`)
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.hooks.list().map((entry) => entry.name)).toEqual(['keep-transcript'])
    expect(
      await h.hooks.fire('before-command', { command: 'kill-buffer', context: { source: 'key' } }),
    ).toEqual({ veto: true, reason: 'kept' })
  })
})

describe('no hook reaches the permission path (ADR 0005)', () => {
  it('has no runtime import from the agent, security or preload', () => {
    const source = readFileSync(join(root, 'src/main/hooks.ts'), 'utf8')
    const runtime = [...source.matchAll(/^import\s+(?!type\b)[^'"]*['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    )
    expect(runtime.length).toBeGreaterThan(0)
    for (const specifier of runtime) {
      expect(specifier).not.toMatch(/^\.\/(agent|security)(\/|$)|preload/)
    }
    const typed = [...source.matchAll(/^import\s+type\b[^'"]*['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    )
    // The one thing it takes from the agent is the plain event types.
    expect(typed.filter((specifier) => specifier?.startsWith('./agent/'))).toEqual([
      './agent/events',
    ])
  })

  it('carries no hook on any IPC channel', () => {
    const ipc = readFileSync(join(root, 'src/shared/ipc.ts'), 'utf8')
    expect(ipc).not.toMatch(/hook/i)
  })
})
