import { describe, expect, it } from 'vitest'
import {
  defineCommand,
  type Command,
  type CommandContext,
  type McpClass,
} from '../../src/main/commands/registry'
import {
  MAX_USER_PAGE_HTML,
  pressButton,
  renderUserPage,
  type ButtonEvent,
  type ButtonOwner,
  type UserPage,
} from '../../src/main/pages/user-pages'
import { parseUserPageCommand } from '../../src/shared/user-pages'

// Config pages (#181) on fakes: the HTML a page answers, and the button
// route's checks, in order: the sender is a page buffer main holds, from its
// top frame, on a config page that is also the buffer's committed URL, the
// payload is exactly one kebab-case name, the name is registered, and the
// command's own class decides. The live run is
// tests/e2e/security/user-pages.spec.ts.

const PAGE = 'nemesis://app/user/tools'

function page(render: UserPage['render']): UserPage {
  return { name: 'tools', title: 'Tools <&>', render }
}

describe('renderUserPage', () => {
  it("answers the page's HTML under its title, escaped, with a copy of the params", () => {
    const html = renderUserPage([page((params) => `<p>${params['q'] ?? ''}</p>`)], {
      name: 'tools',
      params: { q: 'hi' },
    })
    expect(html).toContain('<title>Tools &lt;&amp;&gt;</title>')
    expect(html).toContain('<p>hi</p>')
  })

  it('answers null for a page the config does not define', () => {
    expect(renderUserPage([page(() => '')], { name: 'other', params: {} })).toBeNull()
  })

  it('answers a page that says so when render throws, returns no string or too much', () => {
    const thrown = renderUserPage(
      [
        page(() => {
          throw new Error('<script>bad</script>')
        }),
      ],
      { name: 'tools', params: {} },
    )
    expect(thrown).toContain('failed: &lt;script&gt;bad&lt;/script&gt;')
    expect(thrown).not.toContain('<script>')
    const wrong = renderUserPage([page(() => 42 as unknown as string)], {
      name: 'tools',
      params: {},
    })
    expect(wrong).toContain('render returns an HTML string')
    const long = renderUserPage([page(() => 'x'.repeat(MAX_USER_PAGE_HTML + 1))], {
      name: 'tools',
      params: {},
    })
    expect(long).toContain('is longer than')
  })
})

describe('the button message', () => {
  it('is exactly { command } with a kebab-case name', () => {
    expect(parseUserPageCommand({ command: 'list-messages' })).toBe('list-messages')
    for (const bad of [
      null,
      'list-messages',
      ['list-messages'],
      {},
      { command: 'list-messages', args: [] },
      { command: 'List' },
      { command: 'a b' },
      { command: 42 },
      { command: 'x'.repeat(65) },
    ]) {
      expect(() => parseUserPageCommand(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

interface Fake {
  readonly owner: ButtonOwner
  readonly ran: { name: string; context: CommandContext }[]
  readonly asked: string[]
  readonly notices: string[]
  readonly warned: string[]
}

function fake(
  options: {
    classes?: Record<string, McpClass | undefined>
    yes?: boolean
    url?: string | null
  } = {},
): Fake {
  const classes = options.classes ?? { 'free-one': 'free', 'yes-one': 'yes', 'never-one': 'never' }
  const commands = new Map<string, Command>(
    Object.entries(classes).map(([name, mcp]) => [
      name,
      defineCommand({ name, doc: 'Test.', ...(mcp === undefined ? {} : { mcp }), run: () => {} }),
    ]),
  )
  const ran: Fake['ran'] = []
  const asked: string[] = []
  const notices: string[] = []
  return {
    ran,
    asked,
    notices,
    warned: [],
    owner: {
      registry: {
        get: (name) => commands.get(name),
        run: (name, context) => {
          ran.push({ name, context })
          return Promise.resolve()
        },
      },
      confirm: (question) => {
        asked.push(question)
        return Promise.resolve(options.yes ?? false)
      },
      notice: (text) => notices.push(text),
      committedUrl: options.url === undefined ? PAGE : options.url,
    },
  }
}

function event(url: string | null, parent: unknown = null, id = 7): ButtonEvent {
  return {
    sender: { id },
    senderFrame: url === null ? null : ({ url, parent } as ButtonEvent['senderFrame']),
  }
}

async function press(f: Fake, from: ButtonEvent, payload: unknown, holds = true): Promise<string> {
  return pressButton(
    from,
    payload,
    (id) => (holds && id === 7 ? f.owner : null),
    (_key, line) => f.warned.push(line),
  )
}

describe('pressButton', () => {
  it('runs a free command at once, as a user page source, in a page buffer', async () => {
    const f = fake()
    expect(await press(f, event(PAGE), { command: 'free-one' })).toBe('ran')
    expect(f.ran).toEqual([
      { name: 'free-one', context: { source: 'user-page', bufferType: 'page' } },
    ])
    expect(f.asked).toEqual([])
  })

  it('asks before a yes command, and a no runs nothing', async () => {
    const no = fake()
    expect(await press(no, event(PAGE), { command: 'yes-one' })).toBe('declined')
    expect(no.asked).toEqual(['Run yes-one, from the page tools?'])
    expect(no.ran).toEqual([])
    const yes = fake({ yes: true })
    expect(await press(yes, event(PAGE), { command: 'yes-one' })).toBe('ran')
  })

  it('asks before a command that declares no class, which is yes', async () => {
    const f = fake({ classes: { mine: undefined } })
    expect(await press(f, event(PAGE), { command: 'mine' })).toBe('declined')
    expect(f.asked).toHaveLength(1)
  })

  it('refuses a never command and an unregistered name, with a notice', async () => {
    const f = fake()
    expect(await press(f, event(PAGE), { command: 'never-one' })).toBe('refused')
    expect(await press(f, event(PAGE), { command: 'no-such-command' })).toBe('refused')
    expect(f.ran).toEqual([])
    expect(f.asked).toEqual([])
    expect(f.notices).toEqual([
      expect.stringContaining('never from a page button'),
      'Not run: the page tools names no command "no-such-command"',
    ])
  })

  it('drops a sender that is no page buffer, a subframe, another page or a page not committed', async () => {
    const cases: [string, ButtonEvent, boolean, string | null][] = [
      ['not a page buffer', event(PAGE), false, PAGE],
      ['no frame', event(null), true, PAGE],
      ['a subframe', event(PAGE, {}), true, PAGE],
      ['a web page', event('https://example.test/'), true, 'https://example.test/'],
      ['an app page', event('nemesis://app/'), true, 'nemesis://app/'],
      ['another committed page', event(PAGE), true, 'nemesis://app/user/other'],
      ['nothing committed', event(PAGE), true, null],
    ]
    for (const [what, from, holds, url] of cases) {
      const f = fake({ url })
      expect(await press(f, from, { command: 'free-one' }, holds), what).toBe('dropped')
      expect(f.ran, what).toEqual([])
      expect(f.warned, what).toHaveLength(1)
      expect(f.warned[0], what).not.toContain('free-one')
    }
  })

  it('drops a payload that is not exactly one name', async () => {
    const f = fake()
    for (const payload of [{ command: 'free-one', extra: 1 }, { command: 'Free' }, 'free-one']) {
      expect(await press(f, event(PAGE), payload)).toBe('dropped')
    }
    expect(f.ran).toEqual([])
  })

  it('says so when the command fails', async () => {
    const f = fake()
    const failing: ButtonOwner = {
      ...f.owner,
      registry: { ...f.owner.registry, run: () => Promise.reject(new Error('boom')) },
    }
    expect(
      await pressButton(
        event(PAGE),
        { command: 'free-one' },
        () => failing,
        () => {},
      ),
    ).toBe('failed')
    expect(f.notices).toEqual(['free-one: boom'])
  })
})
