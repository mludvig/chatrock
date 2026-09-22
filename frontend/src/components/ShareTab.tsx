import { useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCopy, faCheck, faTrash, faDownload, faQrcode } from '@fortawesome/free-solid-svg-icons'
import QRCode from 'qrcode'
import { api, exportChat, type Share } from '../api/http'
import { ENV } from '../env'
import { useChatStore } from '../store/chatStore'
import { ToggleRow } from './PrefControls'

// Create/list/revoke read-only public share links (/s/{shareId}), plus a Markdown export
// download — both driven off the same server-side transcript serializer (see
// backend/CLAUDE.md "Chat sharing"). Mode and include-thinking/include-tools are fixed at
// share-creation time (the server bakes them into the share record); export chooses them at
// download time instead, since there's no persisted link to fix them on.
export default function ShareTab({ chatId, chatTitle }: { chatId: string; chatTitle: string }) {
  const { pushToast } = useChatStore()
  const [shares, setShares] = useState<Share[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [mode, setMode] = useState<'live' | 'snapshot'>('snapshot')
  const [shareThinking, setShareThinking] = useState(false)
  const [shareTools, setShareTools] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [qrShareId, setQrShareId] = useState<string | null>(null)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [generatingQrId, setGeneratingQrId] = useState<string | null>(null)

  const [exportThinking, setExportThinking] = useState(false)
  const [exportTools, setExportTools] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.listShares(chatId).then(res => { if (!cancelled) setShares(res.shares) })
      .catch(err => {
        if (cancelled) return
        pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        setShares([]) // don't get stuck on "Loading…" forever after a failed fetch
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  function shareUrl(shareId: string) {
    return `${ENV.appUrl}/s/${shareId}`
  }

  function copy(url: string, id: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  async function toggleQr(shareId: string) {
    if (qrShareId === shareId) {
      setQrShareId(null)
      return
    }

    setGeneratingQrId(shareId)
    try {
      const code = await QRCode.toDataURL(shareUrl(shareId), {
        width: 192,
        margin: 1,
        errorCorrectionLevel: 'M',
      })
      setQrCode(code)
      setQrShareId(shareId)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : 'Could not create QR code' })
    } finally {
      setGeneratingQrId(null)
    }
  }

  async function handleCreate() {
    setCreating(true)
    try {
      const share = await api.createShare(chatId, { mode, includeThinking: shareThinking, includeTools: shareTools })
      setShares(prev => [share, ...(prev ?? [])])
      copy(shareUrl(share.shareId), share.shareId)
      pushToast({ kind: 'success', text: 'Share link created and copied to clipboard' })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(shareId: string) {
    if (!window.confirm('Revoke this share link? It will stop working immediately.')) return
    try {
      await api.deleteShare(chatId, shareId)
      setShares(prev => (prev ?? []).filter(s => s.shareId !== shareId))
      if (qrShareId === shareId) setQrShareId(null)
      pushToast({ kind: 'success', text: 'Share link revoked' })
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleExport() {
    setExporting(true)
    try {
      const markdown = await exportChat(chatId, { includeThinking: exportThinking, includeTools: exportTools })
      const safeTitle = chatTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'chat'
      const blob = new Blob([markdown], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${safeTitle}.md`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      pushToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <div className="pref-section">
        <div className="pref-label">Create a share link</div>
        <div className="pref-hint">
          A read-only page anyone with the link can open — no sign-in required. Detail level is
          fixed when you create the link.
        </div>
        <div className="model-setting-row model-setting-row--inline">
          <span className="setting-label">Mode</span>
          <select className="model-select" value={mode} onChange={e => setMode(e.target.value as 'live' | 'snapshot')}>
            <option value="live">Live — reflects later edits/branches</option>
            <option value="snapshot">Snapshot — frozen as-is</option>
          </select>
        </div>
        <ToggleRow label="Include thinking" on={shareThinking} onToggle={() => setShareThinking(v => !v)} />
        <ToggleRow label="Include tool calls" on={shareTools} onToggle={() => setShareTools(v => !v)} />
        <button className="btn-primary" disabled={creating} onClick={handleCreate}>
          {creating ? 'Creating…' : 'Create share link'}
        </button>
      </div>

      <div className="pref-section">
        <div className="pref-label">Existing links</div>
        {shares === null && <div className="prefs-desc">Loading…</div>}
        {shares !== null && shares.length === 0 && <div className="prefs-desc">No share links yet.</div>}
        {shares !== null && shares.length > 0 && (
          <ul className="published-links">
            {shares.map(s => (
              <li key={s.shareId} className="published-links-item">
                <div className="published-links-main">
                  <a href={shareUrl(s.shareId)} target="_blank" rel="noopener noreferrer" className="published-links-url">
                    /s/{s.shareId}
                  </a>
                  <span className="topic-chip">{s.mode}</span>
                  <span className="topic-chip">
                    {s.includeThinking && s.includeTools ? '+thinking +tools'
                      : s.includeThinking ? '+thinking'
                      : s.includeTools ? '+tools' : 'clean'}
                  </span>
                </div>
                <div className="published-links-actions">
                  <button className="action-btn" title="Copy link" onClick={() => copy(shareUrl(s.shareId), s.shareId)}>
                    <FontAwesomeIcon icon={copiedId === s.shareId ? faCheck : faCopy} />
                  </button>
                  <button
                    className="action-btn"
                    title={qrShareId === s.shareId ? 'Hide QR code' : 'Show QR code'}
                    aria-label={qrShareId === s.shareId ? 'Hide QR code' : 'Show QR code'}
                    aria-expanded={qrShareId === s.shareId}
                    disabled={generatingQrId !== null}
                    onClick={() => toggleQr(s.shareId)}
                  >
                    <FontAwesomeIcon icon={faQrcode} />
                  </button>
                  <button className="action-btn" title="Revoke" onClick={() => handleRevoke(s.shareId)}>
                    <FontAwesomeIcon icon={faTrash} />
                  </button>
                </div>
                {qrShareId === s.shareId && qrCode && (
                  <div className="share-qr">
                    <img src={qrCode} alt={`QR code for share link /s/${s.shareId}`} width="192" height="192" />
                    <span>Scan to open this share link</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pref-section">
        <div className="pref-label">Export to Markdown</div>
        <div className="pref-hint">Downloads the current active conversation as a .md file.</div>
        <ToggleRow label="Include thinking" on={exportThinking} onToggle={() => setExportThinking(v => !v)} />
        <ToggleRow label="Include tool calls" on={exportTools} onToggle={() => setExportTools(v => !v)} />
        <button className="btn-primary" disabled={exporting} onClick={handleExport}>
          <FontAwesomeIcon icon={faDownload} /> {exporting ? 'Exporting…' : 'Download Markdown'}
        </button>
      </div>
    </>
  )
}
