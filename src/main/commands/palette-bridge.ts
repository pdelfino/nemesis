import { BrowserWindow } from 'electron'
import { TRANSCRIPT_GOTO_CHANNEL } from '../../shared/agent'
import { DIFF_SHOWN_CHANNEL } from '../../shared/diff'
import { ENVIRONMENT_SHOWN_CHANNEL } from '../../shared/environment'
import { PLAN_ANSWER_CHANNEL, PLAN_SHOWN_CHANNEL } from '../../shared/plan'
import { JOURNAL_CHANGED_CHANNEL, REPL_SHOWN_CHANNEL } from '../../shared/repl'
import { SPEC_SHOWN_CHANNEL } from '../../shared/spec'
import {
  HELP_SHOWN_CHANNEL,
  PALETTE_ANSWER_CHANNEL,
  PALETTE_OPEN_CHANNEL,
} from '../../shared/palette'
import type { DiffBuffers } from '../diffs'
import type { EnvironmentBuffers } from '../environment'
import type { HelpBuffers } from '../help'
import { handle } from '../ipc'
import { parsePlanAnswer, type PlanBuffers } from '../plans'
import type { Repl } from '../repl'
import type { Journal } from '../config/journal'
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
 * `*repl*` buffer and the journal's count (#72).
 * One window in M1, as in the other bridges.
 */
export interface PaletteBridgeOptions {
  readonly prompter: Prompter
  readonly help: HelpBuffers
  readonly transcripts: TranscriptSearch
  readonly diffs: DiffBuffers
  readonly plans: PlanBuffers
  readonly specs: SpecBuffers
  readonly environment: EnvironmentBuffers
  readonly repl: Repl
  /** Null under `--no-config`: the count stays blank. */
  readonly journal: Journal | null
}

export function installPaletteBridge(options: PaletteBridgeOptions): void {
  const { prompter, help, transcripts, diffs, plans, specs, environment, repl, journal } = options
  prompter.on((request) => broadcast(PALETTE_OPEN_CHANNEL, request))
  help.on((content) => broadcast(HELP_SHOWN_CHANNEL, content))
  transcripts.on((target) => broadcast(TRANSCRIPT_GOTO_CHANNEL, target))
  diffs.onShown((content) => broadcast(DIFF_SHOWN_CHANNEL, content))
  plans.onShown((content) => broadcast(PLAN_SHOWN_CHANNEL, content))
  specs.onShown((content) => broadcast(SPEC_SHOWN_CHANNEL, content))
  environment.onShown((content) => broadcast(ENVIRONMENT_SHOWN_CHANNEL, content))
  repl.onShown((content) => broadcast(REPL_SHOWN_CHANNEL, content))
  journal?.on((unpromoted) => broadcast(JOURNAL_CHANGED_CHANNEL, { unpromoted }))

  handle(PALETTE_ANSWER_CHANNEL, parsePaletteAnswer, (answer) => prompter.answer(answer))
  handle(PLAN_ANSWER_CHANNEL, parsePlanAnswer, (answer) => plans.answer(answer))
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
