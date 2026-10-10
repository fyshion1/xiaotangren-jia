import { useState } from 'react'
import { fetchGeminiPairing } from '../api/geminiSync'

export default function GeminiSyncPanel() {
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pair = async () => {
    setBusy(true); setError('')
    try { setToken((await fetchGeminiPairing()).token) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
    <h2 className="font-bold">Gemini 网页同步测试</h2>
    <p className="my-2 text-sm text-[var(--text-2)]">安装项目内 extensions/gemini-sync 浏览器扩展，然后开启当前 Gemini 会话同步。消息会出现在「test · Gemini」，保留角色署名，不进入记忆。</p>
    <button className="btn ghost sm" disabled={busy} onClick={() => void pair()}>{busy ? '获取中…' : '获取本机同步凭证'}</button>
    {token && <div className="mt-3 text-sm">
      <label htmlFor="gemini-sync-token">复制到扩展的「本地同步凭证」</label>
      <div className="mt-1 flex items-center gap-2">
        <input id="gemini-sync-token" type={showToken ? 'text' : 'password'} className="input min-w-0 flex-1" readOnly value={token} onFocus={e => e.target.select()} />
        <button type="button" className="btn ghost sm shrink-0" aria-label={showToken ? '隐藏同步凭证' : '显示同步凭证'} aria-pressed={showToken} title={showToken ? '隐藏同步凭证' : '显示同步凭证'} onClick={() => setShowToken(v => !v)}>{showToken ? '🙈' : '👁'}</button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-[var(--pink-deep)]">{error}</p>}
  </section>
}
