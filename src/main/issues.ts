import { execFile } from 'node:child_process'
import type { AgentEvent, AgentEventListener } from './agent/events'
import { CommandError } from './commands/registry'
import { verifyCommandOf } from './verify'

/**
 * The GitHub issue attached to the session (#81). Every unit of work in this
 * repository is an issue with a Verify section, so the session can be told
 * which issue it works, and the `verify` key runs that issue's check first.
 * `attach-issue` reads a number, fetches the issue through the `gh` CLI, the
 * user's own login and permissions, and keeps the body in memory; nothing
 * of it is written to disk, and the agent never sees it unless the user
 * sends it. The notice says what the Verify section names, so the key that
 * runs it is pressed knowing the command.
 *
 * Plain data, no Electron: the unit tests drive it with a fake fetcher.
 */

/** What is kept of an issue: its number, its title for the notices, its body for the Verify section. */
export interface AttachedIssue {
  readonly number: number
  readonly title: string
  readonly body: string
}

/** Fetches one issue of the repository in `cwd`. Rejects with a message safe to show. */
export type IssueFetcher = (number: number, cwd: string) => Promise<AttachedIssue>

/** An issue number as typed: digits, a leading `#` allowed. */
const ISSUE_NUMBER = /^#?(\d{1,8})$/

/** The number of an issue as typed at the palette, or a CommandError that says what was expected. */
export function parseIssueNumber(text: string): number {
  const match = ISSUE_NUMBER.exec(text.trim())
  const number = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10)
  if (!Number.isFinite(number) || number <= 0) {
    throw new CommandError(`Not an issue number: ${text.trim()}`)
  }
  return number
}

/** The issue as `gh issue view --json number,title,body` prints it. Shape only, no trust. */
export function parseIssueJson(text: string): AttachedIssue {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CommandError('gh did not answer with JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CommandError('gh answered oddly')
  const value = parsed as Record<string, unknown>
  const number = value['number']
  const title = value['title']
  const body = value['body']
  if (typeof number !== 'number' || typeof title !== 'string' || typeof body !== 'string') {
    throw new CommandError('gh answered without number, title and body')
  }
  return { number, title, body }
}

/**
 * The real fetcher: the `gh` CLI in the session's folder, which infers the
 * repository from its git remote, as the user would type it. No shell: the
 * number is an argument, never part of a command line.
 */
export function fetchIssueWithGh(number: number, cwd: string): Promise<AttachedIssue> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['issue', 'view', String(number), '--json', 'number,title,body'],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim().split('\n')[0] ?? ''
          reject(new CommandError(`gh could not fetch #${number}: ${detail || error.message}`))
          return
        }
        try {
          resolve(parseIssueJson(stdout))
        } catch (failure) {
          reject(failure instanceof Error ? failure : new Error(String(failure)))
        }
      },
    )
  })
}

export interface IssueAttachmentOptions {
  readonly cwd: string
  /** Injected by the tests; production runs `gh`. */
  readonly fetch?: IssueFetcher | undefined
}

export class IssueAttachment {
  private readonly options: IssueAttachmentOptions
  private readonly fetch: IssueFetcher
  private readonly listeners = new Set<AgentEventListener>()
  private issue: AttachedIssue | null = null

  constructor(options: IssueAttachmentOptions) {
    this.options = options
    this.fetch = options.fetch ?? fetchIssueWithGh
  }

  /** The session bridge subscribes: the notice is shown and recorded like any event. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The issue attached to the session, or null. */
  get current(): AttachedIssue | null {
    return this.issue
  }

  /**
   * Fetches the issue and makes it the session's. The notice names the
   * check its Verify section carries, or says it carries none, so the
   * verify key is never a surprise.
   */
  async attach(text: string): Promise<AttachedIssue> {
    const number = parseIssueNumber(text)
    const issue = await this.fetch(number, this.options.cwd)
    this.issue = issue
    const command = verifyCommandOf(issue.body)
    const check =
      command === null
        ? 'its Verify section names no command, so C-c C-v runs the settings or the default check'
        : `C-c C-v runs its check: ${command}`
    this.notify(`Attached issue #${issue.number}: ${issue.title}. ${check}.`)
    return issue
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}
