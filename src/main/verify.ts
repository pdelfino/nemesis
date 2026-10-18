import { spawn } from 'node:child_process'
import type {
  AgentEvent,
  AgentEventListener,
  AgentEvidenceEvent,
  VerifySource,
} from './agent/events'
import { CommandError } from './commands/registry'

/**
 * The verify key (#81): the guide's first practice is a check that returns
 * pass or fail, and Claude showing the evidence rather than asserting
 * success. In the cockpit the check is one key, `C-c C-v`, and the evidence
 * is a block in the transcript with the exit code and the duration in its
 * header and the output folded under it.
 *
 * The command comes from the first of three places that names one: the
 * Verify section of the GitHub issue attached to the session (#81, the
 * `attach-issue` command), the `verify` entry of the settings file, and
 * `npm run gate`, the project's own gate. The check runs with the user's
 * permissions, as a child of the cockpit in the folder it was started in,
 * never through the agent's tool path: the agent sees nothing of it unless
 * the user sends the evidence, and no permission rule is consulted or
 * relaxed. The command of an attached issue is shown in the notice when the
 * issue is attached, so the key that runs it is pressed knowing it.
 *
 * Plain data, no Electron: the unit tests run it with a fake runner, and
 * once with the real shell on an `echo`.
 */

/** What runs when neither an issue nor the settings name a check. */
export const DEFAULT_VERIFY_COMMAND = 'npm run gate'

/** Output past this many characters is cut at the head: the end of a run is where the verdict is. */
const OUTPUT_LIMIT = 200_000

/** A check the key can run, and where it came from. */
export interface VerifyCommand {
  readonly command: string
  readonly source: VerifySource
}

/** What a check came to, as the runner reports it. */
export interface CheckOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly output: string
}

/** Runs one command in `cwd` and resolves when it has ended. Never rejects: a failure to start is an outcome. */
export type CheckRunner = (command: string, cwd: string) => Promise<CheckOutcome>

/**
 * The command the Verify section of an issue names, or null. The section
 * is the `## Verify` heading the repository's issue template asks for, and
 * the command is the first inline code span under it, as in
 * `` `npm run lint && npm test` ``: a Verify line without one ("the e2e
 * above passes") names no command, and the next source is tried.
 */
export function verifyCommandOf(issueBody: string): string | null {
  const lines = issueBody.split('\n')
  let inside = false
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      inside = /^verify\b/i.test(heading[1] ?? '')
      continue
    }
    if (!inside) continue
    const span = /`([^`\n]+)`/.exec(line)
    if (span === null) continue
    const command = (span[1] ?? '').trim()
    if (command.length > 0) return command
  }
  return null
}

/** The first of the three sources that names a command. */
export function resolveVerifyCommand(
  issueBody: string | null,
  settingsCommand: string | null,
): VerifyCommand {
  const fromIssue = issueBody === null ? null : verifyCommandOf(issueBody)
  if (fromIssue !== null) return { command: fromIssue, source: 'issue' }
  if (settingsCommand !== null && settingsCommand.trim().length > 0) {
    return { command: settingsCommand.trim(), source: 'settings' }
  }
  return { command: DEFAULT_VERIFY_COMMAND, source: 'default' }
}

/** A source, as a notice names it. */
export function describeSource(source: VerifySource): string {
  switch (source) {
    case 'issue':
      return 'from the attached issue'
    case 'settings':
      return 'from the settings'
    case 'default':
      return 'the default'
  }
}

/**
 * The real runner: the command through the user's shell, as `npm run gate`
 * is typed in a terminal, with the cockpit's environment. stdout and stderr
 * are kept in the order they arrive. The user owns the process the way they
 * own a terminal: nothing here is sandboxed, and nothing here is the agent.
 */
export function runCheckInShell(command: string, cwd: string): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const chunks: string[] = []
    let kept = 0
    const take = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      chunks.push(text)
      kept += text.length
      while (kept > OUTPUT_LIMIT && chunks.length > 1) {
        kept -= chunks.shift()?.length ?? 0
      }
    }
    let settled = false
    const settle = (outcome: CheckOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (error) => {
      settle({ exitCode: null, signal: null, output: `${chunks.join('')}${error.message}\n` })
    })
    child.on('close', (code, signal) => {
      settle({ exitCode: code, signal, output: chunks.join('') })
    })
  })
}

export interface VerifierOptions {
  /** Where the check runs: the folder the cockpit was started in, the session's cwd. */
  readonly cwd: string
  /** The `verify` entry of the settings, or null. */
  readonly settingsCommand: string | null
  /** The body of the issue attached to the session, or null, read at each run. */
  readonly issueBody: () => string | null
  /** Injected by the tests; production runs the shell. */
  readonly run?: CheckRunner | undefined
  readonly now?: (() => number) | undefined
}

export class Verifier {
  private readonly options: VerifierOptions
  private readonly run: CheckRunner
  private readonly now: () => number
  private readonly listeners = new Set<AgentEventListener>()
  private current: VerifyCommand | null = null

  constructor(options: VerifierOptions) {
    this.options = options
    this.run = options.run ?? runCheckInShell
    this.now = options.now ?? (() => Date.now())
  }

  /** The session bridge subscribes: the notice and the evidence are shown and recorded like any event. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The check a run would start now, and where it comes from. */
  command(): VerifyCommand {
    return resolveVerifyCommand(this.options.issueBody(), this.options.settingsCommand)
  }

  /** The check in flight, or null. One at a time: a gate is minutes, and two would race. */
  get running(): VerifyCommand | null {
    return this.current
  }

  /**
   * Runs the check and resolves with the evidence once it ended. The notice
   * at the start says what runs and where it came from; the evidence block
   * carries the verdict.
   */
  async verify(): Promise<AgentEvidenceEvent> {
    if (this.current !== null) {
      throw new CommandError(`A check is already running: ${this.current.command}`)
    }
    const check = this.command()
    this.current = check
    this.emit({
      type: 'notice',
      text: `Verifying: ${check.command} (${describeSource(check.source)})`,
    })
    const startedAt = this.now()
    try {
      const outcome = await this.run(check.command, this.options.cwd)
      const evidence: AgentEvidenceEvent = {
        type: 'evidence',
        command: check.command,
        source: check.source,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: Math.max(0, this.now() - startedAt),
        output: outcome.output,
      }
      this.emit(evidence)
      return evidence
    } finally {
      this.current = null
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
