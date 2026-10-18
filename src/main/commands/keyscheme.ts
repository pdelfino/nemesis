import { PermissionBridge } from '../agent/permission-bridge'
import { PromptQueue } from '../agent/prompt-queue'
import {
  describeCheckpoint,
  describeCheckpoints,
  REWIND_TARGETS,
  SessionManager,
  undoPrompt,
  type RewindTarget,
} from '../agent/session-manager'
import type { BufferRegistry } from '../buffers'
import { createCockpitBuffers } from '../buffers'
import { HelpBuffers } from '../help'
import { formatSessionDate, NO_SESSIONS, type SessionSource } from '../sessions'
import type { KeymapLayer } from './describe'
import { bindingNote, describeCommand, describeKey } from './describe'
import type { BufferType } from '../../shared/keys'
import type { BufferKeymaps, Keymap } from './keymap'
import { defineKeymap, KeyResolver } from './keymap'
import { assertBindingsAreRegistered, KeyDispatcher, KeyReader } from './dispatcher'
import { Prompter, type PaletteSource } from './prompter'
import type { Command } from './registry'
import { CommandRegistry, defineCommand } from './registry'

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
 * picks it up through the manager.
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
  /** Where a prompt a command composes goes, like one the user typed (#84). */
  readonly prompts: Pick<PromptQueue, 'submit'>
  /** The sessions folder, as `resume-session` lists and reads it (#67). */
  readonly sessions: SessionSource
}

export function resolveCockpitDeps(partial: Partial<CockpitDeps> = {}): CockpitDeps {
  const buffers = partial.buffers ?? createCockpitBuffers()
  const permissions = partial.permissions ?? new PermissionBridge(buffers)
  const agent =
    partial.agent ??
    new SessionManager({ cwd: process.cwd(), model: null, permissionHandler: permissions })
  return {
    buffers,
    permissions,
    prompter: partial.prompter ?? new Prompter(),
    help: partial.help ?? new HelpBuffers(buffers),
    keys: partial.keys ?? new KeyReader(),
    agent,
    prompts: partial.prompts ?? new PromptQueue(agent),
    sessions: partial.sessions ?? NO_SESSIONS,
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
  const { buffers, permissions, prompter, help, keys, agent, prompts, sessions } = deps
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
          buffers.switchTo(id)
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
      doc: 'List the checkpoints, then restore the conversation, the code or both at one.',
      run: () => {
        const checkpoints = agent.checkpoints()
        help.show(describeCheckpoints(checkpoints))
        if (checkpoints.length === 0) return
        prompter.read({ source: 'checkpoints', prompt: 'Rewind to:' }, (uuid) => {
          const checkpoint = checkpoints.find((candidate) => candidate.uuid === uuid)
          if (checkpoint === undefined) return
          prompter.read({ source: 'rewind-targets', prompt: 'Restore:' }, async (target) => {
            if (isRewindTarget(target)) await agent.rewind(checkpoint, target)
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
        agent.newTask().catch(report('new-task'))
      },
    }),
    defineCommand({
      name: 'resume-session',
      doc: 'Resume a past session: its transcript is shown and the next prompt continues it.',
      run: () => {
        prompter.read({ source: 'sessions', prompt: 'Resume session:' }, async (id) => {
          await agent.resume(id, sessions.history(id))
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
 * buffers; the rewind reads of #84, the checkpoints and what to restore; and
 * the sessions on disk (#67), newest first, titled by their first prompt.
 */
export function cockpitSources(
  registry: CommandRegistry,
  buffers: BufferRegistry,
  agent: SessionManager,
  sessions: SessionSource,
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
      candidates: () =>
        buffers.list().map((buffer) => ({
          id: buffer.id,
          label: buffer.title,
          doc: `${buffer.kind} buffer${buffer.id === buffers.current?.id ? ', current' : ''}`,
        })),
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
  ]
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
  'C-x b': 'switch-buffer',
  'C-x k': 'kill-buffer',
  'C-x n': 'new-task',
  'C-s': 'search-buffer',
  'C-h x': 'describe-command',
  'C-h k': 'describe-key',
})

/** Per-buffer-type bindings. They are consulted before the global map. */
export const BUFFER_KEYMAPS: BufferKeymaps = {
  // A permission prompt is modal: an unmodified key is an answer, not text.
  permission: defineKeymap('permission', {
    y: 'answer-yes',
    n: 'answer-no',
    a: 'allow-for-session',
    ...Object.fromEntries(
      QUESTION_OPTIONS.map((number) => [`${number}`, `choose-option-${number}`]),
    ),
  }),
}

/** The chord that abandons a half-typed sequence. */
export const ABORT_CHORD = 'C-g'

/** Every keymap with the buffers it applies to, for describe-command (#65). */
export function cockpitKeymapLayers(): readonly KeymapLayer[] {
  return [
    { keymap: GLOBAL_KEYMAP, bufferType: null },
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
  for (const source of cockpitSources(registry, deps.buffers, deps.agent, deps.sessions)) {
    deps.prompter.addSource(source)
  }
  return registry
}

export function createCockpitResolver(): KeyResolver {
  return new KeyResolver({
    global: GLOBAL_KEYMAP,
    byBufferType: BUFFER_KEYMAPS,
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
