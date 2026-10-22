import { useCallback, useEffect, useState } from 'react'

type Choice = { index: number; self_id: string; name: string; nickname: string; status: string }
type Values = Record<string, unknown>

export default function QqAccountSelect({ value, onChange, nullable = false, label, settings }: {
  value: number | null; onChange: (v: number | null) => void
  nullable?: boolean; label: string; settings?: Values
}) {
  const [accounts, setAccounts] = useState<Choice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/qq-bridge/setup/choices', { headers: { 'X-Exploration-Dashboard': '1' }, signal })
      if (!response.ok) throw new Error('账号名单未能读取，可重试；原有绑定保持不变')
      const result = await response.json()
      if (!Array.isArray(result.items)) throw new Error('账号名单未能读取')
      if (!signal?.aborted) setAccounts(result.items)
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : '账号名单未能读取')
    } finally { if (!signal?.aborted) setLoading(false) }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void load(abort.signal)
    return () => abort.abort()
  }, [load])
  let choices = accounts
  if (settings) {
    const rows = (Array.isArray(settings.accounts) ? settings.accounts as Values[] : []).filter(r => r && r.enabled !== false)
    const configured = rows.length ? rows : [{ self_id: settings['onebot.self_id'] || '', name: '默认账号' }]
    choices = configured.map((r, index) => {
      const id = String(r.self_id || '')
      const live = accounts.find(a => id ? a.self_id === id : a.index === index && a.name === String(r.name || ''))
      return { index, self_id: id || live?.self_id || '', name: String(r.name || ''), nickname: live?.nickname || '', status: live?.status || 'unavailable' }
    })
  }
  const missing = value !== null && !choices.some(a => a.index === value)
  return <div>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={label} className="input max-w-full" value={value ?? ''}
        onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="" disabled={!nullable}>{nullable ? '不绑定 QQ 账号' : '请选择 QQ 账号'}</option>
        {choices.map(a => <option key={a.index} value={a.index}>
          {a.nickname || a.name || 'QQ 账号'}（{a.self_id || 'QQ 号待识别'}）{a.nickname && a.name && a.nickname !== a.name ? ` · ${a.name}` : ''}{a.status !== 'connected' ? ' · 连接待确认' : ''}
        </option>)}
        {missing && <option value={value!}>原绑定账号暂未找到，请重新选择</option>}
      </select>
      <button type="button" className="btn ghost sm" disabled={loading} onClick={() => void load()}>{loading ? '读取昵称中…' : '刷新账号昵称'}</button>
    </div>
    {error && <p role="status" className="mt-1 text-xs text-[var(--text-3)]">{error}</p>}
  </div>
}
