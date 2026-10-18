import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

/**
 * The editors' appearance follows the page's (#33). The chrome already reads
 * `prefers-color-scheme` through CSS, which tracks the OS or the pin the main
 * process sets with `nativeTheme.themeSource`; CodeMirror reads its dark flag
 * from an extension instead, so every editor keeps that flag in one shared
 * compartment and a single media listener reconfigures all of them when the
 * appearance changes, without a reload.
 */

const darkQuery = matchMedia('(prefers-color-scheme: dark)')

/** One compartment for every editor: each state keeps its own slot in it. */
const appearance = new Compartment()

/** The views to reconfigure on a change; a view leaves when it is destroyed. */
const views = new Set<EditorView>()

// Built once each: every call to EditorView.theme mints a new style module,
// so two editors switching back and forth would otherwise collect class names.
const LIGHT = EditorView.theme({}, { dark: false })
const DARK = EditorView.theme({}, { dark: true })

function themeFor(dark: boolean): Extension {
  return dark ? DARK : LIGHT
}

darkQuery.addEventListener('change', (event) => {
  const next = themeFor(event.matches)
  for (const view of views) view.dispatch({ effects: appearance.reconfigure(next) })
})

const register = ViewPlugin.define((view) => {
  views.add(view)
  return {
    destroy() {
      views.delete(view)
    },
  }
})

/** The extension every editor installs: the dark flag as it is now, kept current. */
export function followAppearance(): Extension {
  return [appearance.of(themeFor(darkQuery.matches)), register]
}
