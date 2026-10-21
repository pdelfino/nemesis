/**
 * The context meter (#80), pure: the numbers of a `context-usage` event as
 * the mode line shows them. The guide's one constraint is that performance
 * degrades as the window fills, and it names no number; the cockpit steps
 * the color at CONTEXT_WARN_PERCENT, where the next turn should be a clear
 * or a compact rather than more of the same, and again near the top. Both
 * are constants here, so the step moves in one place.
 */

/** Past this fill the meter changes color: time to clear or compact. */
export const CONTEXT_WARN_PERCENT = 70
/** Past this the window is nearly full: the CLI would compact on its own soon. */
export const CONTEXT_FULL_PERCENT = 90

/** How many cells the bar has. */
const BAR_CELLS = 10

export type ContextLevel = 'ok' | 'high' | 'full'

export interface ContextMeter {
  /** `150k/200k 75% ████████░░` */
  readonly text: string
  readonly percent: number
  readonly level: ContextLevel
}

/** Tokens as people say them: `850`, `1.5k`, `150k`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  const thousands = tokens / 1000
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : String(Math.round(thousands))}k`
}

export function levelOf(percent: number): ContextLevel {
  if (percent >= CONTEXT_FULL_PERCENT) return 'full'
  return percent >= CONTEXT_WARN_PERCENT ? 'high' : 'ok'
}

export function describeContext(usedTokens: number, windowTokens: number): ContextMeter {
  const percent = windowTokens > 0 ? Math.round((usedTokens / windowTokens) * 100) : 0
  const filled = Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS))
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
  return {
    text: `${formatTokens(usedTokens)}/${formatTokens(windowTokens)} ${percent}% ${bar}`,
    percent,
    level: levelOf(percent),
  }
}

/**
 * A cost as the mode line and the agents list show it (#191): `≈$0.42`, the
 * sign saying it is the SDK's estimate at list price, not a bill. Under a
 * cent it reads `<$0.01`, so a cheap turn does not look free.
 */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `≈$${usd.toFixed(2)}`
}

/** The tooltip on the cost: what the number is, and the last turn's share of it. */
export function describeCost(costUsd: number, turnCostUsd: number): string {
  return `Session cost so far: $${costUsd.toFixed(4)}, the SDK's estimate at list price. Last turn: $${turnCostUsd.toFixed(4)}.`
}
