# 0061 — web_fetch reads Jina's upstream status

## Status

Accepted. Refines the `web_fetch` emptiness check in 0042.

## Context

Jina Reader answers HTTP 200 even when the target site refused it, returning the block page
as content: Cloudflare's "Performing security verification", Reddit's "blocked by network
security", a Vercel checkpoint. These run 80–300 characters, so a length check alone missed
them and the model treated a bot wall as the page. Jina does report the site's own verdict
in `data.httpStatus` and `data.warning` ("This page maybe requiring CAPTCHA…").

## Decision

`jinaFetch` appends a note naming the problem: upstream 401/403/429/5xx, a CAPTCHA warning,
or under 40 characters of content. When the browser is available, the note points at
`get_rendered_page`. A 404/410 gets a "page not found" note with no browser hint. The model
still chooses whether to open the browser, as in 0042.

## Consequences

- Of 429 stored fetches, about 25 were block pages, and the model rarely went to the browser
  unprompted. When the hint was present it followed every time.
- The browser gets past passive JavaScript challenges but not an interactive CAPTCHA.
- Rejected: matching block-page text (brittle, and Jina already classifies it); calling the
  browser automatically from `web_fetch` (rejected in 0042 for hiding a browser session's
  cost behind a cheap-looking tool).
