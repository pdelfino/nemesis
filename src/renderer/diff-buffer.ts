import { unifiedMergeView } from '@codemirror/merge'
import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  search,
  searchPanelOpen,
} from '@codemirror/search'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { BufferList } from '../shared/buffers'
import type { SessionDiff } from '../shared/diff'
import type { BufferType, KeyOutcome } from '../shared/keys'
import { followAppearance } from './theme'

/**
 * The diff buffer (#68): one Edit or Write of the session as a unified diff,
 * drawn by CodeMirror's merge view over the new text with the old text as
 * the original, so a deleted line sits above the line that replaced it and
 * the changed words are marked. Read-only, with the Emacs movement keys and
 * `C-s`, like the help buffer; there are no accept or reject controls, since
 * the SDK has already applied the change.
 *
 * The main process owns the buffers and pushes each one's content. Several
 * diff buffers share this section, as the request buffers share theirs: the
 * current one is shown, or the last one opened while the point is elsewhere,
 * and a killed buffer's content goes with it. `C-c C-o` reaches the main
 * process through the keymap; the line under the editor says so.
 */

export interface DiffBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

const DIFF_ELEMENT_ID = 'diff'

export function installDiffBuffer(): DiffBuffer {
  const host = required('diff-editor')
  const file = required('diff-file')
  const keys = required('diff-keys')

  const base: Extension = [
    Prec.highest(
      keymap.of([{ key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' }]),
    ),
    emacs(),
    EditorState.readOnly.of(true),
    search(),
    EditorView.lineWrapping,
    followAppearance(),
  ]

  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({ extensions: base }),
  })

  /** The content of every open diff buffer, by buffer id, in the order it arrived. */
  const contents = new Map<string, SessionDiff>()
  let list: BufferList | null = null
  let shownId: string | null = null

  window.nemesis.onDiffShown((content) => {
    contents.set(content.bufferId, content.diff)
    choose()
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus.
  window.nemesis.onBuffersChanged((next) => {
    list = next
    for (const id of [...contents.keys()]) {
      if (!next.buffers.some((buffer) => buffer.id === id)) contents.delete(id)
    }
    choose()
    const current = next.buffers.find((buffer) => buffer.id === next.currentId)
    if (current?.elementId === DIFF_ELEMENT_ID) view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  /** The current diff buffer's content, else the one shown so far, else the newest. */
  function choose(): void {
    const currentId = list?.currentId ?? null
    const id =
      currentId !== null && contents.has(currentId)
        ? currentId
        : shownId !== null && contents.has(shownId)
          ? shownId
          : ([...contents.keys()].at(-1) ?? null)
    if (id === shownId) return
    shownId = id
    render(id === null ? null : (contents.get(id) ?? null))
  }

  function render(diff: SessionDiff | null): void {
    if (diff === null) {
      file.textContent = ''
      keys.textContent = ''
      view.setState(EditorState.create({ extensions: base }))
      return
    }
    file.textContent = `${diff.tool} ${diff.filePath}`
    keys.textContent = 'C-c C-o opens the file with the default application, after a yes'
    view.setState(
      EditorState.create({
        doc: diff.newText,
        extensions: [
          base,
          unifiedMergeView({
            original: diff.oldText,
            mergeControls: false,
            gutter: true,
            highlightChanges: true,
            collapseUnchanged: { margin: 3, minSize: 4 },
          }),
        ],
      }),
    )
  }

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'diff') return
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
