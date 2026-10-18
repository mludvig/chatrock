import { escapeVisualText as esc, validateChart, type ChartSpec, type VisualArtifact } from '../../../../shared/visuals'

const COLOURS = ['#2563eb', '#7c3aed', '#08916f', '#d97706', '#db2777', '#475569']

export { validateChart } from '../../../../shared/visuals'

const short = (s: string) => s.length > 18 ? s.slice(0, 17) + '…' : s

export function renderChart(title: string, chart: ChartSpec): VisualArtifact {
  const c = validateChart(chart)
  const text = (x: number, y: number, label: string, extra = '') =>
    `<text x="${x}" y="${y}" ${extra}>${esc(label)}</text>`
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 440" role="img" aria-labelledby="chart-title"><title id="chart-title">${esc(title)}</title>`,
    '<style>text{font:13px system-ui;fill:#334155}.heading{font-size:20px;font-weight:600}</style>',
    '<rect width="720" height="440" fill="#fff"/>', text(24, 32, short(title), 'class="heading"'),
  ]
  if (c.type === 'pie') {
    const values = c.series[0].values
    const total = values.reduce((a, b) => a + b, 0)
    let angle = -Math.PI / 2
    values.forEach((value, i) => {
      const next = angle + value / total * Math.PI * 2
      const colour = COLOURS[i % COLOURS.length]
      if (value === total) parts.push(`<circle cx="210" cy="230" r="140" fill="${colour}"/>`)
      else if (value > 0) {
        const x1 = 210 + 140 * Math.cos(angle), y1 = 230 + 140 * Math.sin(angle)
        const x2 = 210 + 140 * Math.cos(next), y2 = 230 + 140 * Math.sin(next)
        parts.push(`<path d="M210 230 L${x1} ${y1} A140 140 0 ${value / total > .5 ? 1 : 0} 1 ${x2} ${y2} Z" fill="${colour}" stroke="#fff"/>`)
      }
      const y = 78 + i * Math.min(28, 330 / values.length)
      parts.push(`<rect x="385" y="${y - 11}" width="12" height="12" fill="${colour}"/>`,
        text(406, y, `${short(c.labels[i])}: ${value} (${(value / total * 100).toFixed(1)}%)`))
      angle = next
    })
  } else {
    const all = c.series.flatMap(s => s.values)
    const lo = Math.min(0, ...all), hi = Math.max(0, ...all)
    const extent = hi - lo || 1
    const scaleY = (v: number) => 350 - (v - lo) / extent * 260
    const group = 600 / c.labels.length
    const centre = (i: number) => 76 + group * (i + .5)
    for (let i = 0; i <= 5; i++) {
      const v = lo + extent * i / 5, y = scaleY(v)
      parts.push(`<line x1="76" y1="${y}" x2="676" y2="${y}" stroke="#e2e8f0"/>`,
        text(65, y + 4, v.toLocaleString('en-US', { maximumSignificantDigits: 5 }), 'text-anchor="end"'))
    }
    c.labels.forEach((label, i) => parts.push(text(centre(i), 371, short(label),
      `text-anchor="end" transform="rotate(-25 ${centre(i)} 371)"`)))
    c.series.forEach((series, si) => {
      const colour = COLOURS[si]
      if (c.type === 'line') {
        parts.push(`<polyline fill="none" stroke="${colour}" stroke-width="3" points="${series.values.map((v, i) => `${centre(i)},${scaleY(v)}`).join(' ')}"/>`)
      }
      series.values.forEach((v, i) => {
        const y = scaleY(v), baseline = scaleY(0)
        if (c.type === 'bar') {
          const width = group * .72 / c.series.length
          const x = centre(i) - group * .36 + si * width
          parts.push(`<rect data-value="${v}" x="${x}" y="${Math.min(y, baseline)}" width="${width * .9}" height="${Math.abs(baseline - y)}" fill="${colour}"><title>${esc(series.name)} · ${esc(c.labels[i])}: ${v}</title></rect>`)
        } else parts.push(`<circle data-value="${v}" cx="${centre(i)}" cy="${y}" r="4" fill="${colour}"><title>${esc(c.labels[i])}: ${v}</title></circle>`)
      })
      parts.push(`<rect x="${85 + si * 200}" y="54" width="12" height="12" fill="${colour}"/>`,
        text(103 + si * 200, 65, short(series.name)))
    })
    if (c.unit) parts.push(text(24, 425, c.unit))
  }
  parts.push('</svg>')
  return {
    title, summary: `${title}${c.unit ? ` (${c.unit})` : ''}. Exact values are available in the data table.`,
    format: 'svg', source: parts.join(''), height: 440, chart: c,
  }
}
