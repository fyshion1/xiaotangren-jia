import { useEffect, useState } from 'react'
import StartupSettingsPanel from './StartupSettingsPanel'

type ProcessRow = {
  pid: number; ppid: number; role: string; cmd: string; create_time: number
  ports: number[]; current: boolean; can_kill: boolean; requires_force: boolean; reason: string
}
type State = { items: ProcessRow[]; warnings: string[]; me: { pid: number } }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`)
  return body as T
}

export default function ProcessPanel() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<ProcessRow | null>(null)
  const refresh = async () => {
    setBusy(true)
    try { setState(await request<State>('/api/system/processes')); setError('') }
    catch (e) { setState(null); setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])
  const stop = async (row: ProcessRow) => {
    setBusy(true); setSelected(null); setNotice('')
    try {
      const result = await request<{ ok: boolean; message: string }>(`/api/system/processes/${row.pid}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ create_time: row.create_time, force: row.requires_force }),
      })
      setNotice(result.message)
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)) }
    finally { await refresh() }
  }
  return <div className="space-y-3">
    <StartupSettingsPanel />
    <hr className="border-[var(--border)]" />
    <div className="nest-room-heading"><div><h2>进程管理</h2>
      <p>查看后端、前端和功能进程。停止会影响其全部子进程；当前后端及其祖先进程受到保护。</p>
    </div><button className="btn ghost sm" disabled={busy} onClick={() => void refresh()}>{busy ? '处理中…' : '刷新'}</button></div>
    {error && <p role="alert">无法检查进程：{error}。请先启动后端，再刷新。</p>}
    {notice && <p role="status">{notice}</p>}
    {state && <p className="text-sm">当前响应的后端 PID：{state.me.pid}。列表中的父子进程可能属于同一个实例。</p>}
    {state?.warnings.map(w => <p key={w} role="alert">{w}</p>)}
    {selected && <div role="alertdialog" aria-label="确认停止进程" className="rounded-xl border border-[var(--border)] p-3 space-y-2">
      <p>停止 {selected.role}（PID {selected.pid}）及其子进程？未保存的工作可能丢失。</p>
      {selected.requires_force && <p>这个进程不是当前小窝后端启动的，可能是你手动启动的旧实例。</p>}
      <button className="btn sm" disabled={busy} onClick={() => void stop(selected)}>确认停止</button>{' '}
      <button className="btn ghost sm" onClick={() => setSelected(null)}>取消</button>
    </div>}
    {state?.items.map(row => <article key={`${row.pid}:${row.create_time}`} className="rounded-xl border border-[var(--border)] p-3 space-y-1">
      <div className="flex items-center justify-between gap-2"><strong>{row.role} · PID {row.pid}{row.current ? ' · 当前后端' : ''}</strong>
        <button className="btn ghost sm" disabled={busy || !row.can_kill} onClick={() => setSelected(row)}>停止</button></div>
      <p className="text-xs">父进程 {row.ppid} · 端口 {row.ports.join('、') || '未监听'} · 启动于 {new Date(row.create_time * 1000).toLocaleString()}</p>
      <p className="break-all text-xs text-[var(--text-3)]">{row.cmd}</p>
      {row.reason && <p className="text-xs">{row.reason}</p>}
    </article>)}
  </div>
}
