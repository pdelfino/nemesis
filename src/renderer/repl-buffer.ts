import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  search,
  searchPanelOpen,
} from '@codemirror/search'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { BufferType, KeyOutcome } from '../shared/keys'
import { followAppearance } from './theme'

/**
 * The `*repl*` buffer (#72): the forms evaluated in the config scope and
 * their values, as a read-only document in the help buffer's style, with the
 * Emacs movement keys and `C-s`. The main process evaluates and owns the
 * log; this page only shows it, the point at the end, where the last value
 * is. `RET` reaches the main process through the keymap, which reads the
 * next form off the palette; the line under the editor says so.
 */

export interface ReplBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

const REPL_ELEMENT_ID = 'repl'

const KEYS_HINT = 'RET reads a form to evaluate; M-x journal-promote moves a definition to init.ts'

export function installReplBuffer(): ReplBuffer {
  const host = required('repl-editor')
  const keys = required('repl-keys')

  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      extensions: [
        Prec.highest(
          keymap.of([{ key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' }]),
        ),
        emacs(),
        EditorState.readOnly.of(true),
        search(),
        EditorView.lineWrapping,
        followAppearance(),
      ],
    }),
  })

  window.nemesis.onReplShown((content) => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.text },
      selection: { anchor: content.text.length },
      scrollIntoView: true,
    })
    keys.textContent = KEYS_HINT
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === REPL_ELEMENT_ID) view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'repl') return
      if (outcome.command === 'search-buffer') {
        if (searchPanelOpen(view.state)) findNext(view)
        else openSearchPanel(view)
      } else if (outcome.command === 'keyboard-quit' && searchPanelOpen(view.state)) {
        closeSearchPanel(view)
      }
    },
  }
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`index.html has no #${id}`)
  return element
}
