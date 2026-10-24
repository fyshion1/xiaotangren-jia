import {themeInstalled} from '#theme/config'
import { useRef, useState } from 'react'
import { setExpertMode, useExpertMode } from '../lib/expertMode'

export default function ExpertModeControl() {
  const { enabled } = useExpertMode()
  const clicks = useRef({ count: 0, time: 0 })
  const [unlock, setUnlock] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (next: boolean) => {
    setBusy(true); setError('')
    try { await setExpertMode(next, passphrase); setUnlock(false); setPassphrase('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <footer className="mt-6 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-3)]">
    <div className="flex flex-wrap items-center gap-3"><button type="button" aria-label="版本 0.1.0" onClick={() => {
      const now = Date.now()
      clicks.current = { count: now - clicks.current.time > 2000 ? 1 : clicks.current.count + 1, time: now }
      if (clicks.current.count >= 7) { setUnlock(true); clicks.current.count = 0 }
    }}>{themeInstalled?'糖人小窝':'工作区'} · v0.1.0</button>
    {enabled && <button className="btn ghost sm" disabled={busy} onClick={() => void save(false)}>{busy ? '正在关闭…' : '关闭专家模式'}</button>}
    </div>
    {unlock && !enabled && <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void save(true) }}>
      <label>探索口令 <input className="input" aria-label="探索口令" type="password" autoComplete="off" value={passphrase} onChange={e => setPassphrase(e.target.value)} /></label>
      <button className="btn sm" disabled={busy || !passphrase}>{busy ? '正在开启…' : '开启专家模式'}</button>
      <button className="btn ghost sm" type="button" onClick={() => { setUnlock(false); setPassphrase(''); setError('') }}>取消</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </footer>
}
