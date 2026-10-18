import { useEffect, useMemo, useRef, useState } from 'react'
import { validateVisual, visualDocument, visualAspectRatio, visualMessageHeight, visualSvgHeight, type VisualArtifact } from '../../../shared/visuals'
import Dialog from './Dialog'

export default function VisualCard({ visual }: { visual: VisualArtifact }) {
  const [expanded, setExpanded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [channel] = useState(() => crypto.randomUUID())
  const [height, setHeight] = useState(visual.height)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const document = useMemo(() => {
    try { return visualDocument(validateVisual(visual), channel) } catch { return null }
  }, [visual, channel])
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !document) return
    // Only the current outer frame can resize this card. No origin/storage access.
    // See docs/adr/0064-inline-visual-sizing-and-html-export.md.
    const onSize = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      const next = visualMessageHeight(event.data, channel)
      if (next !== undefined) setHeight(next)
    }
    window.addEventListener('message', onSize)
    const ratio = visualAspectRatio(visual)
    const observer = ratio ? new ResizeObserver(() => setHeight(visualSvgHeight(frame.getBoundingClientRect().width, ratio))) : undefined
    observer?.observe(frame)
    return () => { window.removeEventListener('message', onSize); observer?.disconnect() }
  }, [visual, document, channel, revision, expanded])
  if (!document) return <p className="visual-error">This visual could not be displayed.</p>

  function download() {
    const body = visual.format === 'svg' ? visual.source : document!
    const url = URL.createObjectURL(new Blob([body], { type: visual.format === 'svg' ? 'image/svg+xml' : 'text/html' }))
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${visual.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80) || 'visual'}.${visual.format}`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const frame = (large = false) => (
    <iframe ref={frameRef} key={`${revision}-${large}`} title={visual.title} className="visual-frame"
      sandbox={visual.format === 'html' ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
      srcDoc={document} style={{ height }} />
  )
  return (
    <section className="visual-card">
      <div className="visual-card-header">
        <strong>{visual.title}</strong>
        <div className="visual-card-actions">
          <button onClick={() => setExpanded(true)}>Expand</button>
          {visual.format === 'html' && <button onClick={() => setRevision(r => r + 1)}>Replay</button>}
          <button onClick={download}>Download</button>
        </div>
      </div>
      <p className="visual-summary">{visual.summary}</p>
      {!expanded && frame()}
      {visual.chart && (
        <details className="visual-data">
          <summary>Data{visual.chart.unit ? ` (${visual.chart.unit})` : ''}</summary>
          <div className="visual-table-scroll"><table>
            <thead><tr><th>Label</th>{visual.chart.series.map((s, i) => <th key={i}>{s.name}</th>)}</tr></thead>
            <tbody>{visual.chart.labels.map((label, i) => <tr key={i}><th>{label}</th>
              {visual.chart!.series.map((s, j) => <td key={j}>{s.values[i]}</td>)}</tr>)}</tbody>
          </table></div>
        </details>
      )}
      <Dialog open={expanded} onClose={() => setExpanded(false)} title={visual.title} className="visual-dialog">
        <div className="visual-expanded">{expanded && frame(true)}</div>
      </Dialog>
    </section>
  )
}
