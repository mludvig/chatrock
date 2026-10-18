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
export const MAX_VISUAL_HEIGHT = 20_000
export const VISUAL_SIZE_MESSAGE = 'chatrock:visual-size'

/** Only sizing crosses the sandbox boundary. Never accept code, URLs or actions. */
export function visualMessageHeight(data: unknown, channel: string): number | undefined {
  if (!data || typeof data !== 'object') return
  const d = data as Record<string, unknown>
  if (d.type !== VISUAL_SIZE_MESSAGE || d.channel !== channel ||
    typeof d.height !== 'number' || !Number.isFinite(d.height) || d.height <= 0) return
  return Math.min(MAX_VISUAL_HEIGHT, Math.max(24, Math.ceil(d.height)))
}

export function visualAspectRatio(visual: VisualArtifact): number | undefined {
  if (visual.format !== 'svg') return
  const root = visual.source.match(/^\s*<svg\b[^>]*>/i)?.[0] ?? ''
  const viewBox = root.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number)
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) return
  return viewBox[2] / viewBox[3]
}

export function visualSvgHeight(width: number, ratio: number): number {
  return Math.min(MAX_VISUAL_HEIGHT, Math.max(24, Math.ceil(Math.max(0, width - 24) / ratio + 24)))
}

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
 * Never put generated markup into the application DOM. The only bridge reports
 * bounded height through the trusted outer frame. See ADR 0064.
 */
export function visualDocument(visual: VisualArtifact, channel = ''): string {
  const scripts = visual.format === 'html' ? "'unsafe-inline'" : "'none'"
  const policy = `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`
  // The channel is host-created, but escape it for an inline script regardless.
  const token = JSON.stringify(channel).replace(/</g, '\\u003c')
  const measure = visual.format === 'html' ? `<script>(()=>{let queued=false,last=0;function measure(){queued=false;const b=document.body;const height=Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height))));if(height!==last){last=height;parent.postMessage({type:'${VISUAL_SIZE_MESSAGE}',channel:${token},height},'*')}}function queue(){if(!queued){queued=true;setTimeout(measure,100)}}new ResizeObserver(queue).observe(document.body);addEventListener('resize',queue);addEventListener('load',queue);queue()})();</script>` : ''
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;box-sizing:border-box;background:#fff;color:#172033;font:15px system-ui}body{padding:12px}svg,canvas{max-width:100%;height:auto}${visual.format === 'svg' ? 'body>svg{width:100%;height:calc(100vh - 24px);display:block}' : ''}*{box-sizing:border-box;min-width:0;overflow-wrap:anywhere}input,select,button{max-width:100%}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body>${visual.source}${measure}</body></html>`
  const outerPolicy = `default-src 'none'; frame-src about:; style-src 'unsafe-inline'; script-src ${scripts}; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`
  const relay = visual.format === 'html' ? `<script>addEventListener('message',e=>{const f=document.querySelector('iframe'),d=e.data;if(e.source!==f.contentWindow||!d||d.type!=='${VISUAL_SIZE_MESSAGE}'||d.channel!==${token}||!Number.isFinite(d.height)||d.height<=0)return;const height=Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(d.height)));f.style.height=height+'px';if(parent!==window)parent.postMessage({type:'${VISUAL_SIZE_MESSAGE}',channel:${token},height},'*')});</script>` : ''
  // srcdoc inherits the outer CSP. about: permits srcdoc; remote navigation is denied.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${outerPolicy}"><style>html,body,iframe{margin:0;width:100%;border:0;display:block}${visual.format === 'svg' ? 'html,body,iframe{height:100%}' : `iframe{height:${visual.height}px}`}</style></head><body><iframe title="${escapeVisualText(visual.title)}" sandbox="${visual.format === 'html' ? 'allow-scripts' : ''}" srcdoc="${escapeVisualText(inner)}"></iframe>${relay}</body></html>`
}

/** Trusted host code used by public shares and self-contained HTML downloads. */
export const VISUAL_HOST_SCRIPT = `(()=>{
const frames=[...document.querySelectorAll('iframe[data-visual-channel]')];
addEventListener('message',e=>{const d=e.data;if(!d||d.type!=='${VISUAL_SIZE_MESSAGE}'||!Number.isFinite(d.height)||d.height<=0)return;
const f=frames.find(f=>f.contentWindow===e.source&&f.dataset.visualChannel===d.channel);if(f)f.style.height=Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(d.height)))+'px'});
for(const f of frames){const ratio=Number(f.dataset.visualRatio);if(ratio>0&&Number.isFinite(ratio)){
const size=()=>f.style.height=Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(Math.max(0,f.getBoundingClientRect().width-24)/ratio+24)))+'px';
new ResizeObserver(size).observe(f);size()}}
})();`
