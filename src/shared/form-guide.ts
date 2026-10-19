/**
 * The form guide's pane (#94): main pushes what the cockpit shows beside a
 * page buffer while its form is watched, one channel, main to renderer. Its
 * own file, so the cockpit's preload imports nothing the page preload does
 * (electron.vite.config.ts: the two share no chunk).
 */

/** Main to the cockpit's renderer: the guide pane of one page buffer. */
export const FORM_GUIDE_SHOWN_CHANNEL = 'nemesis:form-guide-shown'

export interface FormGuideContent {
  /** The page buffer the pane sits beside. */
  readonly pageId: string
  /** Whether the page is watched; off hides the pane. */
  readonly watching: boolean
  /** The pane's text: the cockpit's header, then the guide's last reply. */
  readonly text: string
}
