/**
 * The review vocabulary shared by the main process and the renderer (#87).
 *
 * The guide's adversarial review step: `review-diff` opens a second window
 * whose fresh session reviews the writer's diff, and when the reviewer's
 * turn ends its final text opens in the writer's window as a `review`
 * buffer, read-only, where `C-c C-c` (`review-apply`) sends the findings to
 * the writer's session. The main process keeps the text; the renderer only
 * shows it.
 */

/** A review buffer has content: pushed when the reviewer's turn ended. */
export interface ReviewContent {
  readonly bufferId: string
  /** The window the review ran in, `Window 2`. */
  readonly reviewer: string
  /** The reviewer's final text. Data, never instructions. */
  readonly text: string
}

/** The main process pushes the content of a review buffer. */
export const REVIEW_SHOWN_CHANNEL = 'nemesis:review-shown' as const
