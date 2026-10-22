import { useEffect, useState } from 'react'

type Item = { id: string; occurred_on: string; period: string; kind: string; content: string }
export default function DailyLifeSection({ offline }: { offline: boolean }) {
  const [items, setItems] = useState<Item[]>([])
  const [month, setMonth] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function request(path: string, init?: RequestInit) {
    const response = await fetch(`/api/project-costs/daily${path}`, init)
    const data = await response.json()
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '生活记录读取失败')
    return data
  }
  const load = async () => setItems((await request(`?${new URLSearchParams({ month })}`)).items)
  useEffect(() => {
    if (offline) return
    let active = true
    void request(`?${new URLSearchParams({ month })}`).then(data => { if (active) { setItems(data.items); setError('') } }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [month, offline])
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work(); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <section aria-label="饮食与运动" className="cost-import">
    <div className="cost-section-title"><h3>饮食与运动</h3><button disabled={offline || busy} onClick={() => void act(async () => {})}>刷新生活记录</button></div>
    <p>只记日期、时段、食物或运动项目。在工具中心启用「记录饮食运动」后，分享实际吃饭或运动即可记录。</p>
    {error && <p role="alert" className="cost-error">{error}</p>}
    <div className="cost-filters"><label>生活记录月份<input className="input" type="month" value={month} onChange={e => setMonth(e.target.value)} /></label><button onClick={() => setMonth('')}>全部生活记录</button></div>
    {!items.length && <p>暂无饮食运动记录</p>}
    {items.map(item => <article className="cost-card" key={item.id}><div className="cost-row"><b>{item.occurred_on.replace(/-/g, '/')} {item.period}</b><span>{item.kind === 'diet' ? '饮食' : '运动'}</span></div><p>{item.content}</p><button disabled={busy || offline} onClick={() => { if (window.confirm('删除这条生活记录？')) void act(async () => { await request(`/${item.id}`, { method: 'DELETE' }) }) }}>删除生活记录</button></article>)}
    {items.length === 500 && <p>最多显示最近 500 条，请按月查看。</p>}
  </section>
}
