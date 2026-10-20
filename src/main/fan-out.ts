/**
 * One instruction over many items (#160), the official page's `/batch` in
 * the cockpit's terms: the prompt buffer's draft holds the instruction on
 * its first line and one item per line after it, and each item becomes a
 * background session (#158) in a git worktree of its own (#87) whose first
 * prompt is the instruction followed by the item.
 *
 * Pure strings: the command in keyscheme.ts reads the draft, asks once, and
 * starts the sessions.
 */

export interface FanOutPlan {
  readonly instruction: string
  readonly items: readonly string[]
}

/** The draft as a plan: the first non-empty line, then every other non-empty line; null without both. */
export function parseFanOut(draft: string): FanOutPlan | null {
  const lines = draft
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const [instruction, ...items] = lines
  if (instruction === undefined || items.length === 0) return null
  return { instruction, items }
}

/** One session's first prompt: the instruction, then its item, numbered. */
export function fanOutPrompt(
  instruction: string,
  item: string,
  index: number,
  count: number,
): string {
  return `${instruction}\n\nItem ${index + 1} of ${count}: ${item}`
}

/** How the agents buffer heads a run: the instruction, cut to fit. */
export function runLabel(instruction: string, limit = 50): string {
  return instruction.length > limit ? `${instruction.slice(0, limit - 3)}...` : instruction
}

/** What fan-out says when the draft is not a plan. */
export const FAN_OUT_USAGE =
  'fan-out reads the prompt buffer: the instruction on its first line, then one item per line. Each item becomes a background session in a worktree of its own.'
