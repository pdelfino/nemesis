import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { PromptQueueState } from '../shared/agent'
import type { BufferType, KeyOutcome } from '../shared/keys'
import { followAppearance } from './theme'

/**
 * The prompt buffer (#61): the front door of the cockpit, a CodeMirror 6
 * editor with the Emacs keys of `@replit/codemirror-emacs`, line wrapping and
 * Markdown highlighting. Multi-line by default; `C-c C-c` sends.
 *
 * The cockpit's own chords never reach the editor: src/renderer/keys.ts takes
 * them in the capture phase and the main process dispatches them. This module
 * acts on three of the commands that come back, `send-prompt`, `compact`
 * (the text is the instruction of a `/compact`, #80) and `keyboard-quit`,
 * and binds `M-p`/`M-n` inside the editor, because walking the history is
 * editing, not a cockpit command. Text a command adds to the prompt, the
 * criterion of `attach-check` or the path of a screenshot (#81), arrives
 * from the main process and is appended after what is typed.
 *
 * The draft, the history and the queue live in the main process, per session.
 * This buffer parks the draft as it changes and rebuilds itself from the main
 * process at load, so a reload loses nothing, and it clears the editor only
 * after the main process has taken the text, so a failed send loses nothing.
 */

/** How long typing may pause before the draft is parked in the main process. */
const DRAFT_DELAY_MS = 200

/** The first line of a queued prompt, as the list under the editor shows it. */
const QUEUED_PREVIEW_LENGTH = 80

export interface PromptBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

/** Walks sent prompts as `M-p`/`M-n` do in a comint buffer: the draft waits at the live end. */
class HistoryCursor {
  private entries: readonly string[] = []
  private index: number | null = null
  private stash = ''

  reset(entries: readonly string[]): void {
    this.entries = entries
    this.index = null
    this.stash = ''
  }

  /** The previous entry, or null at the oldest. Stashes the live draft on the first step. */
  previous(live: string): string | null {
    if (this.entries.length === 0) return null
    if (this.index === null) {
      this.stash = live
      this.index = this.entries.length - 1
    } else if (this.index > 0) {
      this.index -= 1
    } else {
      return null
    }
    return this.entries[this.index] ?? null
  }

  /** The next entry, or the stashed draft past the newest; null when already live. */
  next(): string | null {
    if (this.index === null) return null
    if (this.index < this.entries.length - 1) {
      this.index += 1
      return this.entries[this.index] ?? null
    }
    this.index = null
    return this.stash
  }
}

export async function installPromptBuffer(): Promise<PromptBuffer> {
  const host = required('prompt-editor')
  const note = required('prompt-note')
  const agent = required('prompt-agent')
  const queued = required('prompt-queued')
  const cursor = new HistoryCursor()

  const initial = await window.nemesis.promptState()
  cursor.reset(initial.history)
  renderQueue(initial.queue)
  window.nemesis.onPromptQueueChanged(renderQueue)

  let draftTimer: ReturnType<typeof setTimeout> | null = null
  const parkDraft = (): void => {
    if (draftTimer !== null) clearTimeout(draftTimer)
    draftTimer = null
    window.nemesis.saveDraft(view.state.doc.toString()).catch((error: unknown) => {
      console.error('Could not park the draft:', error)
    })
  }

  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initial.draft,
      extensions: [
        // History is editing, so it is an editor key, and it wins over any
        // other editor binding of Alt-p and Alt-n.
        Prec.highest(
          keymap.of([
            { key: 'Alt-p', run: () => recall(cursor.previous(view.state.doc.toString())) },
            { key: 'Alt-n', run: () => recall(cursor.next()) },
          ]),
        ),
        emacs(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        followAppearance(),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (draftTimer !== null) clearTimeout(draftTimer)
          draftTimer = setTimeout(parkDraft, DRAFT_DELAY_MS)
        }),
      ],
    }),
  })
  // A reload must find the latest draft, not the one parked 200ms ago.
  window.addEventListener('pagehide', parkDraft)

  // What a command adds goes after the text typed, on a paragraph of its own (#81).
  window.nemesis.onPromptInsert((insert) => {
    appendText(insert.text)
    parkDraft()
    say('Added to the prompt.')
  })

  // The current buffer carries the point (#60): focus follows it.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === 'prompt') view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })
  view.focus()

  function replaceText(text: string): void {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      scrollIntoView: true,
    })
  }

  function appendText(text: string): void {
    const end = view.state.doc.length
    const typed = view.state.doc.toString()
    const separator =
      typed.length === 0 || typed.endsWith('\n\n') ? '' : typed.endsWith('\n') ? '\n' : '\n\n'
    const insert = `${separator}${text}`
    view.dispatch({
      changes: { from: end, insert },
      selection: { anchor: end + insert.length },
      scrollIntoView: true,
    })
  }

  function recall(text: string | null): boolean {
    if (text === null) return true
    replaceText(text)
    return true
  }

  function say(text: string): void {
    note.textContent = text
  }

  function renderQueue(state: PromptQueueState): void {
    agent.textContent = state.busy ? 'Agent working.' : ''
    queued.replaceChildren(
      ...state.queued.map((prompt) => {
        const item = document.createElement('li')
        const [first = ''] = prompt.text.split('\n', 1)
        item.textContent = `Queued: ${first.slice(0, QUEUED_PREVIEW_LENGTH)}`
        return item
      }),
    )
  }

  /**
   * Sends the text, or with `command` the text as that command's argument:
   * `/compact` takes the text typed as its instruction, and goes alone when
   * nothing is typed (#80).
   */
  async function send(command = ''): Promise<void> {
    const typed = view.state.doc.toString()
    if (command.length === 0 && typed.trim().length === 0) {
      say('Nothing to send.')
      return
    }
    const text =
      command.length === 0
        ? typed
        : typed.trim().length === 0
          ? command
          : `${command} ${typed.trim()}`
    say('Sending.')
    try {
      const receipt = await window.nemesis.sendPrompt(text)
      // The main process has the text now, so the editor may let it go.
      replaceText('')
      parkDraft()
      cursor.reset((await window.nemesis.promptState()).history)
      say(
        receipt.status === 'queued'
          ? `Queued (${receipt.position}).`
          : receipt.status === 'answered'
            ? 'Answered.'
            : 'Sent.',
      )
    } catch (error) {
      // The text stays where it was typed.
      say(`Not sent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function clear(): void {
    if (view.state.doc.length === 0) return
    replaceText('')
    parkDraft()
  }

  return {
    view,
    onCommand(outcome, bufferType) {
      if (outcome.command === 'send-prompt') void send()
      else if (outcome.command === 'compact') void send('/compact')
      // C-g clears the prompt only when the point is in it; elsewhere it is
      // the plain cancel of #59.
      else if (outcome.command === 'keyboard-quit' && bufferType === 'prompt') clear()
    },
  }
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`index.html has no #${id}`)
  return element
}
