import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEvidenceEvent } from '../../src/main/agent/events'
import { CommandError } from '../../src/main/commands/registry'
import {
  checkPassed,
  DEFAULT_VERIFY_COMMAND,
  gatePrompt,
  describeSource,
  resolveVerifyCommand,
  verifyQuestion,
  runCheckInShell,
  Verifier,
  verifyCommandOf,
  type CheckOutcome,
} from '../../src/main/verify'

// The verify key (#81): one command from three sources, run with the user's
// permissions outside the agent's tool path, its output an evidence event.
// A command from the attached issue is remote text, so it is confirmed
// before its first run and the yes is remembered while the issue is
// unchanged (#98).

const ISSUE = `## Why
Something.

## Verify
- The e2e above passes.
- \`npm run lint && npm test\` is green, then \`npm run gate\`.

## Do not touch
- \`src/main/security/\` stays as it is.
`

describe("an issue's Verify section", () => {
  it('names the first inline code span under the Verify heading', () => {
    expect(verifyCommandOf(ISSUE)).toBe('npm run lint && npm test')
    expect(verifyCommandOf('# Verify:\nRun `make check`.')).toBe('make check')
    expect(verifyCommandOf('### verify\n\n`` `` \n`  go test ./...  `')).toBe('go test ./...')
  })

  it('names nothing when the section has no code span, or there is no section', () => {
    expect(verifyCommandOf('## Verify\n- The e2e passes.\n\n## Do not touch\n`rm -rf`')).toBeNull()
    expect(verifyCommandOf('## Why\n`npm test`')).toBeNull()
    expect(verifyCommandOf('')).toBeNull()
    // A code span before the heading, or in the section after it, is not the check.
    expect(verifyCommandOf('`npm test`\n## Verify\nnothing\n## Related\n`gh pr view`')).toBeNull()
  })
})

describe('the three sources', () => {
  it('take the issue first, then the settings, then the default', () => {
    expect(resolveVerifyCommand(ISSUE, 'npm test')).toEqual({
      command: 'npm run lint && npm test',
      source: 'issue',
    })
    expect(resolveVerifyCommand('## Verify\nlooks right', ' npm test ')).toEqual({
      command: 'npm test',
      source: 'settings',
    })
    expect(resolveVerifyCommand(null, 'make check')).toEqual({
      command: 'make check',
      source: 'settings',
    })
    expect(resolveVerifyCommand(null, null)).toEqual({
      command: DEFAULT_VERIFY_COMMAND,
      source: 'default',
    })
    expect(resolveVerifyCommand(null, '   ')).toEqual({
      command: 'npm run gate',
      source: 'default',
    })
    expect(describeSource('issue')).toBe('from the attached issue')
    expect(describeSource('settings')).toBe('from the settings')
    expect(describeSource('default')).toBe('the default')
  })
})

describe('the shell runner', () => {
  it('runs the command in the folder given and keeps stdout and stderr with the exit code', async () => {
    const outcome = await runCheckInShell('pwd; echo out; echo err 1>&2; exit 3', '/')
    expect(outcome.exitCode).toBe(3)
    expect(outcome.signal).toBeNull()
    expect(outcome.output).toBe('/\nout\nerr\n')
  })

  it('reports a command the shell cannot find as the shell does, never as a throw', async () => {
    const outcome = await runCheckInShell('/no/such/binary-for-nemesis', '/')
    expect(outcome.exitCode).toBe(127)
    expect(outcome.output).toMatch(/not found|No such file/)
  })
})

function harness(options: {
  readonly settings?: string | null
  readonly issue?: string | null
  readonly outcome?: CheckOutcome
  /** What the question is answered with; the default says yes. */
  readonly answer?: boolean
}): {
  verifier: Verifier
  events: AgentEvent[]
  runs: { command: string; cwd: string }[]
  asked: string[]
} {
  const events: AgentEvent[] = []
  const runs: { command: string; cwd: string }[] = []
  const asked: string[] = []
  let clock = 1000
  const verifier = new Verifier({
    cwd: '/work',
    settingsCommand: options.settings ?? null,
    issueBody: () => options.issue ?? null,
    confirm: (command) => {
      asked.push(command)
      return Promise.resolve(options.answer ?? true)
    },
    run: (command, cwd) => {
      runs.push({ command, cwd })
      clock += 1500
      return Promise.resolve(
        options.outcome ?? { exitCode: 0, signal: null, output: 'all green\n' },
      )
    },
    now: () => clock,
  })
  verifier.on((event) => events.push(event))
  return { verifier, events, runs, asked }
}

describe('the verifier', () => {
  it('says what runs and where it came from, runs it in the cwd, then emits the evidence', async () => {
    const { verifier, events, runs } = harness({ settings: 'npm test' })
    expect(verifier.command()).toEqual({ command: 'npm test', source: 'settings' })
    const evidence = await verifier.verify()
    expect(runs).toEqual([{ command: 'npm test', cwd: '/work' }])
    expect(events).toEqual([
      { type: 'notice', text: 'Verifying: npm test (from the settings)' },
      {
        type: 'evidence',
        command: 'npm test',
        source: 'settings',
        exitCode: 0,
        signal: null,
        durationMs: 1500,
        output: 'all green\n',
      },
    ])
    expect(events[1]).toBe(evidence)
    expect(verifier.running).toBeNull()
  })

  it("reads the attached issue at each run, so an issue attached later is the check's source", async () => {
    let issue: string | null = null
    const events: AgentEvent[] = []
    const verifier = new Verifier({
      cwd: '/work',
      settingsCommand: null,
      issueBody: () => issue,
      confirm: () => Promise.resolve(true),
      run: () => Promise.resolve({ exitCode: 1, signal: null, output: 'red\n' }),
      now: () => 0,
    })
    verifier.on((event) => events.push(event))
    expect(verifier.command()).toEqual({ command: 'npm run gate', source: 'default' })
    issue = ISSUE
    const evidence = await verifier.verify()
    expect(evidence).toMatchObject({
      command: 'npm run lint && npm test',
      source: 'issue',
      exitCode: 1,
      durationMs: 0,
    })
    expect(events[0]).toEqual({
      type: 'notice',
      text: 'Verifying: npm run lint && npm test (from the attached issue)',
    })
  })

  it('runs one check at a time and is free again once it ended, even when the run failed', async () => {
    let release: (outcome: CheckOutcome) => void = () => undefined
    const verifier = new Verifier({
      cwd: '/work',
      settingsCommand: 'sleep 1',
      issueBody: () => null,
      confirm: () => Promise.resolve(true),
      run: () => new Promise((resolve) => (release = resolve)),
    })
    const first = verifier.verify()
    expect(verifier.running).toEqual({ command: 'sleep 1', source: 'settings' })
    await expect(verifier.verify()).rejects.toThrow(CommandError)
    await expect(verifier.verify()).rejects.toThrow('A check is already running: sleep 1')
    release({ exitCode: null, signal: 'SIGKILL', output: '' })
    await expect(first).resolves.toMatchObject({ exitCode: null, signal: 'SIGKILL' })
    expect(verifier.running).toBeNull()

    const broken = new Verifier({
      cwd: '/work',
      settingsCommand: 'x',
      issueBody: () => null,
      confirm: () => Promise.resolve(true),
      run: () => Promise.reject(new Error('spawn failed')),
    })
    await expect(broken.verify()).rejects.toThrow('spawn failed')
    expect(broken.running).toBeNull()
  })
})

describe("the question before an issue's command (#98)", () => {
  it('asks with the exact command, and a no is a notice and no run', async () => {
    const { verifier, events, runs, asked } = harness({ issue: ISSUE, answer: false })
    await expect(verifier.verify()).resolves.toBeNull()
    expect(asked).toEqual(['npm run lint && npm test'])
    expect(runs).toEqual([])
    expect(events).toEqual([{ type: 'notice', text: 'Not run: npm run lint && npm test' }])
    expect(verifier.running).toBeNull()
    // A no is not remembered: the next press asks again.
    await verifier.verify()
    expect(asked).toHaveLength(2)
    expect(runs).toEqual([])
    expect(verifyQuestion('make check')).toBe(
      "Run the attached issue's check in a shell? make check",
    )
  })

  it('runs on a yes, and a second run on the same issue does not ask again', async () => {
    const { verifier, events, runs, asked } = harness({ issue: ISSUE })
    const first = await verifier.verify()
    expect(first).toMatchObject({ type: 'evidence', source: 'issue', exitCode: 0 })
    expect(asked).toEqual(['npm run lint && npm test'])
    expect(events[0]).toEqual({
      type: 'notice',
      text: 'Verifying: npm run lint && npm test (from the attached issue)',
    })
    await verifier.verify()
    expect(asked).toHaveLength(1)
    expect(runs).toHaveLength(2)
    // Forgetting, as new-task, resume-session and a new attach do, asks once more.
    verifier.forgetApprovals()
    await verifier.verify()
    expect(asked).toHaveLength(2)
    expect(runs).toHaveLength(3)
  })

  it('asks again when the same command comes from a changed issue body, and for another issue', async () => {
    let issue = ISSUE
    const asked: string[] = []
    const runs: string[] = []
    const verifier = new Verifier({
      cwd: '/work',
      settingsCommand: null,
      issueBody: () => issue,
      confirm: (command) => {
        asked.push(command)
        return Promise.resolve(true)
      },
      run: (command) => {
        runs.push(command)
        return Promise.resolve({ exitCode: 0, signal: null, output: '' })
      },
    })
    await verifier.verify()
    expect(asked).toEqual(['npm run lint && npm test'])
    // The same issue fetched again, its Verify section reworded around the same command.
    issue = `${ISSUE}\n- And the docs build.\n`
    await verifier.verify()
    expect(asked).toHaveLength(2)
    // Another issue, another command.
    issue = '## Verify\n`make check`\n'
    await verifier.verify()
    expect(asked).toEqual(['npm run lint && npm test', 'npm run lint && npm test', 'make check'])
    expect(runs).toEqual(['npm run lint && npm test', 'npm run lint && npm test', 'make check'])
  })

  it("never asks for the settings' command or the default: they are the user's own text", async () => {
    const settings = harness({ settings: 'npm test', answer: false })
    await expect(settings.verifier.verify()).resolves.toMatchObject({ source: 'settings' })
    expect(settings.asked).toEqual([])
    expect(settings.runs).toEqual([{ command: 'npm test', cwd: '/work' }])
    const fallback = harness({ issue: '## Verify\nlooks right', answer: false })
    await expect(fallback.verifier.verify()).resolves.toMatchObject({ source: 'default' })
    expect(fallback.asked).toEqual([])
    expect(fallback.runs).toEqual([{ command: DEFAULT_VERIFY_COMMAND, cwd: '/work' }])
  })

  it('holds the verifier while the question is open, so one key press is one question', async () => {
    let answer: (yes: boolean) => void = () => undefined
    const verifier = new Verifier({
      cwd: '/work',
      settingsCommand: null,
      issueBody: () => ISSUE,
      confirm: () => new Promise((resolve) => (answer = resolve)),
      run: () => Promise.resolve({ exitCode: 0, signal: null, output: '' }),
    })
    const pending = verifier.verify()
    expect(verifier.running).toEqual({ command: 'npm run lint && npm test', source: 'issue' })
    await expect(verifier.verify()).rejects.toThrow(CommandError)
    answer(false)
    await expect(pending).resolves.toBeNull()
    expect(verifier.running).toBeNull()
  })
})

// The stop gate's prompt (#113): a red check as an ordinary user message,
// the evidence header and the tail of the output, fenced.
describe("the stop gate's prompt", () => {
  const red: AgentEvidenceEvent = {
    type: 'evidence',
    command: 'npm test',
    source: 'settings',
    exitCode: 2,
    signal: null,
    durationMs: 1500,
    output: 'FAIL auth.test.ts\n1 failed\n',
  }

  it('is green at exit 0 only', () => {
    expect(checkPassed({ ...red, exitCode: 0 })).toBe(true)
    expect(checkPassed(red)).toBe(false)
    expect(checkPassed({ ...red, exitCode: null, signal: 'SIGTERM' })).toBe(false)
    expect(checkPassed({ ...red, exitCode: null })).toBe(false)
  })

  it('carries the evidence header and the output in a fence', () => {
    expect(gatePrompt(red)).toBe(
      'The check failed, fix it:\n\nEvidence: npm test (exit 2, 1.5s)\n\n```\nFAIL auth.test.ts\n1 failed\n```',
    )
  })

  it('fences past any backtick run in the output and keeps only the tail of a long one', () => {
    expect(gatePrompt({ ...red, output: 'a ```` b' })).toContain('\n`````\na ```` b\n`````')
    const long = `${'x'.repeat(30_000)}THE END`
    const prompt = gatePrompt({ ...red, output: long })
    expect(prompt).toContain('THE END')
    expect(prompt.length).toBeLessThan(21_000)
  })
})
