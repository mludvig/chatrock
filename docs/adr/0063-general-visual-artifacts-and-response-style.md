# General visual artifacts and response style

## Status

Accepted — initial implementation, October 2026.

## Context

The useful visual outputs are charts, org charts, flow diagrams, and interactive
explanations. Photo generation is rarely needed. A dedicated LED-matrix tool would
solve only one example. The Codex concise-and-visual skill provides a useful style:
lead with the result and choose the smallest visual that adds understanding.

The narrator can be a small model. Complex visual code needs a stronger model.
Numeric chart geometry must follow actual values. Generated HTML/JS must not run
inside the application origin or access its credentials. Visual results must
survive a dropped socket, reload, fork, share, and export.

## Decision

Offer one general `create_visual` tool. Numeric bar, line, and pie specifications
are validated and rendered deterministically as SVG. Show their exact data in a
table. Other diagrams and interactive HTML are authored by `VISUAL_MODEL` in
`models.ts`, initially GPT-6.1 Sol, independently of the narrator. The specialist sees
only a self-contained brief. Allow one bounded repair of malformed/oversized output.
The existing heartbeat covers the specialist call.

Default to a concise-and-visual prompt fragment. User, project, and chat preferences
can select Standard. Answer length remains independent. Explicit user instructions
take priority. The tool remains available in Standard for explicit visual requests.
Research sub-agents do not get the tool.

Persist the bounded source as typed `tool_result.visual` metadata in the existing
canonical turn. Send the same metadata in live results. Provider adapters replay
the short textual result rather than visual source. The entire serialized artifact
is limited to 20 KB, with a lower cap when sharing a round's aggregate budget.
This keeps WebSocket frames and DynamoDB items bounded. It avoids a separate
artifact service or expiring source URL in this initial version.

Render SVG/HTML through two sandboxed, opaque-origin iframes. The trusted outer
document restricts inner navigation; the inner content policy blocks remote
resources, fetch, forms, workers, frames, and base URLs. Only HTML allows inline
scripts. No parent message bridge or shared storage exists. The same wrapper
protects public shares and downloaded HTML. Render titles and summaries as text.
Support Expand, Download, Replay, reduced motion, and an inspectable data table.
Custom HTML animations must provide their own Pause/Play controls.

Retire the Stability generator, its toggle, and provider module. Ignore stored
legacy image-generation settings. Keep historical image results renderable.

## Consequences

- Diagrams and charts work across chat providers, without third-party image keys.
- The specialist call adds latency and token cost; deterministic charts avoid it.
  Its calls have their own `visual` usage log. The normal narrator token total does
  not include specialist calls, matching the existing research-tool accounting.
- The source-size limit favours compact explanations. Large artifacts can move to
  S3 with typed references later. Inline storage simplifies correct fork/delete.
- Syntax/size validation does not prove that a generated diagram is factually or
  visually correct. Validate representative outputs in the browser. Numeric chart
  data and geometry are validated separately.
- HTML can still consume browser CPU. Isolation protects credentials/network, not
  resource usage. Leaving the chat removes its frames; animation guidance requires
  pause and reduced motion. A worker timeout is future work for larger simulations.

Alternatives considered:

- **A matrix-specific tool:** rejected; it does not cover the main use cases.
- **Only Markdown/Mermaid:** useful for simple answers but cannot provide rich
  interaction, code animation, or arbitrary SVG. Mermaid is not currently rendered.
- **Only SVG:** retained for passive visuals; HTML is needed for meaningful controls
  and Canvas animation.
- **Let the narrator write all code:** cheaper, but ties visual quality to the chat
  model. A configurable specialist provides consistent capability.
- **Let a model draw numerical charts:** rejected; deterministic geometry and a data
  table are more reliable.
- **Inject generated HTML into React:** rejected; it shares the application origin.
- **A single sandboxed iframe:** protects the parent, but its own navigation needs
  a trusted enclosing content policy. Use a second frame and test blocked navigation.
- **S3 source files immediately:** deferred; small inline artifacts satisfy the
  existing recovery and transcript contract with fewer moving parts.
- **Keep photo generation in the active tool set:** rejected for current needs.
  Historical generated images remain available.
