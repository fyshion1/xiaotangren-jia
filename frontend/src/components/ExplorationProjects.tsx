import { useCallback, useEffect, useState } from 'react'

type Grant = { id: string; tokens: number; charged: number; capabilities: string[]; expires: number; state: string }
type Proposal = { id: string; reason: string; state: string }
type Project = { id: string; persona: string; speaker: string; title: string; goal: string; progress: string; state: string;
  requests: Proposal[]; grants: Grant[]; events: { id: string; kind: string; content: string }[] }
type State = { items: Project[]; runtime: { available: boolean; reason: string; agent_available: boolean } }

async function api(path = '', body?: object): Promise<unknown> {
  const response = await fetch('/api/exploration-projects' + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Exploration-Dashboard': '1' }, body: JSON.stringify(body),
  } : undefined)
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '项目操作失败')
  return value
}

function Approval({ item, runtime, agentRuntime, act, busy }: { item: Proposal; runtime: boolean; agentRuntime: boolean; act: (path: string, body: object) => Promise<void>; busy: boolean }) {
  const [tokens, setTokens] = useState(12000)
  const [hours, setHours] = useState(2)
  const [web, setWeb] = useState(false)
  const [python, setPython] = useState(false)
  const [codex, setCodex] = useState(false)
  return <div className="mt-2 rounded border border-[var(--border)] p-2">
    <p className="whitespace-pre-wrap text-sm">申请理由：{item.reason}</p>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <label>追加 token <input aria-label="追加 token" className="w-24 rounded border p-1" type="number" min={1000} max={200000} step={1000} value={tokens} onChange={e => setTokens(Number(e.target.value))} /></label>
      <label>有效小时 <input aria-label="有效小时" className="w-16 rounded border p-1" type="number" min={1} max={24} value={hours} onChange={e => setHours(Number(e.target.value))} /></label>
      <span>工作区文档</span>
      <label><input type="checkbox" checked={web} onChange={e => setWeb(e.target.checked)} /> 公开网页只读</label>
      <label><input type="checkbox" checked={python} disabled={!runtime} onChange={e => setPython(e.target.checked)} /> 隔离 Python 执行</label>
      <label><input type="checkbox" checked={codex} disabled={!agentRuntime} onChange={e => setCodex(e.target.checked)} /> 工作区 Codex</label>
    </div>
    <p className="mt-2 text-xs text-[var(--text-3)]">审批绑定此项目与角色；替换旧授权，不清零已用账本。聊天里说“好”不会生效。Codex 含工具定义的每次请求共用额度；预算不足即停，不自动追加。Claude Code 暂未接入。</p>
    <div className="mt-2 flex gap-2">
      <button className="btn sm" disabled={busy || !Number.isInteger(tokens) || tokens < 1000 || tokens > 200000 || !Number.isInteger(hours) || hours < 1 || hours > 24} onClick={() => void act(`/requests/${item.id}/approve`, { tokens, hours, capabilities: ['document', ...(web ? ['web_read'] : []), ...(python && runtime ? ['python'] : []), ...(codex && agentRuntime ? ['codex'] : [])] })}>批准本次资源</button>
      <button className="btn ghost sm" disabled={busy} onClick={() => void act(`/requests/${item.id}/reject`, {})}>拒绝申请</button>
    </div>
  </div>
}

export default function ExplorationProjects() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<Record<string, { path: string; content: string }[]>>({})
  const load = useCallback(async () => {
    try { setState(await api() as State); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 15000)
    return () => window.clearInterval(timer)
  }, [load])
  async function act(path: string, body: object) {
    setBusy(true)
    try { await api(path, body); setFiles({}); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function inspect(id: string) {
    try {
      const result = await api(`/${id}/files`) as { items: { path: string; content: string }[] }
      setFiles(previous => ({ ...previous, [id]: result.items }))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">小工作室 · 项目与后台审批</h3>
      <button className="btn ghost sm" disabled={busy} onClick={() => void load()}>刷新项目</button>
    </div>
    <p className="mt-2 text-xs text-[var(--text-3)]">{state?.runtime.reason || '正在检查隔离环境…'}。授权用完或到期即停，待下次活动机会再继续。</p>
    {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
    {state?.items.map(project => <details key={project.id} className="mt-2 rounded border border-[var(--border)] p-2" open={project.requests.some(r => r.state === 'pending')}>
      <summary className="text-sm">{project.title} · {project.speaker} · {project.state === 'open' ? '进行中' : '已暂停'}</summary>
      <p className="mt-2 whitespace-pre-wrap text-sm">{project.goal}</p>
      {project.progress && <p className="mt-2 whitespace-pre-wrap text-xs">当前进度：{project.progress}</p>}
      <p className="mt-1 text-xs text-[var(--text-3)]">主人身份：{project.persona} · 项目 {project.id.slice(0, 8)}</p>
      {project.grants.map(grant => <p key={grant.id} className="mt-2 text-xs">授权 {grant.charged.toLocaleString()} / {grant.tokens.toLocaleString()} token · {grant.capabilities.join('、')} · {grant.state === 'approved' && grant.expires * 1000 > Date.now() ? '有效至' : '已撤销或到期'} {new Date(grant.expires * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）</p>)}
      {project.requests.filter(r => r.state === 'pending').map(item => <Approval key={item.id} item={item} runtime={state.runtime.available} agentRuntime={state.runtime.agent_available} act={act} busy={busy} />)}
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn ghost sm" onClick={() => void inspect(project.id)}>查看工作区文件</button>
        <button className="btn ghost sm" disabled={busy || project.state !== 'open'} onClick={() => void act(`/${project.id}/pause`, {})}>暂停项目并撤销授权</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => {
          if (window.confirm('销毁此项目工作区文件？项目记录和预算账本会保留。')) void act(`/${project.id}/discard`, {})
        }}>销毁工作区</button>
      </div>
      {files[project.id]?.map(file => <details key={file.path} className="mt-2 text-xs"><summary>{file.path}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{file.content}</pre></details>)}
      {files[project.id]?.length === 0 && <p className="mt-2 text-xs">工作区暂无文件。</p>}
      <details className="mt-2 text-xs"><summary>最近项目记录</summary>{project.events.map(event => <pre key={event.id} className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{event.kind}: {event.content}</pre>)}</details>
    </details>)}
    {state?.items.length === 0 && <p className="mt-2 text-xs">还没有项目。她可以在自主活动中提出想法、申请资源，并通过已有 QQ 联系渠道告诉你。</p>}
  </section>
}
