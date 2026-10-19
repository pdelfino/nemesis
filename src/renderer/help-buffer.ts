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
 * The help buffer (#65): what describe-command and describe-key answer, as a
 * read-only document in the transcript's style, with the Emacs movement keys
 * and `C-s`. The main process owns the buffer and pushes its text; the
 * section shows and hides with the buffer list (src/renderer/buffers.ts),
 * and `C-x k` kills it like any other buffer.
 *
 * A reader buffer (#128) shows in the same section: its text comes on the
 * same push under its own buffer id, and the section takes the kind of the
 * buffer it shows, so the keys under the point are the reader's. Each
 * buffer's text is kept here, and a switch puts the shown one's back.
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
        followAppearance(),
      ],
    }),
  })

  /** The text of each buffer the section shows, by buffer id. */
  const texts = new Map<string, string>()
  /** The buffer whose text the editor holds. */
  let showing: string | null = null
  const display = (bufferId: string): void => {
    showing = bufferId
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: texts.get(bufferId) ?? '' },
      selection: { anchor: 0 },
    })
  }

  window.nemesis.onHelpShown((content) => {
    texts.set(content.bufferId, content.text)
    display(content.bufferId)
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus.
  window.nemesis.onBuffersChanged((list) => {
    for (const id of [...texts.keys()]) {
      if (!list.buffers.some((buffer) => buffer.id === id)) texts.delete(id)
    }
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === 'help') {
      host.closest('section')?.setAttribute('data-buffer-type', current.kind)
      if (current.id !== showing && texts.has(current.id)) display(current.id)
      view.focus()
    } else if (view.hasFocus) view.contentDOM.blur()
  })

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'help' && bufferType !== 'reader') return
      if (outcome.command === 'search-buffer') {
        if (searchPanelOpen(view.state)) findNext(view)
        else openSearchPanel(view)
      } else if (outcome.command === 'keyboard-quit' && searchPanelOpen(view.state)) {
        closeSearchPanel(view)
      }
    },
  }
}
