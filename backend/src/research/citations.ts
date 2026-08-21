// report.ts's system prompt (prompts/research-report.txt) requires the Sources section as
// plain "n. <url>" lines — parsed here to build the citation-number -> URL map, then used to
// rewrite both the Sources list and every inline [n] marker into markdown links. Deterministic
// text rewrite rather than asking the model to emit link syntax itself, since a raw URL is
// far more reliable to get right than markdown-link nesting inside prose.
const SOURCE_LINE_RE = /^(\s*)(\d+)\.\s+(https?:\/\/\S+)\s*$/gm

export function linkifyReportCitations(text: string): string {
  const urlByNumber = new Map<string, string>()
  for (const m of text.matchAll(SOURCE_LINE_RE)) {
    urlByNumber.set(m[2], m[3])
  }
  if (urlByNumber.size === 0) return text

  const withInlineLinks = text.replace(/\[(\d+)\](?!\()/g, (match, num: string) => {
    const url = urlByNumber.get(num)
    return url ? `[${num}](${url})` : match
  })

  return withInlineLinks.replace(SOURCE_LINE_RE, (_match, indent: string, num: string, url: string) =>
    `${indent}${num}. [${url}](${url})`)
}
