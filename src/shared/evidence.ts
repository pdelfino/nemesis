/**
 * Evidence (#81): the guide's "show evidence rather than asserting success".
 * Two things count as evidence in the cockpit: what the `verify` key ran, the
 * check with the user's permissions outside the agent's tool path, and a
 * tool result of the agent's own that reads like a test or build run. Both
 * are shown as one kind of block, folded, with the status in the header, so
 * a reviewer reads the exit code first and the output on demand.
 *
 * Pure: the transcript in the window and the Org file on disk share these,
 * so the two renderings agree on what is evidence and how it is headed.
 */

/** The tool whose output can be evidence: the agent runs checks through it. */
const SHELL_TOOL = 'Bash'

/**
 * A command that runs a check: a package script, a test runner, a build or
 * a linter. The words are the common ones; a project with its own names
 * still gets evidence blocks when the output reads like a run (below).
 */
const CHECK_COMMAND =
  /(^|[\s;&|(])(npm|pnpm|yarn|bun|npx|make|cargo|go|pytest|vitest|jest|mocha|playwright|tsc|eslint|prettier|mvn|gradle|dotnet|mix|rspec|rake|bundle|lein|clojure|clj|python3?|node|just)\b[^\n]*\b(test|tests|build|gate|lint|typecheck|check|verify|ci|compile|spec)\b/

/** Output that reads like a test runner, a compiler or a linter spoke. */
const CHECK_OUTPUT =
  /(\b\d+ (passed|failed|passing|failing|pending|skipped|errors?|warnings?)\b|^\s*(PASS|FAIL|ok|FAILED|ERROR)\b|\bTests?:\s+\d+|\bTest Files\s+\d+|error TS\d+|\bexit code:? \d+)/im

/** The exit code a tool result names, as the CLI's shell tool spells it; null when it names none. */
const EXIT_CODE = /\bexit code:? (\d+)\b/i

/** True when a tool call and its result are a check worth reading as evidence. */
export function looksLikeEvidence(
  toolName: string,
  command: string | null,
  output: string,
): boolean {
  if (toolName !== SHELL_TOOL) return false
  if (command !== null && CHECK_COMMAND.test(command)) return true
  return CHECK_OUTPUT.test(output)
}

/** The exit code a tool result's text names, when it does. */
export function exitCodeIn(output: string): number | null {
  const match = EXIT_CODE.exec(output)
  if (match === null) return null
  const code = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(code) ? code : null
}

/** One line of a command, cut so a header stays a header. */
const COMMAND_LENGTH = 72

export function shortCommand(command: string): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > COMMAND_LENGTH ? `${line.slice(0, COMMAND_LENGTH - 3)}...` : line
}

/**
 * The header of an evidence block from a tool result: the command, then
 * what it came to. The exit code when the result names one, else whether
 * the tool reported an error.
 */
export function toolEvidenceHeader(
  command: string | null,
  output: string,
  isError: boolean,
): string {
  const code = exitCodeIn(output)
  const status = code !== null ? `exit ${code}` : isError ? 'failed' : 'passed'
  return `Evidence: ${shortCommand(command ?? SHELL_TOOL)} (${status})`
}

/** What the check ran by the `verify` key came to. */
export interface CheckStatus {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
}

/** `exit 0, 1.2s`; `signal SIGTERM, 0.4s`; `did not run, 0.0s` when it could not start. */
export function describeCheckStatus(status: CheckStatus): string {
  const seconds = `${(status.durationMs / 1000).toFixed(1)}s`
  if (status.exitCode !== null) return `exit ${status.exitCode}, ${seconds}`
  if (status.signal !== null) return `signal ${status.signal}, ${seconds}`
  return `did not run, ${seconds}`
}

/** The header of an evidence block from the `verify` key. */
export function checkEvidenceHeader(command: string, status: CheckStatus): string {
  return `Evidence: ${shortCommand(command)} (${describeCheckStatus(status)})`
}
