import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/main/agent/events'
import { CommandError } from '../../src/main/commands/registry'
import {
  IssueAttachment,
  parseIssueJson,
  parseIssueNumber,
  type AttachedIssue,
} from '../../src/main/issues'

// The issue attached to the session (#81): fetched through the user's gh,
// kept in memory, its Verify section the first source of the verify key.

describe('an issue number as typed', () => {
  it('is digits, a leading # allowed, spaces around it ignored', () => {
    expect(parseIssueNumber('81')).toBe(81)
    expect(parseIssueNumber('#81')).toBe(81)
    expect(parseIssueNumber('  81 ')).toBe(81)
  })

  it('is refused otherwise, with what was typed in the message', () => {
    for (const text of ['abc', '0', '-3', '8.1', '', '#', '81 82']) {
      expect(() => parseIssueNumber(text)).toThrow(CommandError)
    }
    expect(() => parseIssueNumber('abc')).toThrow('Not an issue number: abc')
  })
})

describe("gh's answer", () => {
  it('is read for its number, title and body, shape only', () => {
    expect(
      parseIssueJson('{"number": 81, "title": "Verify", "body": "## Verify\\n`npm test`"}'),
    ).toEqual({
      number: 81,
      title: 'Verify',
      body: '## Verify\n`npm test`',
    })
    expect(() => parseIssueJson('not json')).toThrow('gh did not answer with JSON')
    expect(() => parseIssueJson('null')).toThrow(CommandError)
    expect(() => parseIssueJson('{"number": "81", "title": "x", "body": ""}')).toThrow(
      'without number, title and body',
    )
  })
})

function harness(issue: AttachedIssue | Error): {
  readonly issues: IssueAttachment
  readonly events: AgentEvent[]
  readonly fetched: { number: number; cwd: string }[]
} {
  const events: AgentEvent[] = []
  const fetched: { number: number; cwd: string }[] = []
  const issues = new IssueAttachment({
    cwd: '/work',
    fetch: (number, cwd) => {
      fetched.push({ number, cwd })
      return issue instanceof Error ? Promise.reject(issue) : Promise.resolve(issue)
    },
  })
  issues.on((event) => events.push(event))
  return { issues, events, fetched }
}

describe('the attachment', () => {
  it('fetches the issue in the session folder, keeps it and says what its Verify section names', async () => {
    const { issues, events, fetched } = harness({
      number: 81,
      title: 'Guideline: verify command and evidence blocks',
      body: '## Verify\n- `npm run gate` is green.\n',
    })
    expect(issues.current).toBeNull()
    const issue = await issues.attach('#81')
    expect(fetched).toEqual([{ number: 81, cwd: '/work' }])
    expect(issues.current).toBe(issue)
    expect(events).toEqual([
      {
        type: 'notice',
        text: 'Attached issue #81: Guideline: verify command and evidence blocks. C-c C-v runs its check: npm run gate.',
      },
    ])
  })

  it('says when the Verify section names no command, so the key is no surprise', async () => {
    const { issues, events } = harness({ number: 7, title: 'Docs', body: '## Verify\nreads well' })
    await issues.attach('7')
    expect(events[0]).toEqual({
      type: 'notice',
      text: 'Attached issue #7: Docs. its Verify section names no command, so C-c C-v runs the settings or the default check.',
    })
  })

  it('keeps the issue it had when a fetch fails or the number is refused', async () => {
    const good = harness({ number: 1, title: 'One', body: '' })
    await good.issues.attach('1')
    const { issues, events } = harness(new CommandError('gh could not fetch #2: not found'))
    await expect(issues.attach('2')).rejects.toThrow('gh could not fetch #2: not found')
    await expect(issues.attach('two')).rejects.toThrow('Not an issue number: two')
    expect(issues.current).toBeNull()
    expect(events).toEqual([])
    expect(good.issues.current?.number).toBe(1)
  })
})
