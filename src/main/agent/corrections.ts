/**
 * The correction counter (#80). The guide's failure pattern "correcting over
 * and over": after two failed corrections the context is polluted with the
 * failed approaches, and a fresh session with a better prompt beats one more
 * correction. The cockpit counts consecutive corrections and says so in the
 * mode line at the second, instead of leaving it to be remembered.
 *
 * A correction is a user turn that starts with "no" or "wrong", or one the
 * user marked with the `correct` command. A turn that is neither ends the
 * streak. Pure, no session: the manager feeds it the user turns.
 */

/** A turn that opens with one of these words is a correction. */
const CORRECTION_OPENING = /^\s*(no|wrong)\b/i

/** The streak at which the mode line nudges. */
export const NUDGE_AFTER = 2

export function isCorrection(text: string): boolean {
  return CORRECTION_OPENING.test(text)
}

/** The mode line's text for a streak the guide says to break with a clear. */
export function nudgeText(streak: number): string {
  return `${streak} corrections in a row: clear (C-c C-l) and start over with a better prompt that says what you learned.`
}

export class CorrectionCounter {
  private streakValue = 0
  /** `correct` counted the next turn already, whatever its first word. */
  private marked = false

  /** Consecutive corrections so far. */
  get streak(): number {
    return this.streakValue
  }

  /** A user turn was sent. Answers the streak it leaves. */
  observe(text: string): number {
    if (this.marked) {
      this.marked = false
      return this.streakValue
    }
    this.streakValue = isCorrection(text) ? this.streakValue + 1 : 0
    return this.streakValue
  }

  /** The `correct` command: the next turn is a correction, said in advance. */
  mark(): number {
    this.marked = true
    this.streakValue += 1
    return this.streakValue
  }

  /** A fresh session starts the count over. */
  reset(): void {
    this.streakValue = 0
    this.marked = false
  }
}
