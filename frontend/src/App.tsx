import { useEffect, useState } from 'react'
import { ENV } from './env'

interface HelloResponse {
  message: string
  region: string
  env: string
}

export default function App() {
  const [data, setData] = useState<HelloResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${ENV.apiBaseUrl}/api/hello`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 600, margin: '80px auto', padding: '0 24px' }}>
      <h1>🪨 Chatrock</h1>
      <p style={{ color: '#666' }}>Smoke test — verifying frontend → API Gateway → Lambda connectivity.</p>
      <hr />
      {loading && <p>Calling backend…</p>}
      {error   && <p style={{ color: 'red' }}>Error: {error}</p>}
      {data    && (
        <div style={{ background: '#f5f5f5', borderRadius: 8, padding: 16 }}>
          <p><strong>Status:</strong> <span style={{ color: 'green' }}>✓ Connected</span></p>
          <p><strong>Message:</strong> {data.message}</p>
          <p><strong>Region:</strong> {data.region}</p>
          <p><strong>Env:</strong> {data.env}</p>
        </div>
      )}
    </div>
  )
}
