import { useEffect, useState } from 'react'

type Channel = 'core' | 'qq_bridge' | 'desktop_pet'
type State = { installed: boolean; channels: Record<Channel, boolean> }

export default function NetworkAccess({ channel }: { channel: Channel }) {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    const load = () => { void fetch('/api/tools/network').then(async response => {
      if (response.ok && live) setState(await response.json())
    }).catch(() => {}) }
    load()
    window.addEventListener('xtr:tools-changed', load)
    return () => { live = false; window.removeEventListener('xtr:tools-changed', load) }
  }, [])
  if (!state?.installed) return null
  return <div className="tool-entry-bar"><label className="flex items-center gap-2 text-sm"><input aria-label="联网搜索" type="checkbox" disabled={busy} checked={state.channels[channel]} onChange={async e => {
    const next = e.target.checked
    const previous = state
    setState({ ...state, channels: { ...state.channels, [channel]: next } })
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/tools/network/' + channel, {method:'PUT', headers:{'Content-Type':'application/json','X-Exploration-Dashboard':'1'},body:JSON.stringify({enabled:next})})
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || '联网设置未能保存')
      setState(body); window.dispatchEvent(new Event('xtr:tools-changed'))
    } catch (e) { setState(previous); setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }} />联网搜索</label>{error && <span role="alert">{error}</span>}</div>
}
