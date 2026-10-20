import type { WebContents } from 'electron'
import { TRANSCRIPT_GOTO_CHANNEL } from '../../shared/agent'
import { DIFF_SHOWN_CHANNEL } from '../../shared/diff'
import { AGENTS_SHOWN_CHANNEL } from '../../shared/agents'
import { ENVIRONMENT_SHOWN_CHANNEL } from '../../shared/environment'
import { PLAN_ANSWER_CHANNEL, PLAN_SHOWN_CHANNEL } from '../../shared/plan'
import { JOURNAL_CHANGED_CHANNEL, REPL_SHOWN_CHANNEL } from '../../shared/repl'
import { REVIEW_SHOWN_CHANNEL } from '../../shared/review'
import { SPEC_SHOWN_CHANNEL } from '../../shared/spec'
import {
  HELP_SHOWN_CHANNEL,
  PALETTE_ANSWER_CHANNEL,
  PALETTE_OPEN_CHANNEL,
} from '../../shared/palette'
import type { DiffBuffers } from '../diffs'
import type { AgentsBuffers } from '../agents'
import type { EnvironmentBuffers } from '../environment'
import type { HelpBuffers } from '../help'
import { handleIn } from '../ipc'
import { parsePlanAnswer, type PlanBuffers } from '../plans'
import type { Repl } from '../repl'
import type { ReviewBuffers } from '../reviews'
import type { Journal } from '../config/journal'
import type { ReaderBuffers } from '../pages/reader'
import type { SpecBuffers } from '../specs'
import type { TranscriptSearch } from '../transcript-search'
import { parsePaletteAnswer, type Prompter } from './prompter'

/**
 * The palette meets the window here (#65). A read the prompter starts is
 * pushed to the window, which answers through `handle()`, so the sender and
 * the shape are validated first (SECURITY.org, T1; #53); the text of the
 * help buffer goes out the same way, and so do the line a search match
 * sends the transcript's point to (#69), the content of a diff buffer (#68)
 * and the content of a plan buffer, whose approval or rejection comes back
 * with the text as edited (#82), and the content of a spec buffer (#85),
 * and the content of the environment buffer (#86), and the log of the
 * `*repl*` buffer and the journal's count (#72), and the content of a
 * review buffer (#87).
 * One bridge per window, as in the other bridges (#70): the pushes go to
 * that window only, and its answers reach its own prompter and plans.
 */
export interface PaletteBridgeOptions {
  /** The window the bridge serves. */
  readonly contents: WebContents
  readonly prompter: Prompter
  readonly help: HelpBuffers
  readonly transcripts: TranscriptSearch
  readonly diffs: DiffBuffers
  readonly plans: PlanBuffers
  readonly specs: SpecBuffers
  readonly reviews: ReviewBuffers
  readonly environment: EnvironmentBuffers
  /** Every window's session, as the `agents` buffer shows it (#157). */
  readonly agents?: AgentsBuffers
  readonly repl: Repl
  /** Null under `--no-config`: the count stays blank. */
  readonly journal: Journal | null
  /**
   * Reader mode's buffers (#128): their text goes out on the help push, keyed
   * by the reader buffer's id, so reader mode needs no channel of its own.
   */
  readonly readers?: ReaderBuffers
  /** Runs a cleanup once, when the window goes: the cockpit's one hook (#136). */
  readonly onDestroyed: (dispose: () => void) => void
}

export function installPaletteBridge(options: PaletteBridgeOptions): void {
  const {
    contents,
    prompter,
    help,
    transcripts,
    diffs,
    plans,
    specs,
    reviews,
    environment,
    agents,
    repl,
    journal,
    readers,
    onDestroyed,
  } = options
  const send = (channel: string, payload: unknown): void => {
    if (!contents.isDestroyed()) contents.send(channel, payload)
  }
  prompter.on((request) => send(PALETTE_OPEN_CHANNEL, request))
  help.on((content) => send(HELP_SHOWN_CHANNEL, content))
  transcripts.on((target) => send(TRANSCRIPT_GOTO_CHANNEL, target))
  diffs.onShown((content) => send(DIFF_SHOWN_CHANNEL, content))
  plans.onShown((content) => send(PLAN_SHOWN_CHANNEL, content))
  specs.onShown((content) => send(SPEC_SHOWN_CHANNEL, content))
  reviews.onShown((content) => send(REVIEW_SHOWN_CHANNEL, content))
  environment.onShown((content) => send(ENVIRONMENT_SHOWN_CHANNEL, content))
  const offAgents = agents?.onShown((content) => send(AGENTS_SHOWN_CHANNEL, content))
  if (offAgents !== undefined) onDestroyed(offAgents)
  repl.onShown((content) => send(REPL_SHOWN_CHANNEL, content))
  readers?.onShown(({ bufferId, text }) => send(HELP_SHOWN_CHANNEL, { bufferId, text }))
  // The journal is the app's, not the window's: its subscription goes with the window.
  const offJournal = journal?.on((unpromoted) => send(JOURNAL_CHANGED_CHANNEL, { unpromoted }))
  if (offJournal !== undefined) onDestroyed(offJournal)

  handleIn(contents, PALETTE_ANSWER_CHANNEL, parsePaletteAnswer, (answer) =>
    prompter.answer(answer),
  )
  handleIn(contents, PLAN_ANSWER_CHANNEL, parsePlanAnswer, (answer) => plans.answer(answer))
}
