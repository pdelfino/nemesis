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

/**
 * The help buffer (#65): what describe-command and describe-key answer, as a
 * read-only document in the transcript's style, with the Emacs movement keys
 * and `C-s`. The main process owns the buffer and pushes its text; the
 * section shows and hides with the buffer list (src/renderer/buffers.ts),
 * and `C-x k` kills it like any other buffer.
 */

export interface HelpBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

export function installHelpBuffer(): HelpBuffer {
  const host = document.getElementById('help-editor')
  if (host === null) throw new Error('index.html has no #help-editor')

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
        EditorView.theme({}, { dark: matchMedia('(prefers-color-scheme: dark)').matches }),
      ],
    }),
  })

  window.nemesis.onHelpShown((content) => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.text },
      selection: { anchor: 0 },
    })
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === 'help') view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'help') return
      if (outcome.command === 'search-buffer') {
        if (searchPanelOpen(view.state)) findNext(view)
        else openSearchPanel(view)
      } else if (outcome.command === 'keyboard-quit' && searchPanelOpen(view.state)) {
        closeSearchPanel(view)
      }
    },
  }
}
