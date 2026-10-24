import { useCallback, useEffect, useState } from 'react'

type Source = {source:string;name:string;receive:boolean;organize:boolean;recall:boolean;archived:boolean;installed:boolean;count:number;pending_count?:number;approved_count?:number}
type Event = {seq:number;occurred_at:string;received_at:string;source_feature_id:string;event_id:string;revision:number;text:string;role:string;topic?:string;context:string;context_text?:string}
type Daily = {version:string;total:number;sections:{source_feature_id:string;topic:string;count:number;text:string}[]}
async function api<T>(path:string, body?:unknown, method='GET'):Promise<T> {
  const r=await fetch('/api/memory/'+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined})
  const d=await r.json();if(!r.ok)throw Error(typeof d.detail==='string'?d.detail:'操作失败');return d as T
}
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
export default function SharedActivityMemory({personaId}:{personaId:string}) {
  const [sources,setSources]=useState<Source[]>([])
  const [day,setDay]=useState(today)
  const [source,setSource]=useState('')
  const [query,setQuery]=useState('')
  const [events,setEvents]=useState<Event[]>([])
  const [daily,setDaily]=useState<Daily|null>(null)
  const [offset,setOffset]=useState(0)
  const [next,setNext]=useState<number|null>(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const sourceName=(id:string)=>sources.find(s=>s.source===id)?.name || id
  const load=useCallback(async()=>{
    const params=new URLSearchParams({persona_id:personaId,day,source,query,offset:String(offset)})
    const [s,e,d]=await Promise.all([api<{items:Source[]}>('sources?persona_id='+encodeURIComponent(personaId)),api<{items:Event[];next_offset:number|null}>('events?'+params),api<Daily>('daily?'+new URLSearchParams({persona_id:personaId,day}))])
    return {s,e,d}
  },[personaId,day,source,query,offset])
  useEffect(()=>{let live=true;setError('');void load().then(({s,e,d})=>{if(live){setSources(s.items);setEvents(e.items);setNext(e.next_offset);setDaily(d)}}).catch(e=>{if(live)setError(String(e))});return()=>{live=false}},[load])
  const update=async(s:Source,key:'receive'|'organize'|'recall'|'archived',value:boolean)=>{
    setBusy(true);setError('')
    setSources(prev=>prev.map(item=>item.source===s.source?{...item,[key]:value}:item))
    try{await api('sources/'+encodeURIComponent(s.source),{persona_id:personaId,receive:!!s.receive,organize:!!s.organize,recall:!!s.recall,archived:!!s.archived,[key]:value},'PUT');const {s:all,e,d}=await load();setSources(all.items);setEvents(e.items);setDaily(d)}catch(e){setSources(prev=>prev.map(item=>item.source===s.source?s:item));setError(String(e))}finally{setBusy(false)}
  }
  const remove=async(event:Event)=>{
    setBusy(true);setError('')
    try{
      const params=new URLSearchParams({persona_id:personaId})
      const preview=await api<{messages:number;images:number;gallery:number}>(`events/${event.seq}/delete-preview?${params}`)
      if(!window.confirm(`删除这条活动的所有修订？同时删除 ${preview.messages} 条原聊天、${preview.images} 张无其他消息引用的图片及 ${preview.gallery} 项画廊收藏。长期记忆/候选和插件本地资料须单独管理。`))return
      await api(`events/${event.seq}?${params}`,undefined,'DELETE')
      const {s,e,d}=await load();setSources(s.items);setEvents(e.items);setDaily(d)
    }catch(e){setError(String(e))}finally{setBusy(false)}
  }
  const propose=async(event:Event)=>{
    const text=window.prompt('提交为待审核长期记忆，可先修改摘要：',event.text.slice(0,1600))
    if(!text?.trim())return
    setBusy(true);setError('')
    try{await api(`events/${event.seq}/candidate`,{persona_id:personaId,text},'POST');setError('已提交，请在 03 记忆注入中审核。')}catch(e){setError(String(e))}finally{setBusy(false)}
  }
  return <div className="p-4">
    <p className="memory-library-description">来源统一管理。停用插件保留经历；停止接收、自动整理和聊天回忆分别控制。归档后仍可在这里查看。时间均为北京时间，精确到秒。</p>
    <details><summary>管理本体和插件来源</summary>{sources.map(s=><article className="memory-run" key={s.source}><b>{s.name}</b> · 原始活动 {s.count} 条 · 待审核 {s.pending_count || 0} 条 · 正式记忆 {s.approved_count || 0} 条 · {s.installed?'已安装':'未安装，历史保留'}<div className="flex flex-wrap gap-3 mt-2">{([['receive','接收新记录'],['organize','整理当天'],['recall','允许回忆'],['archived','历史归档']] as const).map(([key,label])=><label key={key}><input type="checkbox" disabled={busy} checked={!!s[key]} onChange={e=>void update(s,key,e.target.checked)}/> {label}</label>)}</div></article>)}</details>
    <div className="flex flex-wrap gap-2 my-3"><input aria-label="当天经历日期" type="date" className="input" value={day} onChange={e=>{if(e.target.value){setDay(e.target.value);setOffset(0)}}}/><select className="input" aria-label="记忆来源" value={source} onChange={e=>{setSource(e.target.value);setOffset(0)}}><option value="">所有来源</option>{sources.map(s=><option key={s.source} value={s.source}>{s.name}</option>)}</select><input className="input" placeholder="搜索具体问过什么" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0)}}/></div>
    <details><summary>当天归纳 · {daily?.total || 0} 条依据</summary><p className="text-[12px]">按来源与主题归纳原始问答；不推断掌握程度，也不自动批准长期记忆。</p>{daily?.sections.filter(s=>!source||s.source_feature_id===source).map((s,i)=><article className="memory-run" key={i}><b>{sourceName(s.source_feature_id)} · {s.topic}</b> · {s.count} 条<pre className="whitespace-pre-wrap break-words text-[12px] max-h-72 overflow-y-auto">{s.text}</pre></article>)}</details>
    {!events.length&&<p className="memory-empty">这一天暂无匹配记录。旧聊天可在「01 源记忆」补齐归档。</p>}
    {events.map(e=><article className="memory-run" key={e.seq}><time>{e.occurred_at.slice(11,19)}</time> · {sourceName(e.source_feature_id)} · {({user:'你的提问',assistant:'角色的回答',activity:'活动记录'} as Record<string,string>)[e.role] || '活动记录'}<p className="whitespace-pre-wrap break-words">{e.text}</p><details><summary>原始依据</summary><p>事件 {e.event_id} · 修订 {e.revision} · 排序号 {e.seq} · 语境 {e.context}</p><p>发生：{e.occurred_at}；接收：{e.received_at}</p></details><div className="flex gap-2 mt-2"><button className="btn sm ghost" disabled={busy} onClick={()=>void propose(e)}>提交长期审核</button><button className="btn sm ghost" disabled={busy} onClick={()=>void remove(e)}>删除这条记录</button></div></article>)}
    <div className="flex gap-2"><button className="btn sm ghost" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-100))}>上一页</button><button className="btn sm ghost" disabled={next===null} onClick={()=>setOffset(next!)}>下一页</button></div>
    {error&&<p className="err-tip" role="alert">{error}</p>}
  </div>
}
