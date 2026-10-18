# Cap SVG preview upscaling

## Status

Accepted — October 2026. Extends ADR 0064.

## Context

A generated portrait diagram used a 320 × 925 viewBox with 12–18 px text.
The preview filled the conversation width and calculated its height from that
width. A wide card therefore enlarged all text and geometry by more than twice.
Correct aspect ratio alone does not give a suitable reading size.

## Decision

Use an explicit positive numeric SVG width (unitless or px) as the authored
display width. Otherwise use the valid viewBox width. Ignore percentage widths
when selecting this cap.

Centre the SVG in its existing iframe. Its displayed width is the smaller of
the available content width and the authored width. Calculate iframe height from
that same displayed width and the viewBox ratio. Apply the same rule in chat,
expanded views, public shares, and HTML exports. Keep shrinking on narrow screens.
Raw SVG downloads retain the generated source.

The specialist prompt treats SVG coordinates as intended pixel dimensions and
asks for readable typography. Source and stored metadata need no migration.
Legacy SVG without usable sizing information retains the existing height fallback.

## Consequences

- Narrow diagrams keep their authored text size on wide screens.
- Existing saved diagrams benefit without regeneration or database edits.
- Wide charts and diagrams still use available space up to their authored width.
- Small coordinate-system SVGs should specify a numeric display width if they
  are intended to render larger than the viewBox extent.
- Expanded views can show larger authored diagrams at full size; they do not
  automatically magnify narrow posters.

Alternatives considered:

- **Cap only iframe height:** rejected; it can clip content or introduce blank
  space without correcting the scale of the SVG.
- **Reduce all fonts:** rejected; it changes authored layout and leaves other
  geometry enlarged.
- **Guess width from font sizes:** rejected; SVG styles and coordinate systems
  vary, and text does not cover diagrams without labels.
- **Always fill the card:** rejected; it causes the observed oversized text.
- **Regenerate affected visuals:** rejected; rendering can fix saved artifacts.
