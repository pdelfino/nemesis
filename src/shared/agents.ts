/**
 * The agents vocabulary shared by the main process and the renderer (#157).
 *
 * Each window runs one session (#70), and the `agents` buffer shows every
 * window's session on one screen: which window, which session, which folder,
 * and what state it is in. The main process tracks the state off each
 * session's events, the way the attention stream does (#90), keeping counts
 * and times only, and renders the text; the renderer only shows it.
 */

/** What a session is doing, as the `agents` buffer names it. */
export type AgentState = 'idle' | 'working' | 'waits on you' | 'finished' | 'error'

/** The `agents` buffer has content: pushed when it is shown and on every change while open. */
export interface AgentsContent {
  readonly bufferId: string
  /** The list as rendered text: names, folders, states, counts and times. Never transcript text. */
  readonly text: string
}

/** The main process pushes the content of the `agents` buffer. */
export const AGENTS_SHOWN_CHANNEL = 'nemesis:agents-shown' as const
