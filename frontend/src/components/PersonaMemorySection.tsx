import { useCallback, useEffect, useState } from 'react'
import SharedActivityMemory from './SharedActivityMemory'
import { fetchCharacters, fetchPersonaPicks, setPersonaPick, type PersonaPicks } from '../api/client'
import { extractMemories, fetchMemoryStatus, reindexMemories, type MemoryStatus } from '../api/memory'
import { fetchMemoryWorkflow, proposeMemory, reviewMemory, archiveMemoryHistory, organizeMemories, MEMORY_CATEGORIES, type MemoryDocument } from '../api/memoryWorkflow'
import type { CharacterProfile } from '../data/characters'

type Props = { personaId: string; personaName?: string; highlight?: boolean }
type Source = {path:string;day:string;session_id:string;message_count:number}
type Run = {session_id:string;day:string;status:string;detail:string}
const hour = (time:string) => new Date(time.includes('T') ? time : time.replace(' ','T') + 'Z').toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
const states = {active:'进行中',completed:'已完成',paused:'暂停',cancelled:'取消',expired:'过期'}

function EventCard({item,characters,onAction,onToggle}:{item:MemoryDocument;characters:CharacterProfile[];onAction:(action:string,changes:Partial<MemoryDocument>)=>Promise<void>;onToggle:(enabled:boolean)=>Promise<void>}) {
  const [draft,setDraft] = useState({...item,text:item.summary || item.text})
  const [editing,setEditing] = useState(false)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  useEffect(()=>setDraft({...item,text:item.summary || item.text}),[item.id,item.revision])
  const pending = item.review_status === 'pending'
  const run = async (action:string) => {setBusy(true);setError('');try{await onAction(action,draft);setEditing(false)}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <article className="memory-event">
    <div className="memory-event-title"><time>{hour(item.occurred_at || item.created_at)}</time><span className="inject-chip">{pending?'待你审核':MEMORY_CATEGORIES[item.category]}</span></div>
    {editing ? <textarea className="textarea" aria-label="事件摘要" rows={3} value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})}/> : <h3>{item.summary || item.text}</h3>}
    {pending && !!item.related_reviewed?.length && <details className="mt-2 text-[12px]">
      <summary>与已核对的记忆引用了相同原文，请对照确认</summary>
      <p>可能是同一事件的新整理，也可能是原文中的另一件事。请核对后决定保留、编辑或不保留。</p>
      {item.related_reviewed.map(related=><p className="whitespace-pre-wrap mt-2" key={related.id}>{related.text}</p>)}
    </details>}
    <details open={editing || undefined}><summary>事情的经过与细节</summary>{editing ? <textarea className="textarea" aria-label="事件详情" rows={6} value={draft.details || ''} onChange={e=>setDraft({...draft,details:e.target.value})}/> : <p className="whitespace-pre-wrap mt-2">{item.details || '暂无补充细节，可以编辑添加。'}</p>}
      <p className="mt-2 text-[11px] text-[var(--text-3)]">以你保存的修改为准，后台整理不会覆盖。</p>
    </details>
    {editing && <div className="memory-event-settings">
      <label>发生时间<input type="datetime-local" className="input" aria-label="发生时间" value={(draft.occurred_at || draft.created_at).slice(0,16)} onChange={e=>setDraft({...draft,occurred_at:e.target.value + ':00+08:00'})}/></label>
      <label>记忆类型 <select className="input" value={draft.category} onChange={e=>setDraft({...draft,category:e.target.value as MemoryDocument['category']})}>{Object.entries(MEMORY_CATEGORIES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>范围 <select className="input" value={draft.scope} onChange={e=>setDraft({...draft,scope:e.target.value as MemoryDocument['scope']})}><option value="shared">当前身份的共同记忆</option><option value="personal">指定角色私密</option></select></label>
      {draft.scope==='personal' && <div>{characters.map(c=><label key={c.id} className="mr-2"><input type="checkbox" checked={draft.character_ids.includes(c.id)} onChange={e=>setDraft({...draft,character_ids:e.target.checked?[...draft.character_ids,c.id]:draft.character_ids.filter(id=>id!==c.id)})}/>{c.name}</label>)}</div>}
      <label>状态 <select className="input" value={draft.state} onChange={e=>setDraft({...draft,state:e.target.value as MemoryDocument['state']})}>{Object.entries(states).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label>
      <label>携带方式<select className="input" value={!draft.inject?'off':draft.core?'core':'related'} onChange={e=>setDraft({...draft,inject:e.target.value!=='off',core:e.target.value==='core'})}><option value="related">按需召回（默认）</option><option value="core">常驻（预算内优先）</option><option value="off">暂不注入</option></select></label>
      <label><input type="checkbox" checked={Boolean(draft.redact)} onChange={e=>setDraft({...draft,redact:e.target.checked})}/> 注入时自动脱敏（默认关闭）</label>
      {draft.redact && <><p>原文保留，只有送给模型的记忆替换称呼。</p>{Object.entries(draft.aliases || {}).map(([name,alias])=><label key={name}>{name} → <input className="input" aria-label={`替代称呼 ${name}`} value={alias} onChange={e=>setDraft({...draft,aliases:{...draft.aliases,[name]:e.target.value}})}/></label>)}<button className="btn sm ghost" onClick={()=>{const name=window.prompt('需要脱敏的原名');if(name)setDraft({...draft,aliases:{...draft.aliases,[name]:name.slice(0,1)+'先生'}})}}>添加脱敏称呼</button></>}
    </div>}
    <div className="memory-event-actions">
      {item.superseded_by && <span className="text-[12px]">已整合，原条目不再重复注入</span>}
      {!pending && !item.superseded_by && <span className="text-[12px]">{!item.inject?'暂不注入':item.core?'常驻 · 预算内优先':'按需召回'}</span>}
      {pending ? <label className="text-[12px]"><input type="checkbox" checked={draft.inject} onChange={e=>setDraft({...draft,inject:e.target.checked})}/> 批准后允许注入</label> : <label className="text-[12px]"><input type="checkbox" checked={item.inject && !item.superseded_by} disabled={busy || Boolean(item.superseded_by)} onChange={async e=>{setBusy(true);try{await onToggle(e.target.checked)}catch(err){setError(String(err))}finally{setBusy(false)}}}/> 允许注入</label>}
      <button className="btn sm ghost" disabled={busy} onClick={()=>setEditing(!editing)}>{editing?'收起编辑':'编辑记忆'}</button>
      {editing && <button className="btn sm" disabled={busy} onClick={()=>void run('save')}>保存修改</button>}
      {pending && <><button className="btn sm" disabled={busy} onClick={()=>void run('approve')}>批准记忆</button><button className="btn sm ghost" disabled={busy} onClick={()=>void run('reject')}>不保留</button></>}
      {pending && item.expires_at && !item.keep_pending && <button className="btn sm ghost" disabled={busy} onClick={()=>void run('keep')}>保留待审（不过期）</button>}
      {!pending && <button className="btn sm ghost" disabled={busy} onClick={()=>void run('archive')}>归档</button>}
    </div>
    {pending && item.expires_at && !item.keep_pending && <p className="text-[12px]">自动候选将于 {new Date(item.expires_at).toLocaleString('zh-CN')} 过期；保存修改或保留待审后不过期。</p>}
    {!!item.integration_records?.length && <p className="text-[12px]">整合草稿 · 引用 {item.integration_records.length} 条原记忆；批准后原条目停止重复注入，原文保留。</p>}
    <details className="mt-3"><summary>查看原始依据</summary><p className="break-all">{item.source}</p>{item.evidence?.map((e,i)=><p className="whitespace-pre-wrap mt-2" key={i}>{e.role}：{e.content}</p>)}</details>
    {error && <p className="err-tip" role="alert">{error}</p>}
  </article>
}

export default function PersonaMemorySection({personaId,personaName,highlight}:Props) {
  const [tab,setTab] = useState<'source'|'work'|'long'|'legacy'|'activity'>('long')
  const [candidates,setCandidates] = useState<MemoryDocument[]>([])
  const [approved,setApproved] = useState<MemoryDocument[]>([])
  const [expired,setExpired] = useState<MemoryDocument[]>([])
  const [sources,setSources] = useState<Source[]>([])
  const [runs,setRuns] = useState<Run[]>([])
  const [picks,setPicks] = useState<PersonaPicks|null>(null)
  const [characters,setCharacters] = useState<CharacterProfile[]>([])
  const [status,setStatus] = useState<MemoryStatus|null>(null)
  const [busy,setBusy] = useState(false)
  const [notice,setNotice] = useState('')
  const [organizing,setOrganizing] = useState(false)
  const [newDrafts,setNewDrafts] = useState<string[]>([])
  const [query,setQuery] = useState('')
  const [preview,setPreview] = useState('')
  const [model,setModel] = useState(()=>localStorage.getItem('xtr.memoryModel') || '')
  const load = useCallback(async()=>{
    const [w,p] = await Promise.all([fetchMemoryWorkflow(personaId),fetchPersonaPicks(personaId)])
    const pending = w.candidates.filter(m=>m.review_status==='pending')
    const bundled = new Set(pending.flatMap(m=>m.integration_records || []).map(r=>r.id.replace(/^file:/,'')))
    setCandidates(pending.filter(m=>!bundled.has(m.id.replace(/^file:/,''))).map(m=>({...m,inject:m.allow_injection ?? true})));setApproved(w.approved.filter(m=>!m.superseded_by));setSources(w.sources || []);setRuns(w.runs || []);setPicks(p)
    setExpired(w.candidates.filter(m=>m.review_status==='expired'))
  },[personaId])
  useEffect(()=>{const timer=window.setInterval(()=>void load().catch(()=>{}),60000);return()=>window.clearInterval(timer)},[load])
  useEffect(()=>{void load().catch(e=>setNotice(String(e)));void fetchCharacters().then(setCharacters);void fetchMemoryStatus().then(setStatus)},[load])
  useEffect(()=>{if(highlight)document.getElementById('persona-memory')?.scrollIntoView({behavior:'smooth'})},[highlight])
  useEffect(()=>{if(newDrafts.length)document.getElementById(`memory-card-${newDrafts[0]}`)?.scrollIntoView({behavior:'smooth',block:'center'})},[newDrafts,candidates])
  const perform = async (fn:()=>Promise<unknown>) => {setBusy(true);setNotice('');try{await fn();await load()}catch(e){setNotice(String(e))}finally{setBusy(false)}}
  const retry = async (source:Source) => {
    let c:Record<string,string>={};try{c=JSON.parse(localStorage.getItem('xiaotangren.config') || '{}')}catch{}
    const uncensored=c.channel==='uncensored'
    const session=source.session_id.split('@').pop() || ''
    const ids=session.startsWith('single-')?[session.slice(7)]:characters.map(c=>c.id)
    const result=await extractMemories({messages:[],persona_id:personaId,session_id:source.session_id,day:source.day,character_ids:ids,session_kind:session.startsWith('single-')?'single':'group',force:true,
      base_url:(uncensored && c.uncensoredBaseUrl)||c.baseUrl,api_key:(uncensored && c.uncensoredApiKey)||c.apiKey,
      model:model || (uncensored && c.uncensoredVisionModel)||c.visionModel||c.chatModel})
    setNotice(result.detail || '当天事件已整理，请在 03 审核。')
  }
  const items=[...candidates,...approved].filter(m=>!query || ((m.summary || m.text)+(m.details || '')).includes(query)).sort((a,b)=>new Date(b.occurred_at || b.created_at).getTime()-new Date(a.occurred_at || a.created_at).getTime())
  const integrate = async () => {
    if(!window.confirm('调用整理模型会消耗 token。生成草稿供你预览，批准前不改变原记忆。继续？'))return
    setBusy(true);setOrganizing(true);setNewDrafts([])
    setNotice('正在按时间和事件关联整理，请稍候；无需重复点击。')
    try {
    let c:Record<string,string>={};try{c=JSON.parse(localStorage.getItem('xiaotangren.config') || '{}')}catch{}
    const u=c.channel==='uncensored'
    const result = await organizeMemories(personaId,{
      base_url:(u && c.uncensoredBaseUrl)||c.baseUrl,api_key:(u && c.uncensoredApiKey)||c.apiKey,
      model:model || (u && c.uncensoredVisionModel)||c.visionModel||c.chatModel})
    setQuery('');setTab('long')
    setNotice(result.drafts.length ? `整理完成：生成 ${result.drafts.length} 份事件草稿。${result.detail}` : `整理完成：没有需要合并的事件。${result.detail}`)
    try{await load()}catch{setNotice('整理已完成，但列表刷新失败，请点击刷新；不要重复整理。');return}
    setNewDrafts(result.drafts.map(m=>m.id))
    }catch(e){setNotice(`整理失败：${e instanceof Error?e.message:String(e)}。请检查配置或后台状态；模型请求可能已计费。`)}
    finally{setBusy(false);setOrganizing(false)}
  }
  return <section id="persona-memory" className="self-profile-panel persona-memory-panel">
    <header className="panel-header"><b>个人记忆库</b><button className="btn sm ghost" disabled={busy} onClick={()=>void perform(load)}>刷新</button></header>
    <p className="memory-library-description">{personaName || '你'}与小糖人的经历、羁绊和未来。聊天全量归档，AI 自动整理，你决定留下什么。</p>
    <div className="memory-stage-line"><b>01 按天原文</b><span>→ 清洗 →</span><b>02 AI 整理</b><span>→</span><b>03 审核与注入</b></div>
    <nav className="memory-tabs">{([['activity','当天经历与来源'],['source','01 源记忆'],['work','02 AI 处理'],['long',`03 记忆注入${candidates.length ? ` · 待审核 ${candidates.length}`:''}`],['legacy','旧记忆']] as const).map(([id,label])=><button className={tab===id?'active':''} key={id} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    {tab==='activity' && <SharedActivityMemory key={personaId} personaId={personaId}/>}
    {notice && <p className="memory-run" role="status">{notice}</p>}
    {tab==='long' && <div className="p-4"><p className="text-[12px] mb-3">批准不代表每轮全部携带：默认按需召回，常驻优先；长期记忆与个人资料各最多 1600 字符，共享 2400 字符正文预算。自动候选满 24 小时退出待审，原文保留。可一键按时间与事件关联整理待审短句，也可直接逐条批准；不相关短句不合并。</p><button className="btn sm ghost mb-3" disabled={busy || candidates.filter(m=>!m.integration_records?.length).length<2} onClick={()=>void integrate()} aria-busy={organizing}>{organizing?'正在整理…':'一键整理待审记忆'}</button><input className="input w-full mb-4" placeholder="搜索经历、羁绊或愿景" value={query} onChange={e=>setQuery(e.target.value)}/>{!items.length && <p className="memory-empty">今天值得记住的事，会自动整理到这里等待你审核。</p>}{items.map(item=><div key={item.id} id={`memory-card-${item.id}`} className={newDrafts.includes(item.id)?'ring-2 ring-pink-300 rounded-xl':''}>{newDrafts.includes(item.id) && <p className="text-[12px] p-2" role="status">新生成的事件草稿 · 等待你审核</p>}<EventCard item={item} characters={characters} onAction={async(a,c)=>{await reviewMemory(item,a,c);await load()}} onToggle={async enabled=>{await setPersonaPick(personaId,'memory',item.id,enabled);await load()}}/></div>)}{!!expired.length && <details className="mt-4"><summary>已过期候选（{expired.length}）</summary>{expired.map(item=><article className="memory-event" key={item.id}><p>{item.text}</p><button className="btn sm ghost" disabled={busy} onClick={()=>void perform(()=>reviewMemory(item,'restore'))}>恢复待审（不过期）</button><details><summary>保留的详情与依据</summary><p className="whitespace-pre-wrap">{item.details}</p><p>{item.source}</p></details></article>)}</details>}</div>}
    {tab==='source' && <div className="p-4"><p className="memory-library-description">按北京时间每天归档，原始消息精确到秒排序，图片和视频保留本地原文件。删除入口在小窝设置 → 存储管理。</p><button className="btn sm ghost" disabled={busy} onClick={()=>void perform(async()=>{const r=await archiveMemoryHistory(personaId);setNotice(`已按天归档 ${r.archived} 条历史消息`)})}>补齐旧聊天归档</button>{sources.map(s=><article key={s.path} className="memory-run"><b>{s.day}</b> · {s.session_id} · {s.message_count} 条 <button className="btn sm ghost" onClick={()=>void perform(async()=>{const r=await fetch(`/api/memory-workflow/source?persona_id=${encodeURIComponent(personaId)}&path=${encodeURIComponent(s.path)}`);const d=await r.json();if(!r.ok)throw Error(d.detail);setPreview(d.text)})}>查看原文</button></article>)}{preview && <pre className="whitespace-pre-wrap break-words text-[12px] max-h-96 overflow-y-auto">{preview}</pre>}</div>}
    {tab==='work' && <div className="p-4"><p className="memory-library-description">清洗只去掉界面标签、重复格式和识图调试，原始记录完整保留。分批处理全天内容，提炼事件、情绪转折、应对行动与共同愿景，提交 03 审核。</p><label className="text-[12px]">整理模型（留空沿用聊天的视觉模型）<input className="input w-full" value={model} onChange={e=>{setModel(e.target.value);localStorage.setItem('xtr.memoryModel',e.target.value)}}/></label>{sources.map(s=>{const r=runs.find(r=>r.day===s.day && r.session_id===s.session_id);return <article className="memory-run" key={s.path}><b>{s.day}</b> · {s.session_id}<p>{r ? ({completed:'已提交 03 审核',blocked:'模型拒绝处理',processing:'整理中',failed:'整理失败',unconfigured:'等待配置模型'}[r.status] || r.status) : '等待整理'}{r?.detail && `：${r.detail}`}</p><button className="btn sm ghost" disabled={busy} onClick={()=>void perform(()=>retry(s))}>重新整理当天</button></article>})}<details className="mt-4 text-[12px]"><summary>长期检索设置 · {status?.available?`${status.dim} 维向量可用`:'关键词检索'}</summary><p>{status?.detail}</p><button className="btn sm ghost" disabled={busy} onClick={()=>void perform(async()=>{const r=await reindexMemories();setNotice(`长期索引完成 ${r.done}/${r.total}`)})}>重建长期索引</button></details></div>}
    {tab==='legacy' && <div className="p-4"><p className="memory-library-description">旧记录仍保留，可送入 03 核对后批准。</p>{picks?.legacy?.map(item=><article className="memory-event" key={item.id}><p className="text-[13px] whitespace-pre-wrap">{item.text}</p><button className="btn sm ghost mt-3" disabled={busy} onClick={()=>void perform(async()=>{await proposeMemory({persona_id:personaId,text:item.text,character_ids:item.char_id?[item.char_id]:[],scope:item.bucket==='home'?'shared':'personal',legacy_id:item.id});setTab('long')})}>提交审核</button></article>)}</div>}
  </section>
}
