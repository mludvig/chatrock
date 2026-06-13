// Shared helper for parsing web_search tool results into structured cards.
// Used in both the live-streaming path (chatStore resolveToolCall) and the
// load path (ChatView enriching messages from listMessages).

export interface SearchResult {
  title: string
  url: string
  description: string
}

/**
 * Parse the JSON result of a web_search or web_fetch tool call into a SearchResult array.
 * Returns undefined when the tool is not web_search/web_fetch, when isError is true,
 * when result is missing, or when the JSON cannot be parsed.
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
    if (name === 'web_fetch') {
      const parsed = JSON.parse(result) as { result?: SearchResult }
      return parsed.result ? [parsed.result] : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}
