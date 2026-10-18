import { describe, expect, it, vi } from 'vitest'
import type { AgentNoticeEvent } from '../../src/main/agent/events'
import {
  describeExternal,
  displayUrl,
  ExternalPolicy,
  isExternalProtocol,
  LAUNCHABLE_SCHEMES,
  type NavigationSurface,
} from '../../src/main/security/external'

/**
 * The one door to `shell.openExternal` (#51, SECURITY.org T2), on a fake
 * launcher: nothing launches without a yes, nothing off the list launches at
 * all. The live path from a page's `mailto:` link to the prompt buffer is
 * tests/e2e/security/downloads-quarantine.spec.ts.
 */

function setUp(answer: boolean | Error) {
  const launch = vi.fn(async () => undefined)
  const confirm = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  const policy = new ExternalPolicy({ confirm, launch })
  const notices: string[] = []
  policy.on((event: AgentNoticeEvent) => notices.push(event.text))
  return { policy, launch, confirm, notices }
}

describe('which URLs are a handler’s (SECURITY.org T2)', () => {
  it('names the schemes a page or the app handles itself, and nothing else', () => {
    for (const url of [
      'https://example.org/',
      'http://127.0.0.1:1/',
      'nemesis://app/index.html',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.org/uuid',
      'about:blank',
      'not a url',
    ]) {
      expect(isExternalProtocol(url), url).toBe(false)
    }
    for (const url of ['mailto:nyx@example.org', 'tel:+15145550100', 'zoommtg://zoom.us/join']) {
      expect(isExternalProtocol(url), url).toBe(true)
    }
  })

  it('shows a URL printable and no longer than a line', () => {
    expect(displayUrl('mailto:nyx@example.org')).toBe('mailto:nyx@example.org')
    expect(displayUrl(`mailto:a${String.fromCharCode(0x202e)}b`)).toBe('mailto:ab')
    expect(displayUrl(`mailto:${'x'.repeat(200)}`)).toHaveLength(123)
    expect(describeExternal({ url: 'tel:+1', scheme: 'tel:', origin: null })).toBe(
      'Open tel:+1 with the system handler? Asked by an unknown origin',
    )
  })

  it('launches http, https, mailto and tel only', () => {
    expect([...LAUNCHABLE_SCHEMES]).toEqual(['http:', 'https:', 'mailto:', 'tel:'])
  })
})

describe('the external policy (SECURITY.org T2)', () => {
  it('launches a mailto link after a yes, and says so', async () => {
    const { policy, launch, confirm, notices } = setUp(true)
    expect(await policy.open('mailto:nyx@example.org', 'https://example.org')).toBe(true)
    expect(confirm).toHaveBeenCalledWith({
      url: 'mailto:nyx@example.org',
      scheme: 'mailto:',
      origin: 'https://example.org',
    })
    expect(launch).toHaveBeenCalledWith('mailto:nyx@example.org')
    expect(policy.launched).toEqual(['mailto:nyx@example.org'])
    expect(notices).toEqual([
      'Opened a mailto: link from https://example.org with the system handler',
    ])
  })

  it('launches nothing on a no, or when the confirmation fails', async () => {
    const no = setUp(false)
    expect(await no.policy.open('tel:+15145550100', 'https://example.org')).toBe(false)
    expect(no.launch).not.toHaveBeenCalled()
    expect(no.notices).toEqual([
      'Refused tel: link from https://example.org: nothing was opened (SECURITY.org, T2)',
    ])
    const broken = setUp(new Error('no window'))
    expect(await broken.policy.open('https://example.org/', null)).toBe(false)
    expect(broken.launch).not.toHaveBeenCalled()
  })

  it('refuses a scheme off the list without asking: custom handlers, file, javascript, garbage', async () => {
    const { policy, launch, confirm, notices } = setUp(true)
    for (const url of [
      'zoommtg://zoom.us/join?confno=1',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'slack://open',
      'not a url',
    ]) {
      expect(await policy.open(url, 'https://example.org'), url).toBe(false)
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(notices[0]).toBe(
      'Refused zoommtg: link from https://example.org: only http:, https:, mailto:, tel: links open, after a yes (SECURITY.org, T2)',
    )
    expect(notices[4]).toMatch(/^Refused an unparseable link/)
  })

  it('reports a launch the system refused', async () => {
    const launch = vi.fn(async () => {
      throw new Error('no handler')
    })
    const policy = new ExternalPolicy({ confirm: async () => true, launch })
    const notices: string[] = []
    policy.on((event) => notices.push(event.text))
    expect(await policy.open('mailto:x@y', null)).toBe(false)
    expect(notices).toEqual(['The system could not open the mailto: link from an unknown origin'])
  })

  it('watches a page: a navigation to a handler scheme asks, a page navigation does not', async () => {
    const { policy, confirm, launch } = setUp(false)
    const listeners = new Map<string, (event: unknown, url: string) => void>()
    const contents = {
      getURL: () => 'https://example.org/page',
      on(event: string, listener: (event: unknown, url: string) => void) {
        listeners.set(event, listener)
        return contents
      },
    } as unknown as NavigationSurface
    policy.watch(contents)
    policy.watch(contents)
    expect([...listeners.keys()]).toEqual(['will-navigate'])
    const navigate = listeners.get('will-navigate')
    navigate?.(null, 'https://example.org/next')
    navigate?.(null, 'file:///etc/passwd')
    expect(confirm).not.toHaveBeenCalled()
    navigate?.(null, 'mailto:nyx@example.org')
    await new Promise((done) => setTimeout(done, 0))
    expect(confirm).toHaveBeenCalledWith({
      url: 'mailto:nyx@example.org',
      scheme: 'mailto:',
      origin: 'https://example.org',
    })
    expect(launch).not.toHaveBeenCalled()
  })
})
