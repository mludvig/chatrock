// Shared helper for parsing web_search/web_fetch-shaped tool results into structured cards.
// Used in both the live-streaming path (chatStore resolveToolCall) and the
// load path (ChatView enriching messages from listMessages).

export interface SearchResult {
  title: string
  url: string
  description: string
}

/**
 * Parse the JSON result of a web_search/web_fetch/get_rendered_page tool call into a
 * SearchResult array. get_rendered_page reuses web_fetch's exact {result,text} envelope
 * shape so it renders via the same card here, rather than a duplicate code path.
 * Returns undefined when the tool isn't one of these, when isError is true, when result
 * is missing, or when the JSON cannot be parsed.
 */
export function parseSearchResults(
  name: string,
  result: string | undefined,
  isError: boolean | undefined,
): SearchResult[] | undefined {
  if (!result || isError) return undefined
  try {
    if (name === 'web_search') {
      const parsed = JSON.parse(result) as { results?: SearchResult[] }
      return parsed.results
    }
    if (name === 'web_fetch' || name === 'get_rendered_page') {
      const parsed = JSON.parse(result) as { result?: SearchResult }
      return parsed.result ? [parsed.result] : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}
