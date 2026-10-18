import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { emacs } from '@replit/codemirror-emacs'
import type { BufferType, KeyOutcome } from '../shared/keys'
import type { PlanOutcome } from '../shared/plan'
import { followAppearance } from './theme'

/**
 * The plan buffer (#82): the plan the agent wants to leave plan mode with,
 * as an editable Markdown document in the prompt buffer's style, with the
 * Emacs keys. The guide says to open the plan in an editor before approving
 * it; here it already is one. `C-c C-c` approves the plan as it reads now
 * and `C-c C-k` rejects it with the text as feedback: both reach the main
 * process through the keymap, come back as commands, and this module
 * answers with the text, since the main process never saw the edits.
 *
 * The main process owns the buffer and pushes its text; the section shows
 * and hides with the buffer list (src/renderer/buffers.ts), and `C-x k`
 * kills it like any other buffer, which the main process reads as a
 * rejection.
 */

export interface PlanBuffer {
  readonly view: EditorView
  /** Acts on a command the main process dispatched from a key (#59). */
  onCommand(outcome: KeyOutcome, bufferType: BufferType | null): void
}

const PLAN_ELEMENT_ID = 'plan'

const ANSWERS: Readonly<Record<string, PlanOutcome>> = {
  'approve-plan': 'approve',
  'reject-plan': 'reject',
}

export function installPlanBuffer(): PlanBuffer {
  const host = required('plan-editor')
  const keys = required('plan-keys')

  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      extensions: [
        emacs(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        followAppearance(),
      ],
    }),
  })

  /** The buffer whose plan the editor holds, or null between plans. */
  let bufferId: string | null = null

  window.nemesis.onPlanShown((content) => {
    bufferId = content.bufferId
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.text },
      selection: { anchor: 0 },
    })
    keys.textContent =
      'C-c C-c approves the plan as it reads here, C-c C-k rejects it with this text as feedback'
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so the editor can take the focus. A plan
  // buffer that is gone takes its text with it.
  window.nemesis.onBuffersChanged((list) => {
    if (bufferId !== null && !list.buffers.some((buffer) => buffer.id === bufferId)) {
      bufferId = null
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
      keys.textContent = ''
    }
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === PLAN_ELEMENT_ID) view.focus()
    else if (view.hasFocus) view.contentDOM.blur()
  })

  return {
    view,
    onCommand(outcome, bufferType) {
      if (bufferType !== 'plan' || outcome.command === undefined) return
      const answer = ANSWERS[outcome.command]
      if (answer === undefined || bufferId === null) return
      window.nemesis
        .answerPlan({ bufferId, outcome: answer, text: view.state.doc.toString() })
        .catch((error: unknown) => {
          console.error('Could not answer the plan:', error)
        })
    },
  }
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`index.html has no #${id}`)
  return element
}
