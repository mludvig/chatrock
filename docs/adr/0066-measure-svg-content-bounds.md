# Measure SVG content bounds

## Status

Accepted — October 2026. Extends ADRs 0064 and 0065.

## Context

A saved SVG placed its final text below its declared viewBox. Calculating the
iframe height from that viewBox preserved scale but still clipped the text.
Increasing the iframe height cannot reveal graphics clipped by the SVG viewport.

## Decision

Measure the root SVG with the browser's `getBBox()` before reporting document
height. Extend the viewBox only where content exceeds it, with eight coordinate
units of padding. Retain the original bounds and adjust the authored width cap
proportionally when the horizontal bounds extend, to preserve the authored scale.

Use the same bounded height relay for SVG and HTML in chat, expanded previews,
public shares and HTML exports. Every frame remains an opaque origin. SVG source
validation still rejects scripts, event handlers, animation and external resources.
SVG frames permit scripts solely so nonce-authorized host measurement and relay
code can run. CSP rejects other scripts and still blocks network access, navigation,
frames, forms and workers in the generated document. The parent accepts only a
finite bounded height from its own frame with the matching channel.

No stored content is modified. Raw SVG downloads retain the authored source;
the browser bounds correction applies to the embedded preview and HTML exports.
The generation prompt also requires all text and bottom padding inside the viewBox.

## Consequences

- Saved visuals show text that extends beyond their declared viewport.
- Wide screens retain the authored text size; phones still shrink the whole visual.
- Browser text metrics determine the required space rather than font estimates.
- Bounds correction does not repair overlapping labels or intentionally clipped
  content inside nested SVG viewports or clip paths.
- The existing 20,000 pixel height limit remains, with iframe scrolling beyond it.

Alternatives considered:

- **Increase the iframe height:** cannot undo SVG viewport clipping.
- **Make SVG overflow visible:** does not determine the needed iframe height and
  leaves content outside its layout box.
- **Estimate bounds on the server:** font metrics, transforms and SVG layout need
  a browser; parser estimates would miss valid graphics.
- **Regenerate the SVG:** costs inference and does not help existing saved visuals.
- **Run generated SVG scripts:** unnecessary; retain passive validation and permit
  only nonce-authorized trusted measurement code.
