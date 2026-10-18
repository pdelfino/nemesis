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
 * The environment buffer (#86): the CLAUDE.md files, permission rules,
 * hooks, skills, MCP servers and subagents of the session's working
 * directory, as a read-only document in the help buffer's style, with the
 * Emacs movement keys and `C-s`. The main process owns the buffer, reads
 * the files and pushes the text; the section shows and hides with the
 * buffer list (src/renderer/buffers.ts), and `C-x k` kills it like any
 * other buffer. `RET` reaches the main process through the keymap, which
 * opens a listed file through the open door; the line under the editor
 * says so.
 */

export interface EnvironmentBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

const ENVIRONMENT_ELEMENT_ID = 'environment'

const KEYS_HINT = 'RET opens a listed file with the default application, after a yes'

export function installEnvironmentBuffer(): EnvironmentBuffer {
  const host = required('environment-editor')
  const keys = required('environment-keys')

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

  window.nemesis.onEnvironmentShown((content) => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.text },
      selection: { anchor: 0 },
    })
    keys.textContent = KEYS_HINT
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === ENVIRONMENT_ELEMENT_ID) view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'environment') return
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
