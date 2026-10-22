import { useCallback, useEffect, useRef, useState } from 'react'
import { runNestFeature } from '../api/client'
import './project-costs.css'
import DailyLifeSection from './DailyLifeSection'

type Entry = { id: string; revision: number; project: string; occurred_on: string; amount_cents: number; currency: string; merchant: string; description: string; category: string; platform: string; kind: string; bank_id?: string }
type Bank = { id: string; platform: string; transaction_id: string; occurred_at: string; amount_cents: number; merchant: string; description: string; direction: string; status: string; kind: string; eligible: number; expense_id?: string; raw: string; reasons?: string[] }
type Budget = { project: string; month: string; amount_cents: number }
type Overview = { items: Entry[]; totals: Record<string, number>; unmatched: number; budgets: Budget[] }
const platforms: Record<string, string> = { unknown: '未指定', wechat: '微信', alipay: '支付宝', other: '其他' }
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
const money = (value: number, currency = 'CNY') => `${currency} ${(value / 100).toFixed(2)}`
const blank = () => ({ project: '小糖人之家', occurred_on: today(), amount: '', currency: 'CNY', merchant: '', description: '', category: 'API充值', platform: 'unknown', kind: 'expense' })
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/project-costs/${path}`, init)
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : '请检查日期、金额等填写内容')
  return body
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export default function ProjectCostsPanel() {
  const [data, setData] = useState<Overview | null>(null)
  const [project, setProject] = useState('小糖人之家')
  const [month, setMonth] = useState('')
  const [form, setForm] = useState(blank)
  const [editing, setEditing] = useState<Entry | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [bank, setBank] = useState<{ items: Bank[]; total: number }>({ items: [], total: 0 })
  const [bankOpen, setBankOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [matching, setMatching] = useState<Entry | null>(null)
  const [candidates, setCandidates] = useState<Bank[]>([])
  const [candidateNote, setCandidateNote] = useState('')
  const [budgetAmount, setBudgetAmount] = useState('')
  const autoStarted = useRef(false)
  const params = new URLSearchParams({ project, month }).toString()
  const load = useCallback(async () => {
    try {
      const result = await api<Overview>(`entries?${new URLSearchParams({ project, month })}`)
      setData(result); setOffline(false)
    } catch (e) { setOffline(true); throw e }
  }, [project, month])
  useEffect(() => { let active = true; setMatching(null); setError(''); setData(null)
    void api<Overview>(`entries?${new URLSearchParams({ project, month })}`).then(result => { if (active) { setData(result); setOffline(false) } }).catch(e => { if (active) { setError(e.message); setOffline(true) } })
    return () => { active = false }
  }, [project, month])
  useEffect(() => {
    if (!bankOpen || offline) return
    let active = true
    void api<{ items: Bank[]; total: number }>(`bank?${new URLSearchParams({ query: search, page: String(page) })}`).then(result => { if (active) setBank(result) }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [bankOpen, search, page, offline, notice])
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const fill = (entry: Entry) => {
    setEditing(entry); setForm({ project: entry.project, occurred_on: entry.occurred_on, amount: (entry.amount_cents / 100).toFixed(2), currency: entry.currency, merchant: entry.merchant, description: entry.description, category: entry.category, platform: entry.platform, kind: entry.kind })
    document.getElementById('cost-entry-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const start = () => act(async () => {
    try { await runNestFeature('project_costs', { command: 'serve' }) } catch (e) {
      if (!(e instanceof Error && /已经在跑/.test(e.message))) throw e
    }
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 400))
      try { await api('health'); await load(); setError(''); setNotice('费用服务已连接'); return } catch { /* wait for startup */ }
    }
    throw new Error('服务尚未就绪，请在「运行与日志」查看项目费用日志，或稍后刷新')
  })
  useEffect(() => { if (offline && !autoStarted.current) { autoStarted.current = true; void start() } }, [offline])
  const selectedBudget = data?.budgets.find(b => b.project === project && b.month === month)
  return <section className="project-costs" aria-label="项目费用">
    <header><div><span className="eyebrow">每一笔，都有来处</span><h2>项目费用</h2><p>记录实付金额，按月看成本，再与微信、支付宝原账单核对。API 充值计付款，调用消耗不再叠加。</p></div><button disabled={busy} onClick={() => void act(async () => { await load(); setNotice('已刷新') })}>刷新</button></header>
    {error && <p className="cost-error" role="alert">{error}</p>}{notice && <p role="status" className="cost-notice">{notice}</p>}
    {offline && <div className="cost-empty"><p>费用功能使用独立的本地服务。启动后即可记账和导入账单。</p><button className="btn-primary" disabled={busy} onClick={() => void start()}>{busy ? '连接中…' : '启动费用服务'}</button></div>}
    <div className="cost-filters"><label>项目<input className="input" maxLength={100} value={project} onChange={e => setProject(e.target.value)} placeholder="留空查看所有项目" /></label><label>月份<input className="input" type="month" value={month} onChange={e => setMonth(e.target.value)} /></label><button onClick={() => setMonth('')}>全部时间</button><a href={`/api/project-costs/export?${params}`}>导出费用 CSV</a></div>
    {data && <>
      <div className="cost-stats"><article><small>净支出（支出减退款）</small>{Object.entries(data.totals).map(([currency, value]) => <b key={currency}>{money(value, currency)}</b>)}{!data.items.length && <b>暂无记录</b>}</article><article><small>费用记录</small><b>{data.items.length} 笔</b><span>{data.unmatched} 笔待对账</span></article>{selectedBudget && <article><small>{month} 人民币预算剩余</small><b>{money(selectedBudget.amount_cents - (data.totals.CNY || 0))}</b><span>预算 {money(selectedBudget.amount_cents)}</span></article>}</div>
      <details className="cost-budget"><summary>可选：设置项目月预算</summary><form onSubmit={e => { e.preventDefault(); void act(async () => { await api('budget', json('PUT', { project, month, amount: budgetAmount })); await load(); setNotice('月预算已保存') }) }}><p>先选一个项目和月份。预算只比较人民币实付费用，外币另列。</p><input className="input" aria-label="月预算金额" type="number" min="0.01" step="0.01" required value={budgetAmount} onChange={e => setBudgetAmount(e.target.value)} placeholder="人民币预算" /><button disabled={busy || !project.trim() || !month}>保存预算</button></form></details>
      <form id="cost-entry-form" className="cost-form" onSubmit={e => { e.preventDefault(); void act(async () => {
        await api(editing ? `entries/${editing.id}?revision=${editing.revision}` : 'entries', json(editing ? 'PUT' : 'POST', form))
        setEditing(null); setForm({ ...blank(), project: form.project }); setMatching(null); await load(); setNotice('费用已保存；可在下方选择对账')
      }) }}><h3>{editing ? '修改费用' : '记一笔项目费用'}</h3><fieldset disabled={busy}>
        <label>项目<input className="input" required maxLength={100} value={form.project} onChange={e => setForm({ ...form, project: e.target.value })} /></label>
        <label>付款日期（北京时间）<input className="input" type="date" required value={form.occurred_on} onChange={e => setForm({ ...form, occurred_on: e.target.value })} /></label>
        <label>实付金额<input className="input" required type="number" step="0.01" min="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></label>
        <label>币种<select className="input" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })}>{['CNY', 'USD', 'EUR', 'HKD'].map(c => <option key={c}>{c}</option>)}</select></label>
        <label>平台 / 商户<input className="input" required maxLength={160} value={form.merchant} onChange={e => setForm({ ...form, merchant: e.target.value })} /></label>
        <label>费用分类<input className="input" list="cost-categories" required maxLength={80} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /><datalist id="cost-categories">{['API充值', '订阅', '服务器', '域名', '硬件', '其他'].map(c => <option key={c}>{c}</option>)}</datalist></label>
        <label>支付平台<select className="input" value={form.platform} onChange={e => setForm({ ...form, platform: e.target.value })}>{Object.entries(platforms).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>类型<select className="input" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}><option value="expense">支出</option><option value="refund">已到账退款</option></select></label>
        <label className="cost-wide">用途 / 备注<input className="input" maxLength={1000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
      </fieldset><div className="cost-actions"><button className="btn-primary" disabled={busy}>{editing ? '保存修改（需重新对账）' : '保存费用'}</button>{editing && <button type="button" onClick={() => { setEditing(null); setForm(blank()) }}>取消修改</button>}</div></form>
      <div className="cost-section-title"><h3>费用明细</h3><span>不同币种分别统计</span></div>
      {!data.items.length && <p className="cost-empty">还没有费用记录。可以手动记一笔，也可以在工具中心开启「记录项目费用」后让小糖人帮你记。</p>}
      {data.items.map(entry => <article className="cost-card" key={entry.id}><div className="cost-row"><b>{entry.merchant}</b><strong>{entry.kind === 'refund' ? '−' : ''}{money(entry.amount_cents, entry.currency)}</strong></div><p>{entry.occurred_on} · {entry.project} · {entry.category} · {platforms[entry.platform]}</p>{entry.description && <p>{entry.description}</p>}<div className="cost-actions"><span className={entry.bank_id ? 'cost-matched' : ''}>{entry.bank_id ? '✓ 已对账' : '待对账'}</span><button disabled={busy} onClick={() => fill(entry)}>修改</button>{entry.bank_id ? <button disabled={busy} onClick={() => void act(async () => { await api(`matches/${entry.id}`, { method: 'DELETE' }); await load(); setNotice('已解除关联') })}>解除对账</button> : <button disabled={busy} onClick={() => void act(async () => { const result = await api<{ items: Bank[]; message: string }>(`candidates/${entry.id}`); setMatching(entry); setCandidates(result.items); setCandidateNote(result.message) })}>查找对账候选</button>}<button disabled={busy} onClick={() => { if (window.confirm(`删除 ${entry.merchant} 的这笔费用？原始账单会保留。`)) void act(async () => { await api(`entries/${entry.id}?revision=${entry.revision}`, { method: 'DELETE' }); setMatching(null); await load(); setNotice('费用已删除') }) }}>删除</button></div>
      {matching?.id === entry.id && <div className="cost-candidates"><p>{candidateNote}。候选按相同金额、前后 3 天及商户相似度排序。</p>{!candidates.length && <p>没有候选。可先导入账单，或核对费用日期、金额和支付平台。</p>}{candidates.map(row => <div key={row.id}><p><b>{platforms[row.platform]} · {row.merchant}</b> · {money(row.amount_cents)}<br />{row.occurred_at.replace('T', ' ')} · {row.status}<br />{row.description}<br />{row.reasons?.join(' / ')}<br /><small>交易号：{row.transaction_id}</small></p><button disabled={busy} onClick={() => void act(async () => { await api('matches', json('POST', { expense_id: entry.id, bank_id: row.id })); setMatching(null); await load(); setNotice('已确认对账') })}>确认是这一笔</button></div>)}<button onClick={() => setMatching(null)}>收起候选</button></div>}</article>)}
    </>}
    <DailyLifeSection offline={offline} />
    <section className="cost-import"><h3>本地账单与对账</h3><p>支持微信、支付宝 XLSX / XLS / CSV（最多 20MB）。导入后保留原始字段；重复交易号不会重复新增；变化的账单会更新并解除旧对账。账单只在本地解析，不发送给模型。</p><label className="cost-upload">{busy ? '处理中…' : '选择账单文件'}<input aria-label="导入账单" type="file" accept=".xlsx,.xls,.csv" disabled={busy || offline} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void act(async () => { const form = new FormData(); form.append('file', file); const result = await api<{ added: number; updated: number; duplicates: number; warnings: string[] }>('imports', { method: 'POST', body: form }); setNotice(`导入 ${result.added} 笔，更新 ${result.updated} 笔（需重新对账），跳过重复 ${result.duplicates} 笔。${result.warnings.join('；')}`); setBankOpen(true); setPage(1); setMatching(null); await load() }) }} /></label><button disabled={offline} onClick={() => setBankOpen(!bankOpen)}>{bankOpen ? '收起原始账单' : '浏览原始账单 / 补记漏项'}</button>
    {bankOpen && <div><label>查找商户、商品或交易号<input className="input" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} /></label><p>共 {bank.total} 笔 · 第 {page} 页</p>{bank.items.map(row => <article key={row.id} className="cost-card"><div className="cost-row"><b>{row.merchant}</b><strong>{money(row.amount_cents)}</strong></div><p>{row.occurred_at.replace('T', ' ')} · {platforms[row.platform]} · {row.direction} · {row.status}</p><p>{row.description}</p><small>{row.expense_id ? '已关联费用' : row.eligible ? '未关联，未计入项目费用' : '保留原始记录，不参与自动对账（不计收支、失败或退款状态等）'}</small><details><summary>原始字段</summary><pre>{JSON.stringify(JSON.parse(row.raw), null, 2)}</pre></details>{row.eligible && !row.expense_id && <button onClick={() => { setEditing(null); setForm({ ...blank(), project: project || '小糖人之家', occurred_on: row.occurred_at.slice(0, 10), merchant: row.merchant, amount: (row.amount_cents / 100).toFixed(2), description: row.description, platform: row.platform, kind: row.kind, category: '其他' }); document.getElementById('cost-entry-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setNotice('已填入费用表单，请核实项目和用途后保存，再确认对账') }}>作为项目费用补记…</button>}</article>)}<div className="cost-actions"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><button disabled={page * 100 >= bank.total} onClick={() => setPage(page + 1)}>下一页</button></div></div>}
    </section>
  </section>
}
