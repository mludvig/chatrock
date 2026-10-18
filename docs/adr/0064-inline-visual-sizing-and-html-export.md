# Inline visual sizing and HTML export

## Status

Accepted — October 2026. Extends ADR 0063's visual presentation.

## Context

Fixed-height frames force users to scroll inside a visual or manually expand it.
The useful output should open in the conversation and grow with its content.
Generated code must remain isolated from the application origin. Opaque sandboxed
frames prevent the host from reading the generated document's DOM directly.

Markdown cannot preserve HTML controls or JavaScript. Including all source code
in a clean transcript obscures the answer and does not produce a working visual.

## Decision

Show successful visual results inline automatically. Keep Expand as an optional
wider view. Keep both opaque sandboxed frames and their content policies.

For HTML, a small injected ResizeObserver measures the content's body. It reports
only height to the trusted outer document. The outer document checks the sending
window, message type, channel and finite positive height, then relays a bounded
height to the host. The React/public host checks its own frame's window and channel.
No URL, command, source, credential, or general application message crosses this
bridge. Cap height at 20,000 px and coalesce measurements to at most ten per second.
The host requests the current height after installing its listener and when the
frame loads. This recovers measurements emitted before host setup in long shares
or saved HTML. The outer frame accepts requests only from its parent, with the
matching channel.
ResizeObserver catches width and content changes, including opened details.

For SVG, calculate height from the root viewBox and host width. No script is added
to the generated SVG. Legacy SVG without a usable viewBox keeps its height hint.
Generated HTML is prompted to use normal document flow rather than viewport-height
layouts or nested scroll regions. Stored artifacts and provider replay are unchanged.

Offer a self-contained HTML conversation download, including interactive visuals.
Add `.html` to public share routes for a download with the same ownership/revocation
checks as the existing page and Markdown version. Use the same sizing code in
chat, public shares, and downloaded HTML.

Clean Markdown contains visual summaries and numeric chart tables. Public Markdown
links to the HTML share. Including tool calls also includes visual source code.
The private export remains JWT-authenticated and never creates a public share.

## Consequences

- Visuals scroll with the conversation and resize when their content changes.
- Existing saved visuals gain the new presentation without regeneration.
- The message bridge adds a narrow boundary that requires source/channel checks
  and browser tests for spoofed messages. It does not grant same-origin access.
- Malicious height requests can affect only their own visual, within the height cap.
  Isolation still does not guarantee a bound on generated JavaScript CPU use.
- A blocked or malformed generated document can fail to measure; the saved height
  remains the fallback. Viewport-dependent layouts can still be imperfect.
- HTML keeps interaction offline. Attachment links retain their existing signed
  URL expiry; HTML export does not make external attachments permanent.
- Markdown is more readable. Readers who need code can include tool calls or use
  the HTML download.

Alternatives considered:

- Inject HTML directly into the chat DOM: rejected; it exposes application storage.
- Add `allow-same-origin` and read the iframe DOM: rejected; it weakens isolation.
- Automatically open a fullscreen modal: rejected; it interrupts the conversation.
- Use a larger fixed height: rejected; it leaves clipping and nested scrolling.
- Render every interactive as a screenshot: rejected; it loses the controls.
- Put an executable iframe in Markdown: rejected; many Markdown viewers strip it,
  and JavaScript support varies. HTML is the useful interactive download.
