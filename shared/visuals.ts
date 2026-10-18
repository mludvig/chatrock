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
export const VISUAL_SIZE_REQUEST = 'chatrock:visual-size-request'

/** Only sizing crosses the sandbox boundary. Never accept code, URLs or actions. */
export function visualMessageHeight(data: unknown, channel: string): number | undefined {
  if (!data || typeof data !== 'object') return
  const d = data as Record<string, unknown>
  if (d.type !== VISUAL_SIZE_MESSAGE || d.channel !== channel ||
    typeof d.height !== 'number' || !Number.isFinite(d.height) || d.height <= 0) return
  return Math.min(MAX_VISUAL_HEIGHT, Math.max(24, Math.ceil(d.height)))
}

function svgViewBox(visual: VisualArtifact): number[] | undefined {
  if (visual.format !== 'svg') return
  const root = visual.source.match(/^\s*<svg\b[^>]*>/i)?.[0] ?? ''
  const viewBox = root.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number)
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) return
  return viewBox
}

/** Authored pixel width: an explicit numeric width, or the viewBox width. */
export function visualSvgWidth(visual: VisualArtifact): number | undefined {
  if (visual.format !== 'svg') return
  const root = visual.source.match(/^\s*<svg\b[^>]*>/i)?.[0] ?? ''
  const declared = Number(root.match(/\swidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i)?.[1])
  if (Number.isFinite(declared) && declared > 0) return declared
  return svgViewBox(visual)?.[2]
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
  // See docs/adr/0066-measure-svg-content-bounds.md. SVG source remains passive;
  // only our nonce-authorized measuring code can run inside its opaque frame.
  const nonce = channel || globalThis.crypto.randomUUID()
  const scripts = visual.format === 'html' ? "'unsafe-inline'" : `'nonce-${nonce}'`
  const policy = `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`
  // The channel is host-created, but escape it for an inline script regardless.
  const token = JSON.stringify(channel).replace(/</g, '\\u003c')
  const svgMeasure = visual.format === 'svg' ? `
const s=document.querySelector('body>svg');
if(s){const v=s.viewBox.baseVal;
if(v.width>0&&v.height>0){const original={x:v.x,y:v.y,width:v.width,height:v.height};
try{const b=s.getBBox(),pad=8;
const x=b.x<original.x?b.x-pad:original.x,y=b.y<original.y?b.y-pad:original.y;
const right=Math.max(original.x+original.width,b.x+b.width+(b.x+b.width>original.x+original.width?pad:0));
const bottom=Math.max(original.y+original.height,b.y+b.height+(b.y+b.height>original.y+original.height?pad:0));
if([x,y,right,bottom].every(Number.isFinite)&&right>x&&bottom>y){
s.setAttribute('viewBox',[x,y,right-x,bottom-y].join(' '));
s.style.setProperty('max-width',(${visualSvgWidth(visual) ?? 0}||original.width)*(right-x)/original.width+'px','important');
s.style.setProperty('aspect-ratio',(right-x)+' / '+(bottom-y),'important')}
}catch{}}}` : ''
  const measure = `<script nonce="${escapeVisualText(nonce)}">(()=>{${svgMeasure}let queued=false,last=0;function measure(){queued=false;const b=document.body;const height=Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height))));if(height!==last){last=height;parent.postMessage({type:'${VISUAL_SIZE_MESSAGE}',channel:${token},height},'*')}}function queue(){if(!queued){queued=true;setTimeout(measure,100)}}new ResizeObserver(queue).observe(document.body);addEventListener('resize',queue);addEventListener('load',queue);queue()})();</script>`
  const authoredWidth = visualSvgWidth(visual)
  const svgStyle = visual.format === 'svg' ? `body>svg{width:100%!important;max-width:${authoredWidth ? `${authoredWidth}px` : '100%'}!important;height:auto!important;margin-inline:auto;display:block}` : ''
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;box-sizing:border-box;background:#fff;color:#172033;font:15px system-ui}body{padding:12px}svg,canvas{max-width:100%;height:auto}${svgStyle}*{box-sizing:border-box;min-width:0;overflow-wrap:anywhere}input,select,button{max-width:100%}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body>${visual.source}${measure}</body></html>`
  const outerPolicy = `default-src 'none'; frame-src about:; style-src 'unsafe-inline'; script-src ${scripts}; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`
  const relay = `<script nonce="${escapeVisualText(nonce)}">(()=>{const f=document.querySelector('iframe');function report(){if(parent!==window)parent.postMessage({type:'${VISUAL_SIZE_MESSAGE}',channel:${token},height:Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(f.getBoundingClientRect().height)))},'*')}addEventListener('message',e=>{const d=e.data;if(!d||d.channel!==${token})return;if(e.source===parent&&d.type==='${VISUAL_SIZE_REQUEST}'){report();return}if(e.source!==f.contentWindow||d.type!=='${VISUAL_SIZE_MESSAGE}'||!Number.isFinite(d.height)||d.height<=0)return;const height=Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(d.height)));f.style.height=height+'px';report()})})();</script>`
  // srcdoc inherits the outer CSP. about: permits srcdoc; remote navigation is denied.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${outerPolicy}"><style>html,body,iframe{margin:0;width:100%;border:0;display:block}iframe{height:${visual.height}px}</style></head><body><iframe title="${escapeVisualText(visual.title)}" sandbox="allow-scripts" srcdoc="${escapeVisualText(inner)}"></iframe>${relay}</body></html>`
}

/** Trusted host code used by public shares and self-contained HTML downloads. */
export const VISUAL_HOST_SCRIPT = `(()=>{
const frames=[...document.querySelectorAll('iframe[data-visual-channel]')];
addEventListener('message',e=>{const d=e.data;if(!d||d.type!=='${VISUAL_SIZE_MESSAGE}'||!Number.isFinite(d.height)||d.height<=0)return;
const f=frames.find(f=>f.contentWindow===e.source&&f.dataset.visualChannel===d.channel);if(f)f.style.height=Math.min(${MAX_VISUAL_HEIGHT},Math.max(24,Math.ceil(d.height)))+'px'});
for(const f of frames){
const request=()=>f.contentWindow?.postMessage({type:'${VISUAL_SIZE_REQUEST}',channel:f.dataset.visualChannel},'*');
f.addEventListener('load',request);request()}
})();`
