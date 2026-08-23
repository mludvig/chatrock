import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDownload } from '@fortawesome/free-solid-svg-icons'
import { api, type ResearchRun } from '../api/http'

// A Deep Research run leaves its full record on the RUN# row, not in a project — this is
// where the user gets at it: the plan, the findings with their sources, the gaps, and the
// dossier as a downloadable markdown file. See docs/adr/0031-deep-research-is-not-a-project.md.
export default function ResearchInfoSection({ chatId }: { chatId: string }) {
  const [run, setRun] = useState<ResearchRun | null>(null)
  const [dossier, setDossier] = useState<string | undefined>()

  useEffect(() => {
    let live = true
    api.getResearchDossier(chatId)
      .then(({ run, dossierMarkdown }) => { if (live) { setRun(run); setDossier(dossierMarkdown) } })
      .catch(() => {})
    return () => { live = false }
  }, [chatId])

  if (!run || run.status !== 'done') return null

  const download = () => {
    if (!dossier) return
    const url = URL.createObjectURL(new Blob([dossier], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'research-dossier.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="pref-section">
      <div className="pref-label">Research</div>
      <p className="pref-hint">{run.question}</p>
      <p className="pref-hint">
        {run.plan?.subQuestions.length ?? 0} sub-questions, {run.findings.length} findings
        {run.gapsNotPursued.length > 0 && `, ${run.gapsNotPursued.length} gaps not pursued`}
      </p>
      {dossier && (
        <button className="btn-secondary" onClick={download}>
          <FontAwesomeIcon icon={faDownload} /> Download dossier
        </button>
      )}
    </div>
  )
}
