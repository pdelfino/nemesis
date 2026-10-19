import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { FormGuideContent } from '../shared/form-guide'
import { followAppearance } from './theme'

/**
 * The form guide's pane (#94): the guide's reply beside a watched page, as
 * a read-only document. The main process pushes each watched page's text;
 * the pane shows while the current buffer is a watched page and hides
 * otherwise, and the page section beside it gives up the width, so the
 * page's view never covers it. The pane never takes the point: the keys
 * stay the page's, where the human is typing.
 */
export function installFormGuide(): void {
  const pane = document.getElementById('form-guide')
  const host = document.getElementById('form-guide-editor')
  if (pane === null || host === null) throw new Error('index.html has no #form-guide')

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      extensions: [
        emacs(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        followAppearance(),
      ],
    }),
  })

  /** The text of each watched page, by page buffer id. */
  const texts = new Map<string, string>()
  let current: string | null = null
  let showing: string | null = null

  const render = (): void => {
    const text = current === null ? undefined : texts.get(current)
    pane.hidden = text === undefined
    if (text === undefined) {
      showing = null
      return
    }
    if (showing === current && view.state.doc.toString() === text) return
    showing = current
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }

  window.nemesis.onFormGuideShown((content: FormGuideContent) => {
    if (content.watching) texts.set(content.pageId, content.text)
    else texts.delete(content.pageId)
    render()
  })

  window.nemesis.onBuffersChanged((list) => {
    for (const id of [...texts.keys()]) {
      if (!list.buffers.some((buffer) => buffer.id === id)) texts.delete(id)
    }
    const buffer = list.buffers.find((one) => one.id === list.currentId)
    current = buffer?.elementId === 'page' ? buffer.id : null
    render()
  })
}
