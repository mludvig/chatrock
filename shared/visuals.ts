// See docs/adr/0063-general-visual-artifacts-and-response-style.md.
export interface ChartSpec {
  type: 'bar' | 'line' | 'pie'
  labels: string[]
  series: Array<{ name: string; values: number[] }>
  unit?: string
}

export function validateChart(value: unknown): ChartSpec {
  if (!value || typeof value !== 'object') throw new Error('Chart must be an object.')
  const c = value as ChartSpec
  if (!['bar', 'line', 'pie'].includes(c.type)) throw new Error('Chart type must be bar, line or pie.')
  if (!Array.isArray(c.labels) || c.labels.length < 1 || c.labels.length > 24 ||
    c.labels.some(l => typeof l !== 'string' || !l.trim() || l.length > 100)) throw new Error('Chart needs 1–24 short labels.')
  if (!Array.isArray(c.series) || c.series.length < 1 || c.series.length > 3 ||
    c.series.some(s => !s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 100 ||
      !Array.isArray(s.values) || s.values.length !== c.labels.length ||
      s.values.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12))) {
    throw new Error('Chart series must match the labels and contain finite numbers.')
  }
  if (c.unit !== undefined && (typeof c.unit !== 'string' || c.unit.length > 80)) throw new Error('Chart unit must be short text.')
  if (c.type === 'pie' && (c.series.length !== 1 || c.series[0].values.some(v => v < 0) ||
    c.series[0].values.reduce((a, b) => a + b, 0) <= 0)) throw new Error('Pie chart needs one non-negative series with a positive total.')
  return c
}

export interface VisualArtifact {
  title: string
  summary: string
  format: 'svg' | 'html'
  source: string
  height: number
  model?: string
  chart?: ChartSpec
}

// Includes JSON escaping: leaves room in the 32 KB WebSocket frame for its envelope.
export const MAX_VISUAL_BYTES = 20_000

export function validateVisual(value: unknown, maxBytes = MAX_VISUAL_BYTES): VisualArtifact {
  if (!value || typeof value !== 'object') throw new Error('Visual must be an object.')
  const v = value as VisualArtifact
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160) throw new Error('Visual needs a short title.')
  if (typeof v.summary !== 'string' || !v.summary.trim() || v.summary.length > 1000) throw new Error('Visual needs a short text explanation.')
  if (v.format !== 'svg' && v.format !== 'html') throw new Error('Visual format must be svg or html.')
  if (typeof v.source !== 'string' || !v.source.trim()) throw new Error('Visual source is empty.')
  if (!Number.isInteger(v.height) || v.height < 200 || v.height > 800) throw new Error('Visual height must be 200–800.')
  if (v.format === 'svg' && (!/^\s*<svg\b/i.test(v.source) || !/<\/svg>\s*$/i.test(v.source))) {
    throw new Error('SVG must have one complete svg root.')
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(v.source) && v.format === 'svg') throw new Error('SVG declarations are unsupported.')
  if (v.format === 'svg') {
    if (/<(?:script|foreignObject|a|animate\w*|set)\b|\bon[a-z]+\s*=|<\?/i.test(v.source)) throw new Error('SVG must contain passive graphics only.')
    // Keep downloaded vector files self-contained too. Only local fragment
    // references (e.g. arrow markers) are supported, with no escaped CSS URLs.
    const refs = [...v.source.matchAll(/\b(?:[\w-]+:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)]
    if (refs.some(r => !/^["']#[\w.-]+["']$/.test(r[1])) ||
      /@import|\\|url\s*\(\s*(?!["']?#[\w.-]+["']?\s*\))/i.test(v.source)) {
      throw new Error('SVG must use local references only.')
    }
  }
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > maxBytes) throw new Error('Visual is too large. Simplify it.')
  if (v.chart !== undefined) validateChart(v.chart)
  return v
}

export function escapeVisualText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Two opaque-origin frames. The trusted outer document constrains navigation of
 * the generated inner document; the inner CSP blocks network/resource access.
 * Never put generated markup into the application DOM. No message bridge exists.
 */
export function visualDocument(visual: VisualArtifact): string {
  const scripts = visual.format === 'html' ? "'unsafe-inline'" : "'none'"
  const policy = `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;box-sizing:border-box;background:#fff;color:#172033;font:15px system-ui}body{padding:12px}svg,canvas{max-width:100%;height:auto}${visual.format === 'svg' ? 'body>svg{width:100%;height:calc(100vh - 24px);display:block}' : ''}*{box-sizing:border-box}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body>${visual.source}</body></html>`
  const outerPolicy = `default-src 'none'; frame-src about:; style-src 'unsafe-inline'; script-src ${scripts}; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`
  // srcdoc inherits the outer CSP. about: permits srcdoc; remote navigation is denied.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${outerPolicy}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style></head><body><iframe title="${escapeVisualText(visual.title)}" sandbox="${visual.format === 'html' ? 'allow-scripts' : ''}" srcdoc="${escapeVisualText(inner)}"></iframe></body></html>`
}
