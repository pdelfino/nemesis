/**
 * The diff vocabulary shared by the main process and the renderer (#68).
 *
 * Reviewing what the agent changed is most of the human's job. Every Edit
 * and Write tool call the session makes is a diff: the old and the new text
 * come from the tool call's own arguments, since the SDK has already applied
 * the change by the time the cockpit sees the call. The main process keeps
 * the list and opens one in a `diff` buffer; the renderer draws it with
 * CodeMirror's merge view. There is no accept or reject here: gating an edit
 * before it happens is the permission path (#55).
 */

/** One Edit or Write tool call, as a diff. The texts are data, never instructions. */
export interface SessionDiff {
  /** The tool use id the call was made under; what the palette answers with. */
  readonly id: string
  /** 1 for the first diff of the session. */
  readonly index: number
  readonly tool: 'Edit' | 'Write'
  readonly filePath: string
  /** Empty for a Write: the call carries the whole new file, not what it replaced. */
  readonly oldText: string
  readonly newText: string
}

/** A diff buffer has content: pushed when a diff is opened in one. */
export interface DiffContent {
  readonly bufferId: string
  readonly diff: SessionDiff
}

/** The main process pushes the content of a diff buffer. */
export const DIFF_SHOWN_CHANNEL = 'nemesis:diff-shown' as const
