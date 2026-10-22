import { useCallback, useEffect, useState } from 'react'
import ExplorationProjects from './ExplorationProjects'

type Artifact = { run_id: string; step: number; kind: string; content: string; synced: number }
type State = {
  day: string; run_limit: number; day_limit: number; input: number; output: number
  charged: number; uncertain: boolean; stopped: boolean
  project_charged?: number; unconfirmed_calls?: number
  runs: { id: string; persona: string; state: string; created: number }[]
  artifacts: Artifact[]
}

async function request(path = '', method = 'GET'): Promise<State> {
  const response = await fetch('/api/qq-bridge/exploration' + path, { method })
  if (!response.ok) throw new Error('自主活动状态未能读取，请稍后重试')
  return response.json()
}

const labels: Record<string, string> = { personal_memory: '个人记忆操作', personal_docs: '个人工作手册', observe_memory: '只读观察主记忆与历史', usage_receipt: '模型用量核对记录', recent_chats: '只读观察最近聊天', continuation: '感想与下一步兴趣', self_observe: '自我观察', document: '需求文档草稿', consult: '顾问建议', browse: 'B 站发现', proposal: '分享候选', project: '新项目', request_budget: '后台资源申请', progress: '项目进度', write_file: '工作区写入', read_file: '工作区读取', reference: '只读源码', execute: '隔离执行结果', web: '公开网页文字', agent: '工作区 Codex 结果' }

function description(item: Artifact): string {
  try {
    const value = JSON.parse(item.content)
    if (item.kind === 'usage_receipt') return `${value.reason}\n${value.accounting_basis === 'reported_max' ? `按供应商回执记账：${value.accounted} token；调用前预留：${value.reserved} token` : `本地保守预留：${value.reserved} token（非供应商确认消费）`}\n供应商回执：${JSON.stringify(value)}`
    if (item.kind === 'document') return `仅保存活动草稿，未更新 docs 文件\n${value.title}\n${value.body}`
    if (item.kind === 'personal_docs') {
      if (value.reason) return `操作未完成：${value.reason}`
      if (value.paths) return `个人文档目录：\n${value.paths.join('\n')}`
      return `${value.written ? '已写入个人文件' : '读取个人文件'}：${value.path}${value.exists === false ? '（不存在）' : ''}\n${value.bytes === undefined ? '' : `${value.bytes} 字节\n`}${value.content || ''}`
    }
    if (item.kind === 'reference') return value.reason ? `只读源码未读取：${value.reason}` : `只读本项目：${value.path || '目录'}\n${value.content || (value.paths || []).join('\n')}`
    if (item.kind === 'consult') return `${value.question}\n\n${value.answer}`
    if (item.kind === 'browse') return '实际读取标题与简介：\n' + value.videos.map((v: { bvid: string; title: string }) => `${v.title}（${v.bvid}）`).join('\n')
    if (item.kind === 'proposal') return `渠道：${value.channel}\n` + value.actions.map((a: { text?: string }) => a.text || '[表情]').join('\n')
  } catch { /* corrupted record is still visible as plain text */ }
  return item.content
}

export default function QqExploration() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try { setState(await request()); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 15000)
    return () => window.clearInterval(timer)
  }, [load])
  async function control(action: string) {
    setBusy(true)
    try { await request('/' + action, 'POST'); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return (
    <><section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">小糖人的自主活动</h3>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void load()}>刷新</button>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void control('stop')}>今天先休息</button>
        {state?.stopped && <button type="button" className="btn ghost sm" disabled={busy || state.uncertain} onClick={() => void control('resume')}>恢复今天的活动</button>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
      {state && <>
        <p className="mt-2 text-sm">{state.day} · 输入 {state.input.toLocaleString()} ＋ 输出 {state.output.toLocaleString()} token</p>
        <p className="mt-1 text-xs text-[var(--text-3)]">普通活动已用及预留 {(state.charged - (state.project_charged || 0)).toLocaleString()}；本地限额模式每日上限 {state.day_limit.toLocaleString()}；项目授权已用及预留 {(state.project_charged || 0).toLocaleString()}；本地限额模式单次上限 {state.run_limit.toLocaleString()}。按供应商余额运行的钱包不受这些普通活动上限限制。
          {state.uncertain ? ' 用量不确定或超出预留，今天已停止自主调用。' : state.stopped ? ' 今天已暂停。' : ' 按自主活动设置继续生活，也可以休息。'}</p>
        <p className="mt-1 text-xs text-[var(--text-3)]">文档是草稿，顾问只给文字建议；分享候选不代表已送达。B 站当前只读取标题与简介。</p>
        {!!state.unconfirmed_calls && <p className="mt-1 text-xs text-[var(--text-3)]">有 {state.unconfirmed_calls} 笔请求未取得完整用量，已保留预留扣账。供应商余额模式下普通请求中断只停止原任务，可由新消息重新唤醒；本地限额和项目请求仍需核对。</p>}
        <div className="mt-2 max-h-96 space-y-2 overflow-auto">
          {state.artifacts.filter(a => labels[a.kind]).map(a => <details key={`${a.run_id}:${a.step}:${a.kind}`} className="rounded border border-[var(--border)] p-2 text-sm">
            <summary>{labels[a.kind]} · {a.run_id.slice(0, 8)}{(a.kind === 'browse' || a.kind === 'document') && !a.synced ? ' · 等待记忆来源接收' : ''}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs">{description(a)}</pre>
          </details>)}
          {!state.artifacts.some(a => labels[a.kind]) && <p className="text-xs text-[var(--text-3)]">还没有活动记录。</p>}
        </div>
      </>}
    </section><ExplorationProjects /></>
  )
}
