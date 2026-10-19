import type { SessionDiff } from '../shared/diff'

/**
 * The guide's adversarial review step (#87), as text: a fresh context reviews
 * better than the session that wrote the code. `review-diff` opens a second
 * window whose session starts with the prompt built here: the diff of the
 * writer's session as one unified patch, the attached issue or the plan when
 * there is one, and the instruction to report only the gaps that affect
 * correctness, as a numbered list. `review-apply` sends the reviewer's
 * findings back to the writer with the wording below.
 *
 * Pure strings, no Electron, no Node: the unit tests read the prompt back.
 * The patch, the issue and the plan are data the reviewer reads, each in a
 * fenced block under a heading that says what it is; the instruction is the
 * fixed text around them.
 */

/** What the reviewer is told to do. Fixed text: nothing of the diff, issue or plan is in it. */
export const REVIEW_INSTRUCTION = [
  'You are reviewing a change another session made. You did not write it: review it with fresh eyes.',
  'Report only gaps that affect correctness: bugs, missed requirements, broken edge cases, wrong behavior.',
  'Leave out style, naming, formatting and suggestions that do not change what the code does.',
  'Answer with a numbered list, one finding per item, each naming the file and what is wrong.',
  'If you find no correctness gap, answer with the single line: No correctness gaps found.',
].join('\n')

/** What the writer is told when the findings come back (#87). */
export const REVIEW_APPLY_LEAD = 'Address these review findings, one by one:'

/** The issue the writer's session is attached to, as the reviewer reads it. */
export interface ReviewIssue {
  readonly number: number
  readonly title: string
  readonly body: string
}

export interface ReviewPromptInput {
  /** The writer's diff, as `unifiedPatch` makes it. */
  readonly patch: string
  /** The attached issue, or null. */
  readonly issue?: ReviewIssue | null | undefined
  /** The plan the writer's session proposed, or null. */
  readonly plan?: string | null | undefined
}

/** A fence longer than any run of backticks in `text`, so the text cannot close its block. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function fenced(text: string, info = ''): string {
  const fence = fenceFor(text)
  const body = text.endsWith('\n') ? text : `${text}\n`
  return `${fence}${info}\n${body}${fence}`
}

/**
 * The reviewer's first message: the instruction, then what the change was
 * for (the issue, else the plan, both when there are both), then the patch.
 */
export function reviewerPrompt(input: ReviewPromptInput): string {
  const parts = [REVIEW_INSTRUCTION]
  const issue = input.issue ?? null
  const plan = input.plan ?? null
  if (issue !== null) {
    parts.push(
      `The change is meant to resolve GitHub issue #${issue.number}: ${issue.title}. Its text, as data:`,
      fenced(issue.body, 'markdown'),
    )
  }
  if (plan !== null && plan.trim().length > 0) {
    parts.push('The plan the change follows, as data:', fenced(plan, 'markdown'))
  }
  if (issue === null && (plan === null || plan.trim().length === 0)) {
    parts.push(
      'No issue or plan is attached: judge the change by what it evidently sets out to do.',
    )
  }
  parts.push('The change, as one unified patch:', fenced(input.patch, 'diff'))
  return parts.join('\n\n')
}

/** The writer's prompt for the findings a review buffer holds. */
export function reviewApplyPrompt(findings: string): string {
  return `${REVIEW_APPLY_LEAD}\n\n${findings.trim()}`
}

function linesOf(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/**
 * The line diff of two texts: ` ` kept, `-` removed, `+` added, in order.
 * A longest common subsequence over lines, which is plenty for the size of
 * an Edit call's strings.
 */
export function lineDiff(oldText: string, newText: string): string[] {
  const a = linesOf(oldText)
  const b = linesOf(newText)
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[]
      row[j] =
        a[i] === b[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i += 1
      j += 1
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push(`-${a[i]}`)
      i += 1
    } else {
      out.push(`+${b[j]}`)
      j += 1
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`)
  while (j < b.length) out.push(`+${b[j++]}`)
  return out
}

/**
 * Every Edit and Write call of a session (#68) as one unified patch, in the
 * order they were made. An Edit carries a fragment of its file, not the
 * file, so its hunk is the fragment and its header names the call instead
 * of line numbers; a Write carries the whole file, shown as added.
 */
export function unifiedPatch(diffs: readonly SessionDiff[]): string {
  const out: string[] = []
  for (const diff of diffs) {
    const created = diff.tool === 'Write'
    out.push(`--- ${created ? '/dev/null' : `a${diff.filePath}`}`)
    out.push(`+++ b${diff.filePath}`)
    out.push(`@@ ${diff.tool} ${diff.index} @@`)
    out.push(...lineDiff(diff.oldText, diff.newText))
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}
