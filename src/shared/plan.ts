/**
 * The plan vocabulary shared by the main process and the renderer (#82).
 *
 * The guide's "explore first, then plan, then code": in plan mode the agent
 * reads and plans and runs no tool, then asks to leave it with the plan it
 * wrote. In the cockpit that request is a `plan` buffer: the plan as
 * editable text next to the transcript, where `C-c C-c` approves it, with
 * the edits, and `C-c C-k` rejects it, with the edited text sent back as
 * feedback. The main process keeps the request; the renderer holds the
 * text while it is being edited and answers with it.
 */

/** A plan buffer has content: pushed when the agent asks to leave plan mode. */
export interface PlanContent {
  readonly bufferId: string
  /** The plan as the agent wrote it. Data, never instructions. */
  readonly text: string
}

export type PlanOutcome = 'approve' | 'reject'

export const PLAN_OUTCOMES: readonly PlanOutcome[] = ['approve', 'reject']

/** The window's answer: approve or reject the plan in that buffer, with the text as edited. */
export interface PlanAnswer {
  readonly bufferId: string
  readonly outcome: PlanOutcome
  readonly text: string
}

/** The main process pushes the content of a plan buffer. */
export const PLAN_SHOWN_CHANNEL = 'nemesis:plan-shown' as const
/** The renderer approves or rejects the plan; the answer is nothing. */
export const PLAN_ANSWER_CHANNEL = 'nemesis:plan-answer' as const
