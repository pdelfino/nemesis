/**
 * The palette vocabulary shared by the main process and the renderer (#65).
 *
 * The palette is the seed of the Nyxt prompt buffer: one fuzzy prompt over
 * everything. The main process owns the sources (the commands, the buffers;
 * sessions, URLs and history later) and asks the window to read a choice; the
 * renderer shows the candidates, ranks them as the query grows and answers
 * with the id of the one the user picked, or null for `C-g`. The ranking is
 * here, pure, so the unit tests run it without a window.
 */

/** One thing the user can pick. `doc` is the line shown for the highlighted entry. */
export interface PaletteCandidate {
  /** What the renderer answers with: a command name, a buffer id. */
  readonly id: string
  readonly label: string
  readonly doc: string
  /** A short note beside the label: the keys that run a command, for example. */
  readonly detail?: string
}

/** The main process wants a choice. Pushed to the window when a read starts. */
export interface PaletteRequest {
  readonly id: string
  /** Which source the candidates came from: `commands`, `buffers`. */
  readonly source: string
  /** The words before the query: `M-x`, `Describe command:`. */
  readonly prompt: string
  readonly candidates: readonly PaletteCandidate[]
  /**
   * The read takes the text typed as well (#69): `RET` answers with the
   * query when it matches no candidate, so a source may list nothing and
   * the doc line says what `RET` does.
   */
  readonly freeText?: true
  /**
   * The read takes several (#167): the window marks candidates and answers
   * with every marked id, or the highlighted one when nothing is marked.
   */
  readonly multiple?: true
}

/**
 * The window's answer: the candidate picked, the text typed on a free-text
 * read, or neither when the read was cancelled.
 */
export interface PaletteAnswer {
  readonly id: string
  readonly choice: string | null
  readonly text?: string
  /** The marked ids of a `multiple` read (#167), in the source's order; `choice` is null then. */
  readonly ids?: readonly string[]
}

/** More marked candidates than this is not an answer; the palette shows far fewer. */
export const MAX_MARKED = 500

/** The glyph before a marked candidate, and the note in the prompt line. */
export const MARK_GLYPH = '●'

/** The doc line of a free-text read while no candidate is highlighted. */
export const FREE_TEXT_DOC = 'RET answers with the text typed.'

/**
 * What the main process did with the answer. `command` names a command the
 * palette ran, so the renderer can act on it the way it acts on a command a
 * key ran (`send-prompt`, `search-buffer`).
 */
export interface PaletteOutcome {
  readonly command?: string
}

/** The text of a help buffer, pushed when describe-command or describe-key answers. */
export interface HelpContent {
  readonly bufferId: string
  readonly text: string
}

/** The main process pushes a read; the renderer opens the palette. */
export const PALETTE_OPEN_CHANNEL = 'nemesis:palette-open' as const
/** The renderer answers a read, with a candidate id or null. */
export const PALETTE_ANSWER_CHANNEL = 'nemesis:palette-answer' as const
/** The main process pushes the text of the help buffer. */
export const HELP_SHOWN_CHANNEL = 'nemesis:help-shown' as const

/** A query longer than this matches nothing rather than being scanned. */
export const MAX_QUERY_LENGTH = 200

/** Where a word starts inside a label: after one of these, or at the start. */
const WORD_BREAKS = new Set(['-', ' ', '/', ':', '.', '_'])

/**
 * How well `query` matches `text`, or null when it does not. Every character
 * of the query must appear in the text in order; a run of adjacent matches and
 * a match at the start of a word score higher, and a text that starts with the
 * query higher still. An empty query matches everything equally.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  if (needle.length === 0) return 0
  if (needle.length > MAX_QUERY_LENGTH) return null

  let score = 0
  let position = 0
  let previous = -2
  for (const character of needle) {
    const index = haystack.indexOf(character, position)
    if (index === -1) return null
    if (index === previous + 1) score += 2
    else if (index === 0 || WORD_BREAKS.has(haystack[index - 1] ?? '')) score += 3
    else score += 1
    previous = index
    position = index + 1
  }
  if (haystack.startsWith(needle)) score += 5
  if (haystack === needle) score += 10
  return score
}

/**
 * The candidates that match, best first; ties go alphabetical by label. An
 * empty query keeps the source's own order, which is the order that means
 * something there (the buffers in creation order, for one).
 */
export function rankCandidates<T extends PaletteCandidate>(
  query: string,
  candidates: readonly T[],
): T[] {
  if (query.length === 0) return [...candidates]
  const scored: { candidate: T; score: number }[] = []
  for (const candidate of candidates) {
    const score = fuzzyScore(query, candidate.label)
    if (score !== null) scored.push({ candidate, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.candidate.label.localeCompare(b.candidate.label))
    .map((entry) => entry.candidate)
}
