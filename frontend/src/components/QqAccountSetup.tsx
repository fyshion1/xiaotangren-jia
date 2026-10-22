import ListInput from './ListInput'
import { useEffect, useRef, useState } from 'react'

type Contact = { id: string; name: string }
type Row = Record<string, unknown>
const headers = { 'Content-Type': 'application/json', 'X-Exploration-Dashboard': '1' }
async function request(url: string, body?: unknown) {
  const response = await fetch(`/api/qq-bridge/setup/${url}`, {
    method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.detail || '读取失败')
  return result
}

export function QqSetupButton({ row, onChange, onLists }: {
  row: Row; onChange: (v: Row) => void
  onLists: (v: Record<string, Contact[]>) => void
}) {
  const [accounts, setAccounts] = useState<Contact[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  const latest = useRef(row)
  latest.current = row
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function load() {
    setBusy(true)
    try {
      const data = await request('accounts')
      if (alive.current) {
        setAccounts(data.items)
        setMessage(data.items.length ? '选择已登录的 QQ，然后自动配置' : '未发现已登录账号，请先登录 QQ 并启动网关')
      }
    } catch (e) { if (alive.current) setMessage(String(e instanceof Error ? e.message : e)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function prepare() {
    const id = String(row.self_id || '')
    setBusy(true)
    setMessage('正在配置连接并读取名单…')
    try {
      const data = await request('prepare', { self_id: id })
      if (!alive.current || String(latest.current.self_id || '') !== id) return
      onChange(data.connection)
      if (data.groups && data.private) onLists({ groups: data.groups, private: data.private })
      setMessage(data.warning || '已自动填写。请下拉勾选群和好友，然后保存设置。')
    } catch (e) { if (alive.current) setMessage(String(e instanceof Error ? e.message : e)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <div className="flex flex-wrap items-center gap-2 py-2">
    <button type="button" className="btn ghost sm" disabled={busy} onClick={load}>读取已登录 QQ</button>
    {accounts.length > 0 && <select aria-label="已登录 QQ" className="input w-auto" value={String(row.self_id || '')}
      onChange={e => onChange({ self_id: e.target.value })}>
      <option value="">选择账号</option>
      {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select>}
    <button type="button" className="btn ghost sm" disabled={busy || !row.self_id} onClick={prepare}>自动配置连接并读取名单</button>
    <span className="text-[11px] text-[var(--text-3)]">{message}</span>
  </div>
}

export function QqContactSelect({ label, selected, items, onChange }: {
  label: string; selected: string[]; items?: Contact[]; onChange: (v: string[]) => void
}) {
  const choices = [...(items || []), ...selected.filter(id => !items?.some(x => x.id === id)).map(id => ({ id, name: '已保存' }))]
  return <details className="relative min-w-[150px]">
    <summary className="input cursor-pointer py-1">{label} · 已选 {selected.length} ▾</summary>
    <div className="max-h-64 w-72 overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg">
      {items === undefined && <p>先点击「自动配置连接并读取名单」</p>}
      {items?.length === 0 && <p>名单为空</p>}
      {choices.map(item => <label key={item.id} className="flex items-center gap-2 py-1">
        <input type="checkbox" checked={selected.includes(item.id)} onChange={e => onChange(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} />
        {item.name}（{item.id}）
      </label>)}
      <div aria-label={`${label}手动填写`}><ListInput value={selected} onChange={onChange} /></div>
    </div>
  </details>
}
