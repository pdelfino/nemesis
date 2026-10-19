import type { WebContentsView } from 'electron'
import type { SemanticRect } from './semantic'

/**
 * The captures of `browser_screenshot` (#140, ADR 0008), each a PNG, base64.
 *
 * - The viewport, or one element's box of it, is Chromium's `capturePage`,
 *   the box turned from CSS pixels into the view's by the page's zoom. The
 *   page stays hidden when it is not the current buffer.
 * - The whole page is the DevTools protocol's `Page.captureScreenshot` with
 *   `captureBeyondViewport`, through `webContents.debugger`: attached for
 *   the call, that one method sent, detached after it, so the page never
 *   scrolls and nothing else of the protocol is reached. A page whose
 *   debugger is already attached (its DevTools open) is refused.
 */

/** The DevTools protocol version the debugger attaches with. */
const PROTOCOL = '1.3'

function viewOf(view: WebContentsView | undefined): WebContentsView {
  if (view === undefined || view.webContents.isDestroyed()) throw new Error('The page is gone')
  return view
}

export async function capturePage(
  given: WebContentsView | undefined,
  box?: SemanticRect,
): Promise<string> {
  const contents = viewOf(given).webContents
  const factor = contents.getZoomFactor()
  const rect =
    box === undefined
      ? undefined
      : {
          x: Math.round(box.x * factor),
          y: Math.round(box.y * factor),
          width: Math.max(1, Math.round(box.width * factor)),
          height: Math.max(1, Math.round(box.height * factor)),
        }
  const image = await contents.capturePage(rect, { stayHidden: true })
  if (image.isEmpty()) throw new Error('The capture came back empty: the page has nothing drawn')
  return image.toPNG().toString('base64')
}

export async function captureFullPage(given: WebContentsView | undefined): Promise<string> {
  const { debugger: protocol } = viewOf(given).webContents
  if (protocol.isAttached()) {
    throw new Error('The page is under DevTools already: close them and ask again')
  }
  protocol.attach(PROTOCOL)
  try {
    const answer: unknown = await protocol.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    const data = (answer as { readonly data?: unknown } | null)?.data
    if (typeof data !== 'string') throw new Error('The full-page capture came back without data')
    return data
  } finally {
    if (protocol.isAttached()) protocol.detach()
  }
}
