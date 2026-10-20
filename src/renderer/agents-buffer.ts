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
 * The agents buffer (#157): every window's session, its folder and its
 * state, as a read-only document in the environment buffer's style (#86),
 * with the Emacs movement keys and `C-s`. The main process owns the buffer,
 * tracks the states and pushes the text, again on every change while the
 * buffer is open; the section shows and hides with the buffer list, and
 * `C-x k` kills it like any other buffer. `RET` reaches the main process
 * through the keymap, which asks which session to open in the palette; the
 * line under the editor says so.
 */

export interface AgentsBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

const AGENTS_ELEMENT_ID = 'agents'

const KEYS_HINT = 'RET picks a session and brings its window forward'

export function installAgentsBuffer(): AgentsBuffer {
  const host = required('agents-editor')
  const keys = required('agents-keys')

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

  window.nemesis.onAgentsShown((content) => {
    // A redraw keeps the point on its line, so a list that refreshes on
    // every change does not throw the reader back to the top.
    const line = view.state.doc.lineAt(view.state.selection.main.head).number
    const fresh = view.state.toText(content.text)
    const anchor = fresh.line(Math.min(line, fresh.lines)).from
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.text },
      selection: { anchor },
    })
    keys.textContent = KEYS_HINT
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === AGENTS_ELEMENT_ID) view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'agents') return
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
