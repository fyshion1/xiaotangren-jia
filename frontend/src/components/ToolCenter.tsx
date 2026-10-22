import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { fetchToolConfig, fetchToolRuns, runLabels, saveToolConfig, toolLabels, type AgentEvent, type ToolConfig, type ToolRun } from '../api/tools'
import './tools.css'
import ReminderPanel from './ReminderPanel'

export function ToolDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => { dialog?.close() }
  }, [])
  return <dialog ref={ref} className="tool-modal" aria-label="工具中心" onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}><div className="tool-modal-dialog"><div className="tool-modal-close"><b>工具能力与执行记录</b><button type="button" autoFocus aria-label="关闭工具中心" onClick={onClose}>关闭 ×</button></div>{children}</div></dialog>
}

export function ToolEntry({ onOpen, personaId }: { onOpen: () => void; personaId: string }) {
  const [status, setStatus] = useState('正在读取…')
  useEffect(() => {
    let current = true
    const load = () => fetchToolConfig().then(data => {
      if (current) setStatus(!data.config.enabled ? '未开启' : data.config.owner_persona_id !== personaId ? '当前身份未获授权' : !data.config.web_enabled ? '网页聊天未开启' : !data.config.allowed_names.length ? '尚未选择能力' : `已开启 ${data.config.allowed_names.length} 项能力`)
    }).catch(() => { if (current) setStatus('设置暂不可用') })
    void load()
    window.addEventListener('xtr:tools-changed', load)
    return () => { current = false; window.removeEventListener('xtr:tools-changed', load) }
  }, [personaId])
  return <div className="tool-entry-bar"><button type="button" onClick={onOpen}>✦ 工具能力</button><span>{status} · 点击查看与配置</span></div>
}

export function ToolActivity({ events }: { events: AgentEvent[] }) {
  const starts = events.filter(event => event.type === 'tool_start')
  const last = events[events.length - 1]
  if (!events.length) return null
  return <section className="tool-activity" aria-label="本轮工具执行" aria-live="polite">
    <div className="tool-activity-heading"><b>本轮工具执行</b><span>{last?.type === 'agent_end' ? runLabels[last.status || ''] || '已结束' : last?.type === 'agent_guard' ? '已触发执行保护' : '处理中…'}</span></div>
    {!starts.length && <p>{last?.type === 'agent_end' ? '本轮没有确认执行任何工具。' : '正在判断是否需要工具；普通对话不会强制调用。'}</p>}
    {starts.map(start => {
      const result = events.find(event => event.type === 'tool_result' && event.call_id === start.call_id)
      const ended = last?.type === 'agent_end'
      return <details key={start.call_id} className="tool-call"><summary><span>{result ? result.ok ? '✓' : '!' : ended ? '—' : '◌'} {toolLabels[start.name || ''] || start.name}</span><span>{result ? result.ok ? '成功' : `未完成 · ${result.code}` : ended ? '已停止等待' : '正在执行'}</span></summary>
        {start.query && <p><b>搜索词：</b>{start.query}</p>}
        <p>{result?.output || (result ? '结果正文未保存，可查看本轮回复。' : ended ? '本轮已结束，没有确认该工具成功。' : '正在等待工具返回…')}</p>
        {result?.truncated && <small>工具结果已截断</small>}
      </details>
    })}
    {events.some(event => event.type === 'agent_guard') && <p>已停止继续调用，避免重复执行或超过预算。</p>}
  </section>
}

export default function ToolCenter({ personaId = '', sessionId = '', onExample }: { personaId?: string; sessionId?: string; onExample?: (text: string) => void }) {
  const [data, setData] = useState<ToolConfig | null>(null)
  const [runs, setRuns] = useState<ToolRun[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const historyRequest = useRef(0)
  const loadRuns = useCallback(async () => {
    const generation = ++historyRequest.current
    try {
      const result = await fetchToolRuns(personaId, sessionId)
      if (generation === historyRequest.current) { setRuns(result.items); setHistoryError('') }
    } catch { if (generation === historyRequest.current) setHistoryError('执行记录暂时无法读取') }
  }, [personaId, sessionId])
  useEffect(() => {
    let current = true
    fetchToolConfig().then(result => { if (current) setData(result) }).catch(e => { if (current) setError(String(e.message || e)) })
    return () => { current = false }
  }, [])
  useEffect(() => { setRuns([]); void loadRuns(); return () => { historyRequest.current++ } }, [loadRuns])
  const update = (key: keyof ToolConfig['config'], value: unknown) => {
    setNotice('')
    setDirty(true)
    setData(prev => prev ? { ...prev, config: { ...prev.config, [key]: value } } : prev)
  }
  return <section className="tool-center" aria-label="工具中心">
    <header className="tool-center-title"><div><span className="eyebrow">让小糖人动手做事</span><h2>工具中心</h2><p>网页聊天和桌宠共用。先选择允许的能力，再在聊天里说出你想做的事。</p></div><span className={`tool-badge ${data?.config.enabled ? 'on' : ''}`}>{dirty ? '设置待保存' : data?.config.enabled ? '工具已开启' : '工具未开启'}</span></header>
    {error && <p role="alert" className="tool-error">{error}</p>}
    {!data ? <p>{error ? '工具设置未读取，请关闭面板后重试。' : '正在读取工具设置…'}</p> : <>
      <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const result = await saveToolConfig(data.config); setData(result); setDirty(false); setNotice('已保存，下一轮聊天生效。') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }}>
        <fieldset disabled={busy}>
          <label className="tool-master"><input type="checkbox" checked={data.config.enabled} onChange={e => update('enabled', e.target.checked)} /><span><b>允许小糖人使用工具</b><small>关闭后继续普通聊天。</small></span></label>
          <div className="tool-channel-row"><label><input type="checkbox" checked={data.config.web_enabled} onChange={e => update('web_enabled', e.target.checked)} />网页聊天</label><label><input type="checkbox" checked={data.config.pet_enabled} onChange={e => update('pet_enabled', e.target.checked)} />桌宠文字聊天</label><label><input type="checkbox" checked={data.config.qq_enabled} onChange={e => update('qq_enabled', e.target.checked)} />QQ 桥（仅主人 QQ）</label></div>
          <label className="tool-field">可使用工具的主人身份<select className="input" value={data.config.owner_persona_id} onChange={e => update('owner_persona_id', e.target.value)}>{data.personas.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></label>
          <h3>已实现的能力</h3>
          <div className="tool-capabilities">{data.capabilities.map(capability => <article key={capability.name}>
            <label><input type="checkbox" checked={data.config.allowed_names.includes(capability.name)} onChange={e => update('allowed_names', e.target.checked ? [...data.config.allowed_names, capability.name] : data.config.allowed_names.filter(name => name !== capability.name))} /><b>{capability.label}</b></label><p>{capability.description}</p><button type="button" className="tool-example" onClick={() => onExample ? onExample(capability.example) : navigator.clipboard?.writeText(capability.example).then(() => setNotice('示例已复制，可粘贴到聊天里。')).catch(() => setNotice(capability.example))}>{onExample ? '填入聊天' : '复制示例'}：{capability.example}</button>
          </article>)}</div>
          <label className="tool-field">允许访问的目录<input className="input" value={data.config.root} placeholder="留空使用专用工具目录" onChange={e => update('root', e.target.value)} /><small>当前保存的目录：{data.resolved_root}</small></label>
          <p className="tool-hint">把要让小糖人读取的 UTF-8 文本放入允许目录。首次执行会创建目录；不会修改或删除文件。联网搜索不用放文件，直接问就行；QQ 桥的工具在「QQ 桥 → 小工具」里单独开。</p>
          <details className="tool-limits"><summary>执行限制</summary><div className="tool-limit-grid">{([
            ['max_bytes', '最多读取字节', 100, 60000], ['max_turns', '最多模型轮数', 1, 8], ['max_calls', '最多工具调用', 1, 12], ['timeout_seconds', '本轮最长秒数', 5, 120],
          ] as const).map(([key, label, min, max]) => <label key={key}>{label}<input className="input" type="number" min={min} max={max} step={1} required value={data.config[key]} onChange={e => update(key, Number(e.target.value))} /></label>)}</div><p>相同调用不会重复执行；参数最多纠正一次。超时会停止等待，不自动重试。</p></details>
          <div className="tool-save-row"><button type="submit" className="btn-primary" disabled={busy}>{busy ? '保存中…' : '保存工具设置'}</button><span role="status">{notice}</span></div>
        </fieldset>
      </form>
      <ReminderPanel personaId={personaId} />
      <div className="tool-planned"><a href="#project-costs" onClick={() => window.dispatchEvent(new HashChangeEvent('hashchange'))}><b>打开项目费用 →</b></a><span>管理支出与账单对账；聊天记账需勾选并保存上面的费用能力。</span></div>
      <section className="tool-history" aria-label="最近工具记录"><div className="tool-activity-heading"><h3>最近执行记录</h3><button type="button" onClick={() => void loadRuns()}>刷新</button></div><p>网页搜索和歌词搜索会保留搜索词及最多 4000 字的初始结果，方便核对小糖人实际读到的内容；本地文件和个人记录等隐私结果不写入历史。</p>{historyError && <p role="alert">{historyError}</p>}{!historyError && !runs.length && <p>还没有执行记录。开启并保存后，可先试“用工具确认你能访问的目录和限制”。</p>}{runs.map(run => <details key={run.id}><summary><span>{new Date(run.created_at * 1000).toLocaleString('zh-CN', { hour12: false })} · {run.feature_id === 'desktop_pet' ? '桌宠' : run.feature_id === 'qq_bridge' ? 'QQ 桥' : '网页聊天'}</span><span>{runLabels[run.status] || run.status}</span></summary><ToolActivity events={[...run.events, { type: 'agent_end', status: run.status }]} /></details>)}</section>
    </>}
  </section>
}
