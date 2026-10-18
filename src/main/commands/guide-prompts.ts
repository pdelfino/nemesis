/**
 * The prompts the guide tells people to write and people forget (#85), as
 * the three commands send them. The words are the guide's own, from the
 * sections "Let Claude interview you" and "Use subagents for investigation"
 * of https://code.claude.com/docs/en/best-practices, so what the agent
 * receives is what the guide was tested with. `ask-codebase` wraps nothing:
 * the guide says no special prompting is required for a codebase question,
 * and the command exists so the palette lists the three side by side.
 *
 * Pure strings, no Electron: the unit tests read them back.
 */

/** The guide's interview prompt, the one-line description in the place of `[brief description]`. */
export function interviewPrompt(description: string): string {
  const goal = oneLine(description)
  return [
    `I want to build ${goal}. Interview me in detail using the AskUserQuestion tool.`,
    '',
    "Ask about technical implementation, UI/UX, edge cases, concerns, and tradeoffs. Don't ask obvious questions, dig into the hard parts I might not have considered.",
    '',
    "Keep interviewing until we've covered everything, then write a complete spec to SPEC.md.",
  ].join('\n')
}

/** The guide's investigation prompt: the question, delegated to subagents so the research stays out of the main context. */
export function investigatePrompt(question: string): string {
  return `Use subagents to investigate ${question.trim()}`
}

/** The plain question, as typed. */
export function askCodebasePrompt(question: string): string {
  return question.trim()
}

/**
 * The first message of the fresh session the guide says to start once the
 * spec is written: the spec itself, after one line saying what it is. The
 * new session has no other context, which is the point.
 */
export function freshSessionPrompt(filePath: string, spec: string): string {
  return [
    `Implement the spec below. It was written to ${filePath} in an earlier session; this session has clean context for the implementation. End with the verification step the spec names.`,
    '',
    spec.trimEnd(),
  ].join('\n')
}

/**
 * A verification criterion for the prompt being composed (#81), after the
 * guide's own before and after: the example cases, input and expected
 * output, and the check to run after implementing, so the agent closes the
 * loop itself and shows the output rather than a summary.
 */
export function attachCheckPrompt(cases: string, check: string): string {
  return `Example cases: ${oneLine(cases)}. Run \`${oneLine(check)}\` after implementing, show its output, and iterate until it passes.`
}

/**
 * A screenshot in the prompt (#81): the path of the image the cockpit wrote
 * and what to do with it, the guide's "take a screenshot of the result and
 * compare it". The agent reads the file as an image through its Read tool.
 */
export function screenshotPrompt(windowName: string, filePath: string): string {
  return `Screenshot of the window "${oneLine(windowName)}" at ${filePath}: read it as an image and compare it with what was asked; list the differences.`
}

/** The description is one line in the prompt, whatever the palette gave. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
