import { foldedRanges, foldGutter, toggleFold, unfoldEffect } from '@codemirror/language'
import {
  closeSearchPanel,
  findNext,
  openSearchPanel,
  searchPanelOpen,
  setSearchQuery,
  type SearchQuery,
} from '@codemirror/search'
import { EditorSelection, EditorState, Prec, type StateEffect } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { BufferType, KeyOutcome } from '../shared/keys'
import { followAppearance } from './theme'
import { lineWithText, transactionFor, transcriptExtensions } from './transcript-doc'

/**
 * The transcript buffer (#62): the session as one read-only CodeMirror
 * document, built from the pure half in transcript-doc.ts. Appending is the
 * only write. CodeMirror redraws the lines a change touched, so a reply
 * streaming in leaves the lines above it alone, and the viewport follows the
 * stream only while the point is at the end of the document, as a comint
 * buffer does. Reading an earlier turn stays where it is.
 *
 * The cockpit's chords reach this module through onCommand (`C-s` is
 * `search-buffer`, `C-g` is `keyboard-quit`); every other key, `M-w` and the
 * Emacs movement included, is the editor's own. `C-s` is incremental: the
 * point moves to the first match from where the search started as the query
 * grows, and `C-s` again steps to the next one. Nothing here is persisted:
 * that is #64. A search match opened from the palette (#69) arrives as a
 * line to go to: the point moves there, unfolding what hides it, and the
 * active line shows which one it is.
 */

export interface TranscriptBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

export function installTranscriptBuffer(): TranscriptBuffer {
  const host = document.getElementById('transcript-editor')
  if (host === null) throw new Error('index.html has no #transcript-editor')

  // Where the point was when `C-s` opened the panel: incremental search runs
  // from there as the query grows, so a longer query never skips the match a
  // shorter one landed on. Null while the panel is closed.
  let searchOrigin: number | null = null

  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      extensions: [
        Prec.highest(
          keymap.of([
            { key: 'Tab', run: toggleFold },
            // The search panel binds nothing by itself; ESC leaves it, as C-g does.
            { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
          ]),
        ),
        emacs(),
        transcriptExtensions(),
        foldGutter(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        followAppearance(),
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            for (const effect of tr.effects) {
              if (effect.is(setSearchQuery)) queueMicrotask(() => jumpTo(effect.value))
            }
          }
          if (searchOrigin !== null && !searchPanelOpen(update.state)) searchOrigin = null
        }),
      ],
    }),
  })

  window.nemesis.onAgentEvent((event) => {
    const spec = transactionFor(view.state, event)
    if (spec !== null) view.dispatch(spec)
  })

  // The current buffer carries the point (#60): focus follows it.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === 'transcript') view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  // A search match (#69): the point goes to the line, out of any fold.
  window.nemesis.onTranscriptGoto((target) => {
    const line = lineWithText(view.state.doc, target.text)
    if (line === null) return
    const effects: StateEffect<unknown>[] = []
    foldedRanges(view.state).between(line.from, line.to, (from, to) => {
      effects.push(unfoldEffect.of({ from, to }))
    })
    view.dispatch({ selection: EditorSelection.cursor(line.from), effects, scrollIntoView: true })
  })

  /** Incremental search: the first match from the origin, wrapping around. */
  function jumpTo(query: SearchQuery): void {
    if (searchOrigin === null || !query.valid || !searchPanelOpen(view.state)) return
    const match = firstMatch(view.state, query, searchOrigin)
    if (match === null) return
    view.dispatch({
      selection: EditorSelection.range(match.from, match.to),
      scrollIntoView: true,
    })
  }

  function startOrContinueSearch(): void {
    if (searchPanelOpen(view.state)) {
      findNext(view)
      return
    }
    searchOrigin = view.state.selection.main.from
    openSearchPanel(view)
  }

  function quit(): void {
    if (searchPanelOpen(view.state)) {
      closeSearchPanel(view)
      return
    }
    const head = view.state.selection.main.head
    view.dispatch({ selection: EditorSelection.cursor(head) })
  }

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'transcript') return
      if (outcome.command === 'search-buffer') startOrContinueSearch()
      else if (outcome.command === 'keyboard-quit') quit()
    },
  }
}

function firstMatch(
  state: EditorState,
  query: SearchQuery,
  origin: number,
): { from: number; to: number } | null {
  const ahead = query.getCursor(state, origin).next()
  if (!ahead.done) return ahead.value
  const wrapped = query.getCursor(state, 0, origin).next()
  return wrapped.done ? null : wrapped.value
}
