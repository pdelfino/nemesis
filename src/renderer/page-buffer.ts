/**
 * The page section (#119). A page buffer's view is the main process's, laid
 * over this window at the rectangle this module reports: the page section's
 * box while a page buffer is current and the palette is closed, else null,
 * which hides the view. The palette is drawn by this page, and a view over
 * the page would cover it, so the view gives way while it is open, as Nyxt's
 * prompt buffer does. Keys and focus inside a page are M4.2's; here the
 * section only takes the point when its buffer becomes current, so the
 * cockpit's keys see a page buffer.
 */
export function installPageBuffer(): void {
  const section = document.getElementById('page')
  const palette = document.getElementById('palette')
  if (section === null || palette === null) throw new Error('index.html has no #page or #palette')

  let last = 'none'
  const report = (): void => {
    const box = section.hidden || !palette.hidden ? null : section.getBoundingClientRect()
    const bounds =
      box === null || box.width === 0 || box.height === 0
        ? null
        : { x: box.left, y: box.top, width: box.width, height: box.height }
    // Every layout change lands here; only a different rectangle crosses the bridge.
    const key = JSON.stringify(bounds)
    if (key === last) return
    last = key
    window.nemesis.setPageBounds(bounds).catch((error: unknown) => {
      console.error('Could not report the page bounds:', error)
    })
  }

  new ResizeObserver(report).observe(section)
  const hidden = new MutationObserver(report)
  hidden.observe(section, { attributes: true, attributeFilter: ['hidden'] })
  hidden.observe(palette, { attributes: true, attributeFilter: ['hidden'] })
  window.addEventListener('resize', report)

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so it can take the focus.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === 'page') section.focus()
    report()
  })
}
