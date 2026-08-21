// Keeps `--app-h` in sync with the *visual* viewport so the app chrome never leaves the
// screen when a mobile on-screen keyboard opens.
//
// iOS Safari does not resize the layout viewport for the keyboard: it scrolls the visual
// viewport up to reveal the focused input, dragging the whole page — header included — off
// the top. `100dvh` doesn't help (it tracks the layout viewport) and `position: sticky` can't
// either (the header isn't inside a scrolling container). The fix is to size the app to
// `visualViewport.height` and undo the scroll Safari applied, so the layout fits in the space
// above the keyboard instead of being pushed behind it.
//
// See docs/adr/0028-composer-owns-per-send-controls.md.
export function installViewportHeightTracking() {
  const vv = window.visualViewport
  if (!vv) return // no visualViewport (very old browsers): the 100dvh fallback in app.scss applies

  const apply = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`)
    // Safari scrolls the layout viewport to reveal the focused field; with the app already
    // sized to fit above the keyboard there is nothing to reveal, so put it back.
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }

  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  apply()
}
