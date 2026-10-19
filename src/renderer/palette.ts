import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { BufferType, KeyOutcome } from '../shared/keys'
import type { PaletteAnswer, PaletteCandidate, PaletteRequest } from '../shared/palette'
import { FREE_TEXT_DOC, rankCandidates } from '../shared/palette'
import { followAppearance } from './theme'

/**
 * The palette (#65): the prompt buffer in command mode. When the main process
 * reads a choice (`M-x`, `describe-command`, `choose-buffer`), the prompt
 * section gives way to a one-line query with Emacs keys, the candidates ranked
 * under it and the doc line of the highlighted one. `RET` answers with that
 * candidate, `C-g` (through `keyboard-quit`, from any buffer) and `ESC` answer
 * with nothing, `C-n`/`C-p`, the arrows and `TAB` move the highlight. A read
 * that takes free text (#69) is answered with the query itself when it
 * matches no candidate; the doc line says so while nothing is highlighted.
 *
 * The renderer decides nothing about what a choice means: the main process
 * owns the sources and acts on the answer, and tells this module when the
 * answer ran a command, so the buffers act on it as on a command a key ran.
 * The point comes back to where it was when the palette closes.
 */

/** How many candidates are listed at once; the ranking puts the best first. */
const MAX_SHOWN = 40

export interface Palette {
  readonly isOpen: boolean
  /** Acts on a command a key dispatched. True when the palette took it. */
  onCommand(outcome: KeyOutcome): boolean
  /** Told when an answer ran a command, with the buffer type the palette was opened from. */
  onRan: ((outcome: KeyOutcome, bufferType: BufferType | null) => void) | null
}

export function installPalette(): Palette {
  const host = required('palette')
  const promptLabel = required('palette-prompt')
  const inputHost = required('palette-input')
  const list = required('palette-candidates')
  const doc = required('palette-doc')
  const promptSection = required('prompt')

  let request: PaletteRequest | null = null
  let ranked: readonly PaletteCandidate[] = []
  let selected = 0
  /** Where the point was, to go back to. */
  let returnTo: Element | null = null
  let openedFrom: BufferType | null = null

  const view: EditorView = new EditorView({
    parent: inputHost,
    state: EditorState.create({
      extensions: [
        Prec.highest(
          keymap.of([
            { key: 'Enter', run: () => accept() },
            { key: 'ArrowDown', run: () => move(1) },
            { key: 'Ctrl-n', run: () => move(1) },
            { key: 'Tab', run: () => move(1) },
            { key: 'ArrowUp', run: () => move(-1) },
            { key: 'Ctrl-p', run: () => move(-1) },
            { key: 'Shift-Tab', run: () => move(-1) },
            { key: 'Escape', run: () => cancel() },
          ]),
        ),
        emacs(),
        // One line: a newline is a RET, never text.
        EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
        followAppearance(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) rank()
        }),
      ],
    }),
  })

  window.nemesis.onPaletteOpen(open)

  const palette: Palette = {
    get isOpen() {
      return request !== null
    },
    onRan: null,
    onCommand(outcome) {
      if (request === null || outcome.command !== 'keyboard-quit') return false
      cancel()
      return true
    },
  }
  return palette

  function open(next: PaletteRequest): void {
    if (request === null) {
      returnTo = document.activeElement
      openedFrom = activeBufferType()
      promptSection.classList.add('palette-open')
      host.hidden = false
    }
    request = next
    promptLabel.textContent = next.prompt
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    rank()
    view.focus()
  }

  function close(): void {
    request = null
    ranked = []
    host.hidden = true
    promptSection.classList.remove('palette-open')
    list.replaceChildren()
    doc.textContent = ''
    const target = returnTo
    returnTo = null
    if (
      target instanceof HTMLElement &&
      target.isConnected &&
      target.closest('[hidden]') === null
    ) {
      target.focus()
    }
  }

  function rank(): void {
    if (request === null) return
    ranked = rankCandidates(view.state.doc.toString(), request.candidates).slice(0, MAX_SHOWN)
    selected = 0
    render()
  }

  function move(step: number): boolean {
    if (ranked.length === 0) return true
    selected = (selected + step + ranked.length) % ranked.length
    render()
    return true
  }

  function render(): void {
    list.replaceChildren(
      ...ranked.map((candidate, index) => {
        const item = document.createElement('li')
        item.textContent = candidate.label
        if (candidate.detail !== undefined && candidate.detail.length > 0) {
          const detail = document.createElement('span')
          detail.className = 'palette-detail'
          detail.textContent = candidate.detail
          item.append(' ', detail)
        }
        if (index === selected) item.setAttribute('aria-selected', 'true')
        return item
      }),
    )
    const current = ranked[selected]
    doc.textContent =
      current !== undefined ? current.doc : request?.freeText === true ? FREE_TEXT_DOC : 'No match.'
  }

  function accept(): boolean {
    if (request === null) return true
    const choice = ranked[selected]
    if (choice !== undefined) {
      answer({ id: request.id, choice: choice.id })
      return true
    }
    // A free-text read takes the query itself; an empty one is nothing to answer.
    const typed = view.state.doc.toString()
    if (request.freeText === true && typed.trim().length > 0) {
      answer({ id: request.id, choice: null, text: typed })
      return true
    }
    doc.textContent = request.freeText === true ? FREE_TEXT_DOC : 'No match.'
    return true
  }

  function answer(reply: PaletteAnswer): void {
    const from = openedFrom
    close()
    window.nemesis.answerPalette(reply).then(
      (outcome) => {
        if (outcome.command !== undefined) {
          palette.onRan?.({ status: 'command', chord: 'M-x', command: outcome.command }, from)
        }
      },
      (error: unknown) => console.error('Palette answer failed:', error),
    )
  }

  function cancel(): boolean {
    if (request === null) return true
    const { id } = request
    close()
    window.nemesis.answerPalette({ id, choice: null }).catch((error: unknown) => {
      console.error('Palette cancel failed:', error)
    })
    return true
  }
}

function activeBufferType(): BufferType | null {
  const value = document.activeElement
    ?.closest('[data-buffer-type]')
    ?.getAttribute('data-buffer-type')
  return value === 'prompt' ||
    value === 'transcript' ||
    value === 'permission' ||
    value === 'help' ||
    value === 'diff' ||
    value === 'plan' ||
    value === 'spec' ||
    value === 'environment' ||
    value === 'repl'
    ? value
    : null
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`index.html has no #${id}`)
  return element
}
