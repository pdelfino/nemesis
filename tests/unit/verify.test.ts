import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/main/agent/events'
import { CommandError } from '../../src/main/commands/registry'
import {
  DEFAULT_VERIFY_COMMAND,
  describeSource,
  resolveVerifyCommand,
  runCheckInShell,
  Verifier,
  verifyCommandOf,
  type CheckOutcome,
} from '../../src/main/verify'

// The verify key (#81): one command from three sources, run with the user's
// permissions outside the agent's tool path, its output an evidence event.

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
}): { verifier: Verifier; events: AgentEvent[]; runs: { command: string; cwd: string }[] } {
  const events: AgentEvent[] = []
  const runs: { command: string; cwd: string }[] = []
  let clock = 1000
  const verifier = new Verifier({
    cwd: '/work',
    settingsCommand: options.settings ?? null,
    issueBody: () => options.issue ?? null,
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
  return { verifier, events, runs }
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
      run: () => Promise.reject(new Error('spawn failed')),
    })
    await expect(broken.verify()).rejects.toThrow('spawn failed')
    expect(broken.running).toBeNull()
  })
})
