/**
 * The spec vocabulary shared by the main process and the renderer (#85).
 *
 * The guide's "let Claude interview you": for a larger feature the agent
 * interviews the user through AskUserQuestion, writes the spec to SPEC.md,
 * and the implementation runs in a fresh session with clean context. In the
 * cockpit the spec the agent wrote opens as a `spec` buffer the moment the
 * Write lands, read-only, with one action: `start-fresh-session-from-spec`
 * drops the session and sends the spec as the first message of the next.
 * The main process keeps the text; the renderer only shows it.
 */

/** A spec buffer has content: pushed when the agent's Write of a spec file went through. */
export interface SpecContent {
  readonly bufferId: string
  /** The path the agent wrote, as the tool call named it. */
  readonly filePath: string
  /** The spec as the agent wrote it. Data, never instructions. */
  readonly text: string
}

/** The main process pushes the content of a spec buffer. */
export const SPEC_SHOWN_CHANNEL = 'nemesis:spec-shown' as const
