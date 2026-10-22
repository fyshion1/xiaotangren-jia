import { useEffect, useState } from 'react'
import { changeReminder, fetchReminders, reminderLabels, reminderTime, type Reminder } from '../api/reminders'
import './tools.css'

export default function ReminderPanel({ personaId = '' }: { personaId?: string }) {
  const [items, setItems] = useState<Reminder[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Reminder | null>(null)
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => fetchReminders().then(data => {
      if (alive) { setItems((!personaId || data.persona_id === personaId) && Array.isArray(data.items) ? data.items : []); setError('') }
    }).catch(() => { if (alive) setError('提醒列表暂时无法读取') })
    void load()
    const timer = setInterval(load, 5000)
    window.addEventListener('xtr:reminders-changed', load)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('xtr:reminders-changed', load) }
  }, [personaId])
  const act = async (item: Reminder, action: 'confirm' | 'cancel' | 'dismiss' | 'edit') => {
    setBusy(true); setError('')
    try {
      const updated = await changeReminder(item, action, action === 'edit' ? title : undefined, action === 'edit' ? `${when}:00+08:00` : undefined)
      setItems(rows => rows.map(row => row.id === updated.id ? updated : row))
      setEditing(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const active = items.filter(item => ['draft', 'scheduled', 'due'].includes(item.status))
  const finished = items.filter(item => !['draft', 'scheduled', 'due'].includes(item.status))
  const card = (item: Reminder) => <article className={`reminder-card ${item.status === 'due' ? 'is-due' : ''}`} key={item.id}>
    <div className="tool-activity-heading"><b>{item.title}</b><span className="tool-badge">{reminderLabels[item.status]}</span></div>
    <p><time dateTime={new Date(item.due_at * 1000).toISOString()}>{reminderTime(item.due_at)}</time> · 北京时间</p>
    {item.status === 'draft' && <small>尚未生效。请核对内容和时间，再确认创建。</small>}
    <div className="reminder-actions">
      {item.status === 'draft' && <button className="btn-primary" disabled={busy} onClick={() => void act(item, 'confirm')}>确认创建</button>}
      {['draft', 'scheduled'].includes(item.status) && <button disabled={busy} onClick={() => {
        setEditing(item); setTitle(item.title)
        setWhen(new Date(item.due_at * 1000 + 8 * 3600000).toISOString().slice(0, 16))
      }}>修改</button>}
      {['draft', 'scheduled', 'due'].includes(item.status) && <button disabled={busy} onClick={() => void act(item, 'cancel')}>取消提醒</button>}
      {item.status === 'due' && <button className="btn-primary" disabled={busy} onClick={() => void act(item, 'dismiss')}>知道了</button>}
    </div>
    {editing?.id === item.id && <form className="reminder-edit" onSubmit={e => { e.preventDefault(); void act(editing, 'edit') }}>
      <label className="tool-field">提醒内容<input className="input" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="tool-field">提醒时间（北京时间）<input className="input" type="datetime-local" required value={when} onChange={e => setWhen(e.target.value)} /></label>
      <p>保存修改后返回待确认，需要重新确认创建。</p>
      <div className="reminder-actions"><button className="btn-primary" disabled={busy} type="submit">保存草稿</button><button type="button" onClick={() => setEditing(null)}>收起</button></div>
    </form>}
  </article>
  return <section className="reminder-panel" aria-label="我的提醒"><div className="tool-activity-heading"><h3>我的提醒</h3><span className="tool-badge">{active.length} 条进行中</span></div>
    <p>在聊天里说“明天下午三点提醒我交材料”，再到这里确认。仅支持一次性提醒。</p>
    <p className="tool-hint">北京时间 · 后端运行时检查到期；网页或桌宠在线时显示通知，离线期间错过的提醒会在重新打开后补显。</p>
    {error && <p className="tool-error" role="alert">{error}</p>}
    {!active.length && <p className="reminder-empty">还没有进行中的提醒。开启「提醒草稿」能力后，可以先试一句。</p>}
    {active.map(card)}
    {!!finished.length && <details className="reminder-finished"><summary>已结束的提醒（{finished.length}）</summary>{finished.map(card)}</details>}
  </section>
}

export function ReminderNotice({ personaId }: { personaId: string }) {
  const [items, setItems] = useState<Reminder[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setItems([])
    const load = () => fetchReminders(true).then(data => { if (alive) setItems(data.persona_id === personaId && Array.isArray(data.items) ? data.items : []) }).catch(() => {})
    void load()
    const timer = setInterval(load, 5000)
    window.addEventListener('xtr:reminders-changed', load)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('xtr:reminders-changed', load) }
  }, [personaId])
  const item = items[0]
  if (!item) return null
  return <aside className="reminder-notice" aria-label="到期提醒" role="status"><span className="eyebrow">✦ 到提醒时间了{items.length > 1 ? ` · 还有 ${items.length - 1} 条` : ''}</span><b>{item.title}</b><small>{reminderTime(item.due_at)} · 北京时间</small>
    <div className="reminder-actions"><button onClick={() => { window.location.hash = 'tool-center'; window.dispatchEvent(new HashChangeEvent('hashchange')) }}>查看提醒</button><button onClick={() => { void changeReminder(item, 'dismiss').then(() => { setItems(rows => rows.filter(row => row.id !== item.id)); setError('') }).catch(() => setError('未能标记已读，请重试')) }}>知道了</button></div>{error && <small role="alert">{error}</small>}
  </aside>
}
