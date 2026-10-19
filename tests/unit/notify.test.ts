import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AttentionTracker } from '../../src/main/agent/attention'
import type { AgentEvent, PermissionHandler } from '../../src/main/agent/events'
import { mockDriver } from '../../src/main/agent/mock'
import { PermissionBridge } from '../../src/main/agent/permission-bridge'
import { SessionManager } from '../../src/main/agent/session-manager'
import { createCockpitBuffers } from '../../src/main/buffers'
import {
  DEFAULT_NOTIFY_SETTINGS,
  Notifier,
  notifySettingsFromEnv,
  NullSink,
  telegramFromEnv,
  type NotificationMessage,
  type NotifySettings,
} from '../../src/main/notify/notifier'
import { TelegramSink } from '../../src/main/notify/telegram'
import { formatElapsed, notificationText } from '../../src/main/notify/text'
import type { SessionAttentionEvent } from '../../src/shared/notify'

// Walking away (#90): the three moments, the one text builder, the sinks.

const PROMPT = 'refactor the secret parser in /Users/someone/private/app.ts'
const REPLY = 'I changed the token handling in /Users/someone/private/app.ts'

/** A fake clock the tests move by hand. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms) => (at += ms) }
}

function finished(overrides: Partial<SessionAttentionEvent> = {}): SessionAttentionEvent {
  return {
    type: 'session-finished',
    session: 'parser',
    elapsedMs: 65_000,
    toolCalls: 3,
    ...overrides,
  }
}

describe('the attention tracker', () => {
  /** One turn of a fake stream: the prompt, two tool calls, the reply, then `end`. */
  function turn(end: AgentEvent): AgentEvent[] {
    return [
      { type: 'user-text', text: PROMPT },
      {
        type: 'started',
        sessionId: 'abcdef123456',
        model: 'mock',
        permissionMode: 'default',
        cwd: '/Users/someone/private',
        tools: [],
      },
      { type: 'tool-use', toolUseId: 't1', name: 'Read', input: { file_path: '/x' } },
      { type: 'tool-result', toolUseId: 't1', isError: false, text: 'secret contents' },
      { type: 'tool-use', toolUseId: 't2', name: 'Edit', input: { file_path: '/x' } },
      { type: 'assistant-text', text: REPLY },
      end,
    ]
  }

  function run(events: readonly AgentEvent[], step = 1_000): SessionAttentionEvent[] {
    const time = clock()
    const tracker = new AttentionTracker(time.now)
    const raised: SessionAttentionEvent[] = []
    for (const event of events) {
      time.advance(step)
      const one = tracker.observe(event)
      if (one !== null) raised.push(one)
    }
    return raised
  }

  it('raises session-finished at a turn that ended well, with elapsed time and tool calls', () => {
    const raised = run(
      turn({ type: 'turn-end', isError: false, result: REPLY, durationMs: 5, numTurns: 1 }),
    )
    expect(raised).toEqual([
      { type: 'session-finished', session: 'session abcdef12', elapsedMs: 6_000, toolCalls: 2 },
    ])
  })

  it('raises session-error at a turn that ended in an error, and at a failed stream', () => {
    expect(
      run(turn({ type: 'turn-end', isError: true, result: REPLY, durationMs: 5, numTurns: 1 })),
    ).toMatchObject([{ type: 'session-error', toolCalls: 2 }])
    expect(run(turn({ type: 'error', message: REPLY }))).toMatchObject([
      { type: 'session-error', toolCalls: 2 },
    ])
  })

  it('raises session-needs-you at a permission request or a question', () => {
    const raised = run([
      { type: 'named', name: 'parser\nwork' },
      ...turn({
        type: 'permission-request',
        requestId: 'r1',
        toolUseId: 't3',
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: PROMPT }] },
      }),
    ])
    expect(raised).toEqual([
      { type: 'session-needs-you', session: 'parser work', elapsedMs: 6_000, toolCalls: 2 },
    ])
  })

  it('stays quiet when the user interrupted the turn', () => {
    const tracker = new AttentionTracker(clock().now)
    tracker.observe({ type: 'user-text', text: PROMPT })
    tracker.interrupted()
    expect(
      tracker.observe({ type: 'turn-end', isError: true, result: '', durationMs: 1, numTurns: 1 }),
    ).toBeNull()
    // The next turn is news again.
    tracker.observe({ type: 'user-text', text: PROMPT })
    expect(
      tracker.observe({ type: 'turn-end', isError: true, result: '', durationMs: 1, numTurns: 1 }),
    ).toMatchObject({ type: 'session-error' })
  })
})

describe('the session manager emits the three events', () => {
  it('from the stream and from the permission bridge, through onAttention', async () => {
    const buffers = createCockpitBuffers()
    const permissions = new PermissionBridge(buffers)
    const handler: PermissionHandler = permissions
    const agent = new SessionManager({
      cwd: '/tmp/nemesis-unit',
      model: null,
      permissionHandler: handler,
      driver: mockDriver(),
      requests: permissions,
    })
    const raised: SessionAttentionEvent[] = []
    agent.onAttention((event) => raised.push(event))
    agent.nameSession('unit')

    const first = new Promise<void>((resolve) => {
      const off = agent.on((event) => {
        if (event.type === 'turn-end') {
          off()
          resolve()
        }
      })
    })
    await agent.send('hello')
    await first
    expect(raised.map((event) => event.type)).toEqual(['session-finished'])

    const second = new Promise<void>((resolve) => {
      const off = agent.on((event) => {
        if (event.type === 'turn-end') {
          off()
          resolve()
        }
      })
    })
    const asked = new Promise<void>((resolve) => {
      const off = permissions.on((event) => {
        if (event.type === 'permission-request') {
          off()
          resolve()
        }
      })
    })
    await agent.send('tool: Read')
    await asked
    expect(raised.at(-1)).toMatchObject({ type: 'session-needs-you', session: 'unit' })
    permissions.allowOnce()
    await second
    expect(raised.map((event) => event.type)).toEqual([
      'session-finished',
      'session-needs-you',
      'session-finished',
    ])
    expect(raised.at(-1)).toMatchObject({ session: 'unit', toolCalls: 1 })
    await agent.stop()
  })
})

describe('the text builder', () => {
  it('says the session, the moment, the elapsed time and the tool-call count', () => {
    expect(notificationText(finished())).toEqual({
      title: 'Nemesis: parser',
      body: 'Finished after 1m 05s, 3 tool calls.',
    })
    expect(notificationText(finished({ type: 'session-needs-you', toolCalls: 1 })).body).toBe(
      'Needs you after 1m 05s, 1 tool call.',
    )
    expect(notificationText(finished({ type: 'session-error', elapsedMs: 4_000 })).body).toBe(
      'Error after 4s, 3 tool calls.',
    )
  })

  it('never carries the prompt, the reply, a path or tool output from the stream', () => {
    const time = clock()
    const tracker = new AttentionTracker(time.now)
    const stream: AgentEvent[] = [
      { type: 'user-text', text: PROMPT },
      { type: 'tool-use', toolUseId: 't1', name: 'Read', input: { file_path: PROMPT } },
      { type: 'tool-result', toolUseId: 't1', isError: false, text: REPLY },
      { type: 'assistant-text', text: REPLY },
      { type: 'turn-end', isError: false, result: REPLY, durationMs: 1, numTurns: 1 },
    ]
    const texts = stream.flatMap((event) => {
      time.advance(500)
      const raised = tracker.observe(event)
      return raised === null ? [] : [notificationText(raised)]
    })
    expect(texts).toHaveLength(1)
    const all = JSON.stringify(texts)
    for (const forbidden of [PROMPT, REPLY, '/Users/someone', 'secret', 'token', 'app.ts']) {
      expect(all).not.toContain(forbidden)
    }
  })

  it('formats elapsed time short enough for a watch', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
    expect(formatElapsed(3_720_000)).toBe('1h 02m')
  })
})

describe('the notifier', () => {
  function notifier(settings: Partial<NotifySettings>, focused: boolean, sink = new NullSink()) {
    return {
      sink,
      notifier: new Notifier({
        sinks: [sink],
        settings: { ...DEFAULT_NOTIFY_SETTINGS, ...settings },
        isFocused: () => focused,
      }),
    }
  }

  it('by default raises needs-you and error, and finished only when unfocused', async () => {
    const focused = notifier({}, true)
    await focused.notifier.notify(finished())
    await focused.notifier.notify(finished({ type: 'session-needs-you' }))
    await focused.notifier.notify(finished({ type: 'session-error' }))
    expect(focused.sink.sent.map((message) => message.event.type)).toEqual([
      'session-needs-you',
      'session-error',
    ])
    const away = notifier({}, false)
    await away.notifier.notify(finished())
    expect(away.sink.sent).toHaveLength(1)
    expect(away.sink.sent[0]).toMatchObject({ title: 'Nemesis: parser', sound: false })
  })

  it('follows the per-event toggles and the sound setting', async () => {
    const { sink, notifier: n } = notifier(
      { finished: 'always', needsYou: false, error: false, sound: true },
      true,
    )
    await n.notify(finished())
    await n.notify(finished({ type: 'session-needs-you' }))
    await n.notify(finished({ type: 'session-error' }))
    expect(sink.sent.map((message) => [message.event.type, message.sound])).toEqual([
      ['session-finished', true],
    ])
    const off = notifier({ finished: 'off' }, false)
    await off.notifier.notify(finished())
    expect(off.sink.sent).toEqual([])
  })

  it('keeps the other sinks going when one fails, and reports the failure', async () => {
    const good = new NullSink()
    const problems: string[] = []
    const n = new Notifier({
      sinks: [
        {
          name: 'broken',
          send: () => Promise.reject(new Error('Telegram answered 500')),
        },
        good,
      ],
      settings: DEFAULT_NOTIFY_SETTINGS,
      isFocused: () => false,
      onError: (problem) => problems.push(problem),
    })
    await n.notify(finished())
    expect(good.sent).toHaveLength(1)
    expect(problems).toEqual(['Notification through broken failed: Telegram answered 500'])
  })

  it('reads its settings and the Telegram pair from the environment', () => {
    expect(notifySettingsFromEnv({})).toEqual(DEFAULT_NOTIFY_SETTINGS)
    expect(
      notifySettingsFromEnv({
        NEMESIS_NOTIFY_FINISHED: 'always',
        NEMESIS_NOTIFY_NEEDS_YOU: 'off',
        NEMESIS_NOTIFY_ERROR: 'OFF',
        NEMESIS_NOTIFY_SOUND: 'on',
      }),
    ).toEqual({ finished: 'always', needsYou: false, error: false, sound: true })
    const problems: string[] = []
    expect(
      notifySettingsFromEnv(
        { NEMESIS_NOTIFY_FINISHED: 'sometimes', NEMESIS_NOTIFY_SOUND: 'yes' },
        (problem) => problems.push(problem),
      ),
    ).toEqual(DEFAULT_NOTIFY_SETTINGS)
    expect(problems).toHaveLength(2)
    expect(telegramFromEnv({})).toBeNull()
    expect(telegramFromEnv({ NEMESIS_TELEGRAM_BOT_TOKEN: 'fake-token' })).toBeNull()
    expect(
      telegramFromEnv({ NEMESIS_TELEGRAM_BOT_TOKEN: 'fake-token', NEMESIS_TELEGRAM_CHAT_ID: '42' }),
    ).toEqual({ token: 'fake-token', chatId: '42' })
  })
})

describe('the Telegram sink', () => {
  let server: Server | null = null

  afterEach(async () => {
    const running = server
    server = null
    if (running !== null) await new Promise((resolve) => running.close(resolve))
  })

  interface Received {
    readonly method: string | undefined
    readonly url: string | undefined
    readonly body: unknown
  }

  /** A local stand-in for the Bot API; no request leaves the machine. */
  async function fixture(status: number): Promise<{ endpoint: string; received: Received[] }> {
    const received: Received[] = []
    server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.push({
          method: request.method,
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: status === 200 }))
      })
    })
    const listening = server
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
    const { port } = listening.address() as AddressInfo
    return { endpoint: `http://127.0.0.1:${port}`, received }
  }

  function message(): NotificationMessage {
    return { ...notificationText(finished()), event: finished(), sound: false }
  }

  it('posts the title and the line to sendMessage for the chat', async () => {
    const { endpoint, received } = await fixture(200)
    await new TelegramSink({ token: 'fake-token', chatId: '42', endpoint }).send(message())
    expect(received).toEqual([
      {
        method: 'POST',
        url: '/botfake-token/sendMessage',
        body: {
          chat_id: '42',
          text: 'Nemesis: parser\nFinished after 1m 05s, 3 tool calls.',
          disable_notification: false,
        },
      },
    ])
  })

  it('fails with the status only, never the token or the URL', async () => {
    const { endpoint } = await fixture(401)
    const sink = new TelegramSink({ token: 'fake-token', chatId: '42', endpoint })
    await expect(sink.send(message())).rejects.toThrow(/^Telegram answered 401$/)
    const unreachable = new TelegramSink({
      token: 'fake-token',
      chatId: '42',
      endpoint: 'http://127.0.0.1:1',
    })
    const error: unknown = await unreachable.send(message()).catch((caught: unknown) => caught)
    expect(String(error)).not.toContain('fake-token')
    expect(String(error)).toContain('did not get through')
  })
})
