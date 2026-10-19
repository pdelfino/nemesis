import { homedir } from 'node:os'
import { PermissionBridge } from '../agent/permission-bridge'
import { PromptQueue } from '../agent/prompt-queue'
import {
  describeCheckpoint,
  describeCheckpoints,
  describeRewindPreview,
  REWIND_TARGETS,
  rewindConversationQuestion,
  rewindFilesQuestion,
  SessionManager,
  turnsDropped,
  undoPrompt,
  type RewindTarget,
} from '../agent/session-manager'
import { wrapUntrusted } from '../agent/boundary'
import type { ClipboardReader } from '../agent/images'
import type { BufferRegistry } from '../buffers'
import type { BufferInfo } from '../../shared/buffers'
import { createCockpitBuffers } from '../buffers'
import { describeDiff, DiffBuffers } from '../diffs'
import { EnvironmentBuffers } from '../environment'
import { UrlFetcher } from '../fetch-url'
import { WorkingFiles } from '../files'
import { HelpBuffers } from '../help'
import { IssueAttachment } from '../issues'
import { PlanBuffers } from '../plans'
import { Repl } from '../repl'
import { Screenshots } from '../screenshots'
import { formatSessionDate, NO_SESSIONS, type SessionSource } from '../sessions'
import { SpecBuffers } from '../specs'
import { describeMatch, TranscriptSearch } from '../transcript-search'
import { sessionName } from '../transcripts'
import { describeSource, Verifier, verifyQuestion } from '../verify'
import type { KeymapLayer } from './describe'
import { bindingNote, describeCommand, describeKey } from './describe'
import type { BufferType } from '../../shared/keys'
import type { BufferKeymaps, Keymap } from './keymap'
import { defineKeymap, isShadowed, KeyResolver } from './keymap'
import { assertBindingsAreRegistered, KeyDispatcher, KeyReader } from './dispatcher'
import {
  askCodebasePrompt,
  attachCheckPrompt,
  freshSessionPrompt,
  interviewPrompt,
  investigatePrompt,
  PATTERN_TEMPLATE,
  screenshotPrompt,
  SYMPTOM_TEMPLATE,
} from './guide-prompts'
import { confirm, REWIND_SOURCE, VERIFY_SOURCE } from './confirm'
import { Prompter, type PaletteSource } from './prompter'
import type { Command } from './registry'
import { CommandError, CommandRegistry, defineCommand } from './registry'

/**
 * The default Emacs keyscheme for the cockpit (#59).
 *
 * Keymaps are data in a TypeScript module (option A on the issue): the user
 * config dir gets the same shape when the extension door opens in M3, so the
 * format is decided once, here, before the first binding.
 *
 * A command body stays empty until the surface it drives lands. #59 owns the
 * spine, the registry, the chord parser and the dispatch; the two buffer
 * commands act on the buffer registry they are given (#60), the answer
 * commands on the permission bridge (#63), and the palette commands read
 * their argument through the prompter and answer in the help buffer (#65).
 * The course corrections of the guide (#84) act on the session manager:
 * `C-g` interrupts the turn, `rewind` lists the checkpoints in the help
 * buffer and reads one and what to restore, `undo` sends the guide's "undo
 * that" with the last tool calls quoted, and `new-task` drops the session.
 * `resume-session` (#67) reads a past session off the sessions folder and
 * picks it up through the manager; `name-session` on `C-c C-n` (#104) reads
 * a name as free text and the manager records it as an event, so the list,
 * the window title and the mode line show it. `search-transcripts` (#69) reads a query
 * as free text, lists the matches of every transcript on disk, and opens
 * the session a match belongs to with the transcript's point on that line.
 * The guide's context management (#80): `clear` on `C-c C-l` is a fresh
 * session, `compact` on `C-c C-k` sends the prompt buffer as the compaction
 * instruction, `side-question` asks a throwaway fork and answers in the help
 * buffer, and `correct` counts the next prompt as a correction. The diffs
 * of the session (#68): `list-diffs` reads one Edit or Write off the palette
 * and opens it in a diff buffer, where `C-c C-o` is `open-diff-file`. The
 * guide's plan mode (#82): `toggle-plan-mode` on `C-c C-p` flips the
 * session's permission mode, and in the plan buffer the agent's plan opens
 * in, `C-c C-c` is `approve-plan` and `C-c C-k` is `reject-plan`, both
 * acted on by the renderer, which holds the text as edited. The guide's
 * communication practices (#85) are three named commands that read a line
 * and send a prompt: `ask-codebase` sends the question as typed,
 * `investigate` wraps it in the guide's "use subagents to investigate",
 * `interview` sends the guide's interview prompt; the spec the interview
 * ends with opens as a spec buffer, where `C-c C-c` is
 * `start-fresh-session-from-spec`. The guide's first practice, a check the
 * work is verified by (#81): `verify` on `C-c C-v` runs the attached
 * issue's Verify command, else the settings' `verify`, else `npm run gate`,
 * with the user's permissions, and the output lands as an evidence block;
 * `attach-issue` reads the issue number; `attach-check` adds a criterion to
 * the prompt, example cases and the check to run; `screenshot-window` puts
 * a window of the screen in the prompt as an image. The guide's specific,
 * rich prompts (#83): `complete-file`, on `@` at the start of a word in
 * the prompt buffer, reads a file of the working directory off the palette
 * and puts `@path` at the point; `attach-image` on `C-c C-i` takes the
 * image on the clipboard for the next prompt, a marker line in its place;
 * `fetch-url` on `C-c C-u` reads an https URL, the ones in the prompt as
 * candidates, and puts the page's text in the prompt wrapped as untrusted
 * content from its origin; `template-symptom` and `template-pattern` drop
 * the guide's two prompt shapes in to fill. The guide's environment (#86):
 * `environment` on `C-c C-e` shows the CLAUDE.md files, permission rules,
 * hooks, skills, MCP servers and subagents of the working directory in one
 * read-only buffer, where `RET` is `open-environment-file`, a listed file
 * through the open door of #68; `edit-claude-md` takes the nearest CLAUDE.md
 * through the same door with the guide's reminder, and `doctor` lists the
 * CLAUDE.md files over the length threshold. Eval in the config scope
 * (#72): `eval-expression` reads a form as free text and answers with a
 * notice, `repl` opens the `*repl*` buffer, where `RET` is `repl-read`, and
 * `journal-promote` and `journal-discard` read an entry of the eval journal
 * off the palette and move it to init.ts or delete it. Windows (#70):
 * `new-window` on `C-x 5 2` opens another window with its own session and
 * buffers, and `choose-buffer` lists every window's buffers, the others
 * named by window; choosing one of those brings its window forward.
 */

/** How many options a question may offer, per the AskUserQuestion schema. */
const QUESTION_OPTIONS = [1, 2, 3, 4] as const

/** What the commands act on. Every piece has a default, so a test can build one from nothing. */
export interface CockpitDeps {
  readonly buffers: BufferRegistry
  readonly permissions: PermissionBridge
  readonly prompter: Prompter
  readonly help: HelpBuffers
  /** Shared by `describe-key` and the dispatcher, which is built after the registry. */
  readonly keys: KeyReader
  /** The current agent session, and the way to replace it (#84). */
  readonly agent: SessionManager
  /**
   * Where a prompt a command composes goes, like one the user typed (#84),
   * or is added to (#81); where an image waits for the send and the draft
   * whose URLs `fetch-url` offers are read (#83).
   */
  readonly prompts: Pick<PromptQueue, 'submit' | 'insert' | 'attachImage' | 'draft'>
  /** The sessions folder, as `resume-session` lists and reads it (#67). */
  readonly sessions: SessionSource
  /** The transcripts on disk, as `search-transcripts` scans them (#69). */
  readonly transcripts: TranscriptSearch
  /** The Edit and Write calls of the session, as `list-diffs` opens them (#68). */
  readonly diffs: DiffBuffers
  /** The plans the agent asks to leave plan mode with, as plan buffers (#82). */
  readonly plans: PlanBuffers
  /** The specs the agent writes at the end of an interview, as spec buffers (#85). */
  readonly specs: SpecBuffers
  /** The check the verify key runs, and the evidence it produces (#81). */
  readonly verifier: Verifier
  /** The GitHub issue attached to the session, whose Verify section the check comes from (#81). */
  readonly issues: IssueAttachment
  /** The windows on the screen, as screenshot-window lists and captures them (#81). */
  readonly screenshots: Screenshots
  /** The files of the working directory, as `@` lists them (#83). */
  readonly files: WorkingFiles
  /** The clipboard, as attach-image reads an image off it (#83). */
  readonly clipboard: ClipboardReader
  /** The one fetch fetch-url makes, within its limits (#83). */
  readonly fetcher: UrlFetcher
  /** The environment of the working directory, as one buffer (#86). */
  readonly environment: EnvironmentBuffers
  /** Eval in the config scope, the `*repl*` buffer and the journal (#72). */
  readonly repl: Repl
  /** The other windows, as `new-window` opens one and the palette lists their buffers (#70). */
  readonly windows: CockpitWindows
}

/** A buffer of another window, as the palette's `buffers` source lists it (#70). */
export interface WindowBuffer {
  readonly windowId: number
  /** How the palette names the window, `Window 2`. */
  readonly windowName: string
  readonly buffer: BufferInfo
  /** Whether it is that window's current buffer. */
  readonly current: boolean
}

/** The windows of the app as one window's commands see them (#70). */
export interface CockpitWindows {
  /** Opens a new window with its own session and buffer set. */
  open(): void
  /** The buffers of every other window, window by window. */
  others(): readonly WindowBuffer[]
  /** Brings another window forward with one of its buffers current. */
  switchTo(windowId: number, bufferId: string): void
}

/** Without the app there is one window and no way to open another. */
const ONE_WINDOW: CockpitWindows = {
  open: () => {
    throw new CommandError('No window opener is installed')
  },
  others: () => [],
  switchTo: () => {
    throw new CommandError('There is no other window')
  },
}

/**
 * The palette id of another window's buffer. A buffer id of the registry is
 * `b` and a number, so the colon keeps the two apart.
 */
export function foreignBufferId(windowId: number, bufferId: string): string {
  return `${windowId}:${bufferId}`
}

/** The window and the buffer a palette id names, or null for a buffer of this window. */
export function parseForeignBufferId(
  id: string,
): { readonly windowId: number; readonly bufferId: string } | null {
  const match = /^(\d+):(.+)$/.exec(id)
  if (match === null) return null
  return { windowId: Number(match[1]), bufferId: match[2] ?? '' }
}

export function resolveCockpitDeps(partial: Partial<CockpitDeps> = {}): CockpitDeps {
  const buffers = partial.buffers ?? createCockpitBuffers()
  const permissions = partial.permissions ?? new PermissionBridge(buffers)
  const agent =
    partial.agent ??
    new SessionManager({ cwd: process.cwd(), model: null, permissionHandler: permissions })
  const issues =
    partial.issues ??
    new IssueAttachment({
      cwd: process.cwd(),
      fetch: () => Promise.reject(new CommandError('No issue fetcher is installed')),
    })
  const prompter = partial.prompter ?? new Prompter()
  return {
    buffers,
    permissions,
    prompter,
    help: partial.help ?? new HelpBuffers(buffers),
    keys: partial.keys ?? new KeyReader(),
    agent,
    prompts: partial.prompts ?? new PromptQueue(agent),
    sessions: partial.sessions ?? NO_SESSIONS,
    transcripts: partial.transcripts ?? new TranscriptSearch({ sessionsDir: null }),
    // Without the window there is nobody to ask and nothing to open.
    diffs:
      partial.diffs ??
      new DiffBuffers(buffers, {
        confirm: () => Promise.resolve(false),
        open: () => Promise.resolve('No file opener is installed'),
      }),
    plans:
      partial.plans ??
      new PlanBuffers(buffers, permissions, { leavePlanMode: () => agent.leavePlanMode() }),
    specs: partial.specs ?? new SpecBuffers(buffers),
    // Without the app there is no gh login, no shell to run a check in and no
    // screen; the question before an issue's command still goes through the
    // prompter (#98).
    issues,
    verifier:
      partial.verifier ??
      new Verifier({
        cwd: process.cwd(),
        settingsCommand: null,
        issueBody: () => issues.current?.body ?? null,
        confirm: (command) => confirm(prompter, VERIFY_SOURCE, verifyQuestion(command)),
        run: () =>
          Promise.resolve({
            exitCode: null,
            signal: null,
            output: 'No check runner is installed\n',
          }),
      }),
    screenshots:
      partial.screenshots ??
      new Screenshots({
        dir: process.cwd(),
        capturer: { list: () => Promise.resolve([]), capture: () => Promise.resolve(null) },
      }),
    // Without the app there is no clipboard; the files and the fetch need none.
    files:
      partial.files ?? new WorkingFiles({ cwd: process.cwd(), list: () => Promise.resolve([]) }),
    clipboard: partial.clipboard ?? { readImage: () => Promise.resolve(null) },
    fetcher: partial.fetcher ?? new UrlFetcher(),
    // Without the window there is nobody to ask and nothing to open; the
    // files are read where the process runs, as in the app.
    environment:
      partial.environment ??
      new EnvironmentBuffers(buffers, {
        cwd: process.cwd(),
        home: homedir(),
        started: () => agent.started,
        confirm: () => Promise.resolve(false),
        open: () => Promise.resolve('No file opener is installed'),
      }),
    // Without the app there is no config scope: every form is refused.
    repl: partial.repl ?? new Repl(buffers),
    windows: partial.windows ?? ONE_WINDOW,
  }
}

/**
 * A command that reads its argument from the palette returns at once, so the
 * key that ran it is answered before the user has chosen; what happens with
 * the choice is the consumer, and its failure is reported by command name only.
 */
function report(name: string): (error: unknown) => void {
  return (error) => console.error(`Command ${name} failed:`, error)
}

export function cockpitCommands(deps: CockpitDeps, registry: CommandRegistry): readonly Command[] {
  const {
    buffers,
    permissions,
    prompter,
    help,
    keys,
    agent,
    prompts,
    sessions,
    transcripts,
    diffs,
    plans,
    specs,
    verifier,
    issues,
    screenshots,
    files,
    clipboard,
    fetcher,
    environment,
    repl,
    windows,
  } = deps
  /** A command that composed text for the prompt gives it the point, so the text is seen. */
  const switchToPrompt = (): void => {
    const prompt = buffers.list().find((buffer) => buffer.kind === 'prompt')
    if (prompt !== undefined) buffers.switchTo(prompt.id)
  }
  return [
    defineCommand({
      name: 'execute-command',
      doc: 'Run a command by name.',
      run: () => {
        prompter.read({ source: 'commands', prompt: 'M-x' }, async (name) => {
          await registry.run(name, { source: 'palette' })
          return { command: name }
        })
      },
    }),
    defineCommand({
      name: 'describe-command',
      doc: 'Show what a command does and the keys that run it.',
      run: () => {
        prompter.read({ source: 'commands', prompt: 'Describe command:' }, (name) => {
          help.show(describeCommand(registry, cockpitKeymapLayers(), name))
        })
      },
    }),
    defineCommand({
      name: 'describe-key',
      doc: 'Show what the next key sequence runs.',
      run: () => {
        keys
          .read()
          .then((reading) => help.show(describeKey(registry, reading)))
          .catch(report('describe-key'))
      },
    }),
    defineCommand({
      name: 'choose-buffer',
      doc: 'Switch to a buffer chosen by name.',
      run: () => {
        prompter.read({ source: 'buffers', prompt: 'Switch to buffer:' }, (id) => {
          // A buffer of another window brings that window forward (#70).
          const foreign = parseForeignBufferId(id)
          if (foreign === null) buffers.switchTo(id)
          else windows.switchTo(foreign.windowId, foreign.bufferId)
        })
      },
    }),
    defineCommand({
      name: 'keyboard-quit',
      doc: 'Cancel the half-typed key sequence, the prompt or the running turn.',
      run: () => {
        // The resolver already dropped the pending sequence, and the window
        // closes the palette on this name. With no read open, C-g is the
        // guide's Esc: the running turn stops and the context stays (#84).
        if (prompter.pending === null) agent.interrupt().catch(report('keyboard-quit'))
      },
    }),
    defineCommand({
      name: 'rewind',
      doc: 'List the checkpoints, then restore the conversation, the code or both at one, after a preview and a yes.',
      run: () => {
        const checkpoints = agent.checkpoints()
        help.show(describeCheckpoints(checkpoints))
        if (checkpoints.length === 0) return
        prompter.read({ source: 'checkpoints', prompt: 'Rewind to:' }, (uuid) => {
          const checkpoint = checkpoints.find((candidate) => candidate.uuid === uuid)
          if (checkpoint === undefined) return
          prompter.read({ source: 'rewind-targets', prompt: 'Restore:' }, async (target) => {
            if (!isRewindTarget(target)) return
            // Restoring files is the one action that rewrites the working
            // tree, so the SDK's dry run shows its list first and the
            // question names the count (#99); a conversation-only rewind
            // asks the one question, with the turns it drops.
            const dropped = turnsDropped(checkpoints, checkpoint)
            let question: string
            if (target === 'conversation') {
              question = rewindConversationQuestion(checkpoint, dropped)
            } else {
              const preview = await agent.previewRewind(checkpoint)
              if (!preview.canRewind) return
              help.show(
                describeRewindPreview(checkpoint, preview, target === 'both' ? dropped : null),
              )
              question = rewindFilesQuestion(checkpoint, preview)
            }
            if (await confirm(prompter, REWIND_SOURCE, question)) {
              await agent.rewind(checkpoint, target)
            } else {
              agent.declineRewind(checkpoint)
            }
          })
        })
      },
    }),
    defineCommand({
      name: 'undo',
      doc: 'Ask the agent to undo its last actions, the tool calls quoted.',
      run: () => {
        prompts.submit(undoPrompt(agent.lastToolCalls())).catch(report('undo'))
      },
    }),
    defineCommand({
      name: 'new-task',
      doc: 'Start a fresh session in this window; the next prompt carries no context over.',
      run: () => {
        // A fresh session forgets the yes given to an issue's check (#98).
        verifier.forgetApprovals()
        agent.newTask().catch(report('new-task'))
      },
    }),
    defineCommand({
      name: 'clear',
      doc: 'Clear the context: a fresh session in this window, as /clear does between tasks.',
      run: () => {
        verifier.forgetApprovals()
        agent.newTask().catch(report('clear'))
      },
    }),
    defineCommand({
      name: 'compact',
      doc: 'Compact the conversation; text in the prompt buffer is the instruction.',
      run: () => {
        // The instruction is the text in the prompt buffer, which lives in
        // the renderer: when the dispatch answers with this name, the prompt
        // buffer sends `/compact <text>` through the prompt bridge, and the
        // CLI under the SDK runs it (#80). Running it from the palette takes
        // the same path, like send-prompt.
      },
    }),
    defineCommand({
      name: 'side-question',
      doc: 'Ask a question whose answer stays out of the session history.',
      run: () => {
        prompter.read(
          { source: 'side-question', prompt: 'Side question:', freeText: true },
          async (question) => {
            help.show(`Side question: ${question.trim()}\n\nAsking...`)
            let answer: string
            try {
              answer = await agent.sideQuestion(question.trim())
            } catch (error) {
              answer = `Not answered: ${error instanceof Error ? error.message : String(error)}`
            }
            help.show(
              `Side question: ${question.trim()}\n\n${answer}\n\nThis answer is not in the session history.`,
            )
          },
        )
      },
    }),
    defineCommand({
      name: 'correct',
      doc: 'Count the next prompt as a correction of the last turn.',
      run: () => {
        agent.markCorrection()
      },
    }),
    defineCommand({
      name: 'resume-session',
      doc: 'Resume a past session: its transcript is shown and the next prompt continues it.',
      run: () => {
        prompter.read({ source: 'sessions', prompt: 'Resume session:' }, async (id) => {
          verifier.forgetApprovals()
          await agent.resume(id, sessions.history(id))
        })
      },
    }),
    defineCommand({
      name: 'name-session',
      doc: 'Name the session, for the sessions list, the window title and the mode line; naming it again replaces the name.',
      run: () => {
        // The name is one event in the session's log (#104), appended like
        // every other; the palette refuses an empty line, and a name with
        // nothing printable is refused here, once the palette has closed.
        prompter.read(
          { source: 'session-name', prompt: 'Name session:', freeText: true },
          (text) => {
            const name = sessionName(text)
            if (name === null) {
              help.show('The session was not named: a name needs a printable character.')
              return
            }
            agent.nameSession(name)
          },
        )
      },
    }),
    defineCommand({
      name: 'search-transcripts',
      doc: 'Search every session on disk for a text; a match opens its session at that line.',
      run: () => {
        // Two reads: the query as free text, then one of the matches. The
        // match resumes its session the way resume-session does, then the
        // transcript buffer takes the point and is told the line to go to.
        prompter.read(
          { source: 'search-query', prompt: 'Search transcripts:', freeText: true },
          async (query) => {
            const matches = await transcripts.search(query.trim())
            const prompt =
              matches.length === 0 ? `Nothing matches "${query.trim()}":` : 'Open match:'
            prompter.read({ source: 'matches', prompt }, async (id) => {
              const match = transcripts.matches[Number(id)]
              if (match === undefined) return
              verifier.forgetApprovals()
              await agent.resume(match.sessionId, sessions.history(match.sessionId))
              const transcript = buffers.list().find((buffer) => buffer.kind === 'transcript')
              if (transcript !== undefined) buffers.switchTo(transcript.id)
              transcripts.goTo(match)
            })
          },
        )
      },
    }),
    defineCommand({
      name: 'list-diffs',
      doc: 'List the Edit and Write calls of the session; one opens as a diff buffer.',
      run: () => {
        if (diffs.list().length === 0) {
          help.show('No diffs yet: the agent has made no Edit or Write call in this session.')
          return
        }
        prompter.read({ source: 'diffs', prompt: 'Show diff:' }, (id) => {
          diffs.show(id)
        })
      },
    }),
    defineCommand({
      name: 'open-diff-file',
      doc: 'Open the file of the current diff buffer with the default application, after a yes.',
      run: () => {
        diffs.openCurrent().catch(report('open-diff-file'))
      },
    }),
    defineCommand({
      name: 'toggle-plan-mode',
      doc: 'Plan mode on or off: on, the agent reads and plans and runs no tool until a plan is approved.',
      run: () => {
        agent.togglePlanMode().catch(report('toggle-plan-mode'))
      },
    }),
    defineCommand({
      name: 'approve-plan',
      doc: 'Approve the plan in the current plan buffer, as edited; the session leaves plan mode.',
      run: () => {
        // The text lives in the renderer, edited: when the dispatch answers
        // with this name, the plan buffer sends it through the plan bridge
        // and the plan buffers settle the request (#82). A plan buffer that
        // is not pending has nothing to approve, which the key says.
        if (plans.pending.length === 0) throw new CommandError('No plan is pending')
      },
    }),
    defineCommand({
      name: 'reject-plan',
      doc: 'Reject the plan in the current plan buffer; the edited text goes back as feedback.',
      run: () => {
        // Same path as approve-plan: the renderer answers with the text (#82).
        if (plans.pending.length === 0) throw new CommandError('No plan is pending')
      },
    }),
    defineCommand({
      name: 'ask-codebase',
      doc: 'Ask the codebase a question, as you would ask another engineer; sent as typed.',
      run: () => {
        prompter.read(
          { source: 'question', prompt: 'Ask the codebase:', freeText: true },
          async (question) => {
            await prompts.submit(askCodebasePrompt(question))
          },
        )
      },
    }),
    defineCommand({
      name: 'investigate',
      doc: 'Delegate a question to subagents, so the research stays out of the main context.',
      run: () => {
        prompter.read(
          { source: 'question', prompt: 'Investigate:', freeText: true },
          async (question) => {
            await prompts.submit(investigatePrompt(question))
          },
        )
      },
    }),
    defineCommand({
      name: 'interview',
      doc: 'Have the agent interview you about a feature and write the spec to SPEC.md; the spec opens as a buffer.',
      run: () => {
        prompter.read(
          { source: 'question', prompt: 'Interview me about:', freeText: true },
          async (description) => {
            await prompts.submit(interviewPrompt(description))
          },
        )
      },
    }),
    defineCommand({
      name: 'start-fresh-session-from-spec',
      doc: 'Clear the context and start a fresh session with the spec in the current spec buffer as its first message.',
      run: () => {
        const spec = specs.current
        if (spec === null) throw new CommandError('No spec buffer is open')
        specs.take(spec.bufferId)
        verifier.forgetApprovals()
        agent
          .newTask()
          .then(() => prompts.submit(freshSessionPrompt(spec.filePath, spec.text)))
          .catch(report('start-fresh-session-from-spec'))
      },
    }),
    defineCommand({
      name: 'verify',
      doc: "Run the project's check with your permissions: the attached issue's Verify command, else the settings' verify, else npm run gate; the output lands as evidence.",
      run: () => {
        // The check is a child of the cockpit, never a tool call of the
        // agent: no permission rule is consulted and none is relaxed (#81).
        const running = verifier.running
        if (running !== null)
          throw new CommandError(`A check is already running: ${running.command}`)
        verifier.verify().catch(report('verify'))
      },
    }),
    defineCommand({
      name: 'attach-issue',
      doc: 'Attach a GitHub issue to the session by number; its Verify section is what the verify key runs first.',
      run: () => {
        // A refused number or a gh failure is answered in the help buffer,
        // since the palette has closed by the time it is known.
        prompter.read(
          { source: 'issue-number', prompt: 'Attach issue:', freeText: true },
          async (text) => {
            try {
              await issues.attach(text)
              // A new attach, even of the same issue, asks before its check runs (#98).
              verifier.forgetApprovals()
            } catch (error) {
              help.show(
                `Could not attach the issue: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          },
        )
      },
    }),
    defineCommand({
      name: 'attach-check',
      doc: 'Add a verification criterion to the prompt: example cases, and the check to run after implementing.',
      run: () => {
        // Two reads, the guide's before and after: the cases as free text,
        // then the check, where the one the verify key would run is the
        // candidate and anything else typed is taken as is.
        prompter.read(
          { source: 'check-cases', prompt: 'Example cases (input is output):', freeText: true },
          (cases) => {
            prompter.read(
              { source: 'check', prompt: 'Run after implementing:', freeText: true },
              (check) => {
                prompts.insert(attachCheckPrompt(cases, check))
                switchToPrompt()
              },
            )
          },
        )
      },
    }),
    defineCommand({
      name: 'screenshot-window',
      doc: 'Capture a window on the screen into the prompt as an image, to verify a UI change visually.',
      run: () => {
        screenshots
          .refresh()
          .then((windows) => {
            if (windows.length === 0) {
              help.show('No window to capture: the system listed none.')
              return
            }
            prompter.read({ source: 'windows', prompt: 'Screenshot window:' }, async (id) => {
              const shot = await screenshots.take(id)
              prompts.insert(screenshotPrompt(shot.name, shot.path))
              switchToPrompt()
            })
          })
          .catch(report('screenshot-window'))
      },
    }),
    defineCommand({
      name: 'complete-file',
      doc: 'Mention a file of the working directory in the prompt: @ at the start of a word opens the list, the pick goes in at the point.',
      run: (context) => {
        // When the `@` key ran it, the prompt buffer typed the `@` itself and
        // the pick adds the path after it; from the palette, the whole mention.
        const typed = context.source === 'key' && context.chord === '@'
        files
          .refresh()
          .then((paths) => {
            if (paths.length === 0) {
              help.show('No files to mention: the working directory lists none.')
              return
            }
            prompter.read({ source: 'files', prompt: 'Mention file:' }, (path) => {
              prompts.insert(`${typed ? '' : '@'}${path} `, 'point')
              switchToPrompt()
            })
          })
          .catch(report('complete-file'))
      },
    }),
    defineCommand({
      name: 'attach-image',
      doc: 'Attach the image on the clipboard to the next prompt as PNG; a marker line stands for it in the text.',
      run: () => {
        // The bytes stay in the main process until the send; the help buffer
        // answers an empty clipboard or an image over the cap, since the key
        // has been answered by then.
        clipboard
          .readImage()
          .then((image) => {
            if (image === null) {
              help.show('No image on the clipboard. Copy one, then C-c C-i again.')
              return
            }
            try {
              prompts.attachImage(image)
            } catch (error) {
              help.show(
                `Could not attach the image: ${error instanceof Error ? error.message : String(error)}`,
              )
              return
            }
            switchToPrompt()
          })
          .catch(report('attach-image'))
      },
    }),
    defineCommand({
      name: 'fetch-url',
      doc: 'Fetch an https URL as text into the prompt, wrapped as untrusted content from its origin; the URLs in the prompt are the candidates.',
      run: () => {
        // The text of the page is data from a named origin: it enters the
        // prompt through the one wrapper and nowhere else (SECURITY.org, T4).
        prompter.read(
          { source: 'urls', prompt: 'Fetch URL (https only):', freeText: true },
          async (url) => {
            try {
              const page = await fetcher.fetchText(url)
              prompts.insert(wrapUntrusted(page.origin, page.text))
              switchToPrompt()
            } catch (error) {
              help.show(
                `Could not fetch ${url.trim()}: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          },
        )
      },
    }),
    defineCommand({
      name: 'template-symptom',
      doc: 'Add the symptom template to the prompt: what happens, what should, how to reproduce, where it last worked.',
      run: () => {
        prompts.insert(SYMPTOM_TEMPLATE)
        switchToPrompt()
      },
    }),
    defineCommand({
      name: 'template-pattern',
      doc: 'Add the pattern template to the prompt: the file that does it right, what to copy, what differs.',
      run: () => {
        prompts.insert(PATTERN_TEMPLATE)
        switchToPrompt()
      },
    }),
    defineCommand({
      name: 'environment',
      doc: 'Show the environment of the working directory: CLAUDE.md files, permission rules, hooks, skills, MCP servers, subagents, plugins.',
      run: () => {
        environment.show()
      },
    }),
    defineCommand({
      name: 'open-environment-file',
      doc: 'Open a file the environment panel lists with the default application, after a yes.',
      run: () => {
        // The renderer holds the point and the preload gains no channel for
        // it, so the file is read off the palette over the panel's own list,
        // which is the allowlist the open checks again (#86).
        if (environment.files().length === 0) {
          help.show('No file to open: the environment panel lists none.')
          return
        }
        prompter.read({ source: 'environment-files', prompt: 'Open file:' }, async (path) => {
          await environment.open(path)
        })
      },
    }),
    defineCommand({
      name: 'edit-claude-md',
      doc: "Open the nearest CLAUDE.md with the default application, after a yes, with the guide's reminder to keep it short.",
      run: () => {
        environment.editClaudeMd().catch(report('edit-claude-md'))
      },
    }),
    defineCommand({
      name: 'doctor',
      doc: 'Check every CLAUDE.md that applies against the length threshold; the files over it are listed.',
      run: () => {
        help.show(environment.doctor())
      },
    }),
    defineCommand({
      name: 'eval-expression',
      doc: 'Evaluate a TypeScript form in the config scope; a definition is applied and journaled.',
      run: () => {
        // The window reads the key shape again after the outcome: the form may have bound a key.
        prompter.read({ source: 'eval-form', prompt: 'Eval:', freeText: true }, async (form) => {
          await repl.evaluate(form, true)
          return { command: 'eval-expression' }
        })
      },
    }),
    defineCommand({
      name: 'repl',
      doc: 'Open the *repl* buffer, where RET evaluates a form in the config scope.',
      run: () => {
        repl.open()
      },
    }),
    defineCommand({
      name: 'repl-read',
      doc: 'Read a form and evaluate it in the *repl* buffer.',
      run: () => {
        prompter.read({ source: 'eval-form', prompt: 'Eval:', freeText: true }, async (form) => {
          repl.open()
          await repl.evaluate(form, false)
          return { command: 'repl-read' }
        })
      },
    }),
    defineCommand({
      name: 'journal-promote',
      doc: 'Move an entry of the eval journal to the end of init.ts.',
      run: () => {
        if (repl.entries().length === 0) {
          repl.notify('The eval journal has no entry to promote.')
          return
        }
        prompter.read({ source: 'journal', prompt: 'Promote to init.ts:' }, (id) => {
          repl.promote(id)
        })
      },
    }),
    defineCommand({
      name: 'journal-discard',
      doc: 'Delete an entry of the eval journal; what it defined stays live until a restart.',
      run: () => {
        if (repl.entries().length === 0) {
          repl.notify('The eval journal has no entry to discard.')
          return
        }
        prompter.read({ source: 'journal', prompt: 'Discard from the journal:' }, (id) => {
          repl.discard(id)
        })
      },
    }),
    defineCommand({
      name: 'send-prompt',
      doc: 'Send the prompt buffer to the agent.',
      run: () => {
        // The text lives in the renderer. When the dispatch answers with this
        // name, the prompt buffer sends its text through the prompt bridge and
        // the queue in src/main/agent/session-bridge.ts takes it from there
        // (#61). Running it from the palette (#65) takes the same path.
      },
    }),
    defineCommand({
      name: 'switch-buffer',
      doc: 'Switch to the next buffer.',
      run: () => {
        // Cycles, as it did before the chooser existed; `choose-buffer` is the
        // fuzzy chooser over titles (#65), and binding it here is a keymap call.
        buffers.switchToNext()
      },
    }),
    defineCommand({
      name: 'new-window',
      doc: 'Open a new window with its own session and buffers.',
      run: () => {
        windows.open()
      },
    }),
    defineCommand({
      name: 'kill-buffer',
      doc: 'Kill the current buffer.',
      run: () => {
        buffers.kill()
      },
    }),
    defineCommand({
      name: 'search-buffer',
      doc: 'Search in the current buffer.',
      run: () => {
        // Search is a CodeMirror surface: when the dispatch answers with this
        // name, the transcript buffer opens its search panel, or steps to the
        // next match when the panel is already open (#62).
      },
    }),
    defineCommand({
      name: 'answer-yes',
      doc: 'Allow the pending tool once.',
      run: () => {
        permissions.allowOnce()
      },
    }),
    defineCommand({
      name: 'answer-no',
      doc: 'Deny the pending tool, or decline the pending question.',
      run: () => {
        permissions.deny()
      },
    }),
    defineCommand({
      name: 'allow-for-session',
      doc: 'Allow the pending tool now and for the rest of the session.',
      run: () => {
        permissions.allowForSession()
      },
    }),
    ...QUESTION_OPTIONS.map((number) =>
      defineCommand({
        name: `choose-option-${number}`,
        doc: `Choose option ${number} of the pending question.`,
        run: () => {
          permissions.choose(number)
        },
      }),
    ),
  ]
}

/**
 * The palette sources of M1 (#65): the commands, with their keys, and the
 * buffers; the rewind reads of #84, the checkpoints and what to restore;
 * the sessions on disk (#67), newest first, titled by their name (#104) or
 * else their first prompt, and the name read over nothing, like a query;
 * and the two reads of a search (#69): the query, over nothing, since the
 * text typed is the answer, and the matches of the last search; and the
 * diffs of the session (#68), oldest first; and the one line the three
 * guideline commands read (#85), over nothing, like a search query; and the
 * reads of the verify practice (#81): an issue number and the example cases
 * over nothing, the check with the one the verify key would run as its
 * candidate, and the windows on the screen as of the last refresh; and the
 * two reads of #83: the files of the working directory as of the last
 * refresh, and the https URLs in the prompt draft, the last typed first,
 * for a free-text read that takes any other; and the files the environment
 * panel lists (#86), in the panel's order, for `RET` there; and the two
 * reads of eval (#72): a form, over nothing, and the journal's entries in
 * file order.
 */
export function cockpitSources(
  registry: CommandRegistry,
  buffers: BufferRegistry,
  agent: SessionManager,
  sessions: SessionSource,
  transcripts: TranscriptSearch,
  diffs: DiffBuffers,
  verifier: Verifier,
  screenshots: Screenshots,
  files: WorkingFiles,
  prompts: Pick<PromptQueue, 'draft'>,
  environment: EnvironmentBuffers,
  repl: Repl,
  windows: CockpitWindows,
): readonly PaletteSource[] {
  return [
    {
      name: 'commands',
      candidates: () =>
        registry.list().map((command) => ({
          id: command.name,
          label: command.name,
          doc: command.doc,
          detail: bindingNote(cockpitKeymapLayers(), command.name),
        })),
    },
    {
      name: 'buffers',
      candidates: () => [
        ...buffers.list().map((buffer) => ({
          id: buffer.id,
          label: buffer.title,
          doc: `${buffer.kind} buffer${buffer.id === buffers.current?.id ? ', current' : ''}`,
        })),
        // Every other window's, with the window named (#70).
        ...windows.others().map((other) => ({
          id: foreignBufferId(other.windowId, other.buffer.id),
          label: `${other.buffer.title} <${other.windowName}>`,
          doc: `${other.buffer.kind} buffer in ${other.windowName}${other.current ? ', current there' : ''}`,
        })),
      ],
    },
    {
      name: 'checkpoints',
      candidates: () =>
        agent.checkpoints().map((checkpoint) => ({
          id: checkpoint.uuid,
          label: describeCheckpoint(checkpoint),
          doc: `Checkpoint ${checkpoint.index}`,
        })),
    },
    {
      name: 'rewind-targets',
      candidates: () =>
        REWIND_TARGETS.map((target) => ({ id: target, label: target, doc: REWIND_DOCS[target] })),
    },
    {
      name: 'sessions',
      candidates: () =>
        sessions.list().map((session) => ({
          id: session.id,
          label: session.title,
          detail: formatSessionDate(session.startedAt),
          doc: `${session.id} in ${session.cwd}${session.id === agent.sessionId ? ', current' : ''}`,
        })),
    },
    {
      name: 'session-name',
      candidates: () => [],
    },
    {
      name: 'search-query',
      candidates: () => [],
    },
    {
      name: 'side-question',
      candidates: () => [],
    },
    {
      name: 'question',
      candidates: () => [],
    },
    {
      name: 'matches',
      candidates: () =>
        transcripts.matches.map((match, index) => ({
          id: String(index),
          label: describeMatch(match),
          doc: `${match.sessionId}, line ${match.line}`,
        })),
    },
    {
      name: 'diffs',
      candidates: () =>
        diffs.list().map((diff) => ({
          id: diff.id,
          label: `${diff.index}. ${diff.tool} ${diff.filePath}`,
          doc: describeDiff(diff),
        })),
    },
    {
      name: 'issue-number',
      candidates: () => [],
    },
    {
      name: 'check-cases',
      candidates: () => [],
    },
    {
      name: 'check',
      candidates: () => {
        const check = verifier.command()
        return [
          {
            id: check.command,
            label: check.command,
            doc: `The check C-c C-v runs, ${describeSource(check.source)}. Type another to use it instead.`,
          },
        ]
      },
    },
    {
      name: 'windows',
      candidates: () =>
        screenshots.windows.map((window) => ({
          id: window.id,
          label: window.name.length === 0 ? '(untitled window)' : window.name,
          doc: `Window ${window.id}`,
        })),
    },
    {
      name: 'files',
      candidates: () =>
        files.files.map((path) => ({ id: path, label: path, doc: `@${path} in the prompt` })),
    },
    {
      name: 'urls',
      candidates: () =>
        httpsUrlsIn(prompts.draft).map((url) => ({
          id: url,
          label: url,
          doc: 'In the prompt. Type another https URL to fetch it instead.',
        })),
    },
    {
      name: 'environment-files',
      candidates: () =>
        environment.files().map((path) => ({
          id: path,
          label: environment.label(path),
          doc: path,
        })),
    },
    {
      name: 'eval-form',
      candidates: () => [],
    },
    {
      name: 'journal',
      candidates: () =>
        repl.entries().map((entry) => ({
          id: entry.id,
          label: `${entry.id}. ${entry.summary}`,
          detail: entry.at,
          doc: entry.form.split('\n')[0] ?? '',
        })),
    },
  ]
}

/** The https URLs in a text, the last one first, each once. */
export function httpsUrlsIn(text: string): readonly string[] {
  const found = text.match(/https:\/\/[^\s<>"'`)\]]+/g) ?? []
  const urls: string[] = []
  for (const raw of found.reverse()) {
    const url = raw.replace(/[.,;:!?]+$/, '')
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

function isRewindTarget(value: string): value is RewindTarget {
  return (REWIND_TARGETS as readonly string[]).includes(value)
}

const REWIND_DOCS: Record<RewindTarget, string> = {
  conversation: 'The session goes back to before the checkpoint; later turns are dropped.',
  code: 'Files the agent edited since the checkpoint go back to their state then.',
  both: 'The conversation and the files, together.',
}

/** Bindings available in every buffer. The help keys are Emacs 28's. */
export const GLOBAL_KEYMAP = defineKeymap('global', {
  'M-x': 'execute-command',
  'C-g': 'keyboard-quit',
  'C-c C-c': 'send-prompt',
  'C-c C-l': 'clear',
  'C-c C-k': 'compact',
  'C-c C-p': 'toggle-plan-mode',
  'C-c C-v': 'verify',
  'C-c C-i': 'attach-image',
  'C-c C-u': 'fetch-url',
  'C-c C-e': 'environment',
  'C-c C-n': 'name-session',
  'C-x b': 'switch-buffer',
  'C-x k': 'kill-buffer',
  'C-x n': 'new-task',
  'C-x s': 'search-transcripts',
  'C-x 5 2': 'new-window',
  'C-s': 'search-buffer',
  'C-h x': 'describe-command',
  'C-h k': 'describe-key',
})

/** Per-buffer-type bindings. They are consulted before the global map. */
export const BUFFER_KEYMAPS: BufferKeymaps = {
  // In the prompt buffer `@` at the start of a word mentions a file (#83);
  // the renderer keeps it as text inside a word, so an address stays one.
  prompt: defineKeymap('prompt', {
    '@': 'complete-file',
  }),
  // A permission prompt is modal: an unmodified key is an answer, not text.
  permission: defineKeymap('permission', {
    y: 'answer-yes',
    n: 'answer-no',
    a: 'allow-for-session',
    ...Object.fromEntries(
      QUESTION_OPTIONS.map((number) => [`${number}`, `choose-option-${number}`]),
    ),
  }),
  // A diff buffer's file goes to the system on the Org key for opening a link (#68).
  diff: defineKeymap('diff', {
    'C-c C-o': 'open-diff-file',
  }),
  // In a plan buffer the send and compact keys are approve and reject (#82).
  plan: defineKeymap('plan', {
    'C-c C-c': 'approve-plan',
    'C-c C-k': 'reject-plan',
  }),
  // In a spec buffer the send key starts the fresh session the guide says to (#85).
  spec: defineKeymap('spec', {
    'C-c C-c': 'start-fresh-session-from-spec',
  }),
  // In the environment buffer RET opens a listed file through the open door (#86).
  environment: defineKeymap('environment', {
    RET: 'open-environment-file',
  }),
  // In the *repl* buffer RET reads the next form (#72).
  repl: defineKeymap('repl', {
    RET: 'repl-read',
  }),
}

/** The chord that abandons a half-typed sequence. */
export const ABORT_CHORD = 'C-g'

/**
 * The user's layer from the config file (#71, ADR 0006), above the global
 * map, and the global map as describe and the menu show it once that layer
 * shadows some of its chords. Null until a config binds a key.
 */
let userLayer: { readonly keymap: Keymap; readonly global: Keymap } | null = null

/** Installs or drops the user layer. The config loader calls it on a commit. */
export function setUserKeymap(keymap: Keymap | null): void {
  if (keymap === null) {
    userLayer = null
    return
  }
  const visible = GLOBAL_KEYMAP.entries().filter((entry) => !isShadowed(keymap, entry.chord))
  userLayer = {
    keymap,
    global: defineKeymap(
      GLOBAL_KEYMAP.name,
      Object.fromEntries(visible.map((entry) => [entry.chord, entry.command])),
    ),
  }
}

/** The user layer, when a config installed one. */
export function userKeymap(): Keymap | null {
  return userLayer?.keymap ?? null
}

/** Every keymap with the buffers it applies to, for describe-command (#65). */
export function cockpitKeymapLayers(): readonly KeymapLayer[] {
  return [
    ...(userLayer === null ? [] : [{ keymap: userLayer.keymap, bufferType: null }]),
    { keymap: userLayer?.global ?? GLOBAL_KEYMAP, bufferType: null },
    ...(Object.entries(BUFFER_KEYMAPS) as [BufferType, Keymap][]).map(([bufferType, keymap]) => ({
      keymap,
      bufferType,
    })),
  ]
}

export function createCockpitRegistry(partial: Partial<CockpitDeps> = {}): CommandRegistry {
  const deps = resolveCockpitDeps(partial)
  const registry = new CommandRegistry()
  registry.registerAll(cockpitCommands(deps, registry))
  for (const source of cockpitSources(
    registry,
    deps.buffers,
    deps.agent,
    deps.sessions,
    deps.transcripts,
    deps.diffs,
    deps.verifier,
    deps.screenshots,
    deps.files,
    deps.prompts,
    deps.environment,
    deps.repl,
    deps.windows,
  )) {
    deps.prompter.addSource(source)
  }
  return registry
}

export function createCockpitResolver(): KeyResolver {
  return new KeyResolver({
    global: GLOBAL_KEYMAP,
    byBufferType: BUFFER_KEYMAPS,
    user: userKeymap,
    abort: ABORT_CHORD,
  })
}

/** The dispatcher the window drives. Throws here, at startup, on a stale binding. */
export function createCockpitDispatcher(partial: Partial<CockpitDeps> = {}): KeyDispatcher {
  const deps = resolveCockpitDeps(partial)
  const registry = createCockpitRegistry(deps)
  assertBindingsAreRegistered(registry, [GLOBAL_KEYMAP, ...Object.values(BUFFER_KEYMAPS)])
  return new KeyDispatcher(registry, createCockpitResolver(), deps.keys)
}
