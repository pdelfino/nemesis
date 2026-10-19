import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  search,
  searchPanelOpen,
} from '@codemirror/search'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { BufferList } from '../shared/buffers'
import type { BufferType, KeyOutcome } from '../shared/keys'
import type { ReviewContent } from '../shared/review'
import { followAppearance } from './theme'

/**
 * The review buffer (#87): the findings a reviewer window's fresh session
 * reported on the writer's diff, as a read-only Markdown document in the
 * spec buffer's style, with the Emacs movement keys and `C-s`. The main
 * process owns the buffers and pushes each one's content; several review
 * buffers share this section, as the spec buffers share theirs: the current
 * one is shown, or the last one opened while the point is elsewhere, and a
 * killed buffer's content goes with it. `C-c C-c` reaches the main process
 * through the keymap and sends the findings to the writer's session there;
 * the line under the editor says so.
 */

export interface ReviewBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

const REVIEW_ELEMENT_ID = 'review'

const KEYS_HINT = 'C-c C-c sends these findings to this session, to be addressed one by one'

export function installReviewBuffer(): ReviewBuffer {
  const host = required('review-editor')
  const from = required('review-from')
  const keys = required('review-keys')

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
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        followAppearance(),
      ],
    }),
  })

  /** The content of every open review buffer, by buffer id. */
  const contents = new Map<string, ReviewContent>()
  /** The buffer the editor shows, or null. */
  let shownId: string | null = null

  function show(content: ReviewContent | null): void {
    shownId = content?.bufferId ?? null
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content?.text ?? '' },
      selection: { anchor: 0 },
    })
    from.textContent = content === null ? '' : `Review by ${content.reviewer}`
    keys.textContent = content === null ? '' : KEYS_HINT
  }

  window.nemesis.onReviewShown((content) => {
    contents.set(content.bufferId, content)
    show(content)
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus.
  window.nemesis.onBuffersChanged((list: BufferList) => {
    for (const id of [...contents.keys()]) {
      if (!list.buffers.some((buffer) => buffer.id === id)) contents.delete(id)
    }
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    const wanted =
      current !== undefined && contents.has(current.id)
        ? (contents.get(current.id) ?? null)
        : shownId !== null && contents.has(shownId)
          ? (contents.get(shownId) ?? null)
          : ([...contents.values()].at(-1) ?? null)
    if ((wanted?.bufferId ?? null) !== shownId) show(wanted)
    if (current?.elementId === REVIEW_ELEMENT_ID) view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'review') return
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
