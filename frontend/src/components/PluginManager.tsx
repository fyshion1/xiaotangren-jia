import CharacterPackManager from './CharacterPackManager'
import {useEffect, useState} from 'react'
import {asJson} from '../api/client'

type Plugin = {id:string;name:string;folder:string;installed:boolean;archived:boolean;enabled:boolean;hidden:boolean;note?:string}
const headers = {'Content-Type':'application/json', 'X-Exploration-Dashboard':'1'}

export default function PluginManager() {
  const [items,setItems] = useState<Plugin[]>([])
  const [message,setMessage] = useState('')
  const [busy,setBusy] = useState(false)
  const [loading,setLoading] = useState(true)
  const [failed,setFailed] = useState(false)
  const [pending,setPending] = useState('')
  const [drafts,setDrafts] = useState<Record<string,{enabled:boolean;hidden:boolean}>>({})
  const changes = items.filter(plugin => drafts[plugin.id] && (drafts[plugin.id].enabled!==plugin.enabled || drafts[plugin.id].hidden!==plugin.hidden))
  const dirty = changes.length>0
  function stage(plugin:Plugin,field:'enabled'|'hidden') {
    setDrafts(previous=>{
      const next=previous[plugin.id]||{enabled:plugin.enabled,hidden:plugin.hidden}
      return {...previous,[plugin.id]:{...next,[field]:!next[field]}}
    })
    setMessage('修改尚未应用，插件保持当前运行状态。');setFailed(false)
  }
  useEffect(()=>{
    if(!dirty)return
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''}
    window.addEventListener('beforeunload',warn)
    return ()=>window.removeEventListener('beforeunload',warn)
  },[dirty])
  const load = () => asJson<{items:Plugin[]}>('/api/plugins',{headers}).then(data=>setItems(data.items))
  useEffect(()=>{void load().catch(error=>{setFailed(true);setMessage(String(error))}).finally(()=>setLoading(false))},[])
  async function apply() {
    if(!dirty||busy)return
    setBusy(true);setFailed(false);setMessage('正在应用修改…')
    try {
      const result=await asJson<{message:string}>('/api/plugins/apply',{method:'POST',headers,body:JSON.stringify({changes:changes.map(plugin=>({id:plugin.id,...drafts[plugin.id],expected_enabled:plugin.enabled,expected_hidden:plugin.hidden}))})})
      setDrafts({});setMessage(result.message);await load()
      window.dispatchEvent(new Event('plugins-changed'))
    } catch(error) {setFailed(true);setMessage(String(error))}
    finally {setBusy(false)}
  }
  async function act(plugin:Plugin,action:string) {
    if(action==='uninstall' && !window.confirm(`卸载“${plugin.name}”？插件文件将移入本地备份，聊天、记忆和配置保留，可在这里恢复。`)) return
    setBusy(true); setFailed(false); setPending(`${plugin.id}:${action}`); setMessage(`正在处理“${plugin.name}”…`)
    try {
      const result = await asJson<{message:string}>(`/api/plugins/${plugin.id}/manage`,{method:'POST',headers,body:JSON.stringify({action})})
      setMessage(result.message)
      await load()
      window.dispatchEvent(new Event('plugins-changed'))
    } catch(error) {setFailed(true);setMessage(String(error))}
    finally {setBusy(false);setPending('')}
  }
  return <section aria-label="插件管理" className="plugin-manager" aria-busy={loading || busy}><h2>插件管理</h2>
    <p>隐藏只收起功能入口；关闭会停止本体管理的插件进程并禁止继续调用；卸载将文件移入本地备份，可恢复。用户数据保留。</p>
    <p>开关和隐藏操作先暂存，点击“应用修改”才生效。卸载和恢复为独立操作，请先应用或放弃待应用修改。</p>
    <div className="my-4 flex flex-wrap items-center gap-3" aria-label="应用插件修改">
      <button disabled={!dirty||busy} onClick={()=>void apply()}>{busy&&!pending?'正在应用…':`应用修改${dirty?`（${changes.length}）`:''}`}</button>
      <button disabled={!dirty||busy} onClick={()=>{setDrafts({});setFailed(false);setMessage('已放弃待应用修改。')}}>放弃修改</button>
      <span className="text-sm">{dirty?`${changes.length} 个插件有待应用修改`:'没有待应用修改'}</span>
    </div>
    <p>关闭主题插件可查看中性界面。开发服务会自动重载；生产部署需重新构建前端。现有角色档案仍保留，关闭主题不会把已有数据库变成全新安装。</p>
    <p role={failed?"alert":"status"} className={failed?"plugin-feedback error":"plugin-feedback"}>{loading?"正在加载插件…":message}</p>
    {!loading && !failed && !items.length && <p>暂无已安装插件。</p>}
    {items.map(plugin=>{const draft=drafts[plugin.id]||plugin;const changed=draft.enabled!==plugin.enabled||draft.hidden!==plugin.hidden;return <article key={plugin.id} className="my-4 rounded-xl border border-[var(--border)] p-4">
      <h3>{plugin.name}</h3><p>{plugin.installed ? plugin.enabled ? '已启用' : '已关闭' : '已卸载'}{plugin.hidden?' · 入口已隐藏':''} · features/{plugin.folder}</p>
      {plugin.note && <p>{plugin.note}</p>}
      {changed&&<p>待应用：{draft.enabled?'启用':'关闭'} · {draft.hidden?'隐藏入口':'显示入口'}</p>}
      <div className="flex flex-wrap gap-3 mt-3">
        {plugin.installed && <><button disabled={busy} aria-pressed={draft.hidden} onClick={()=>stage(plugin,'hidden')}>{draft.hidden?'显示入口':'隐藏入口'}</button>
          <button disabled={busy} aria-pressed={draft.enabled} onClick={()=>stage(plugin,'enabled')}>{draft.enabled?'关闭插件':'启用插件'}</button>
          <button disabled={busy||dirty} onClick={()=>void act(plugin,'uninstall')}>{pending===`${plugin.id}:uninstall`?'正在卸载…':'卸载插件'}</button></>}
        {!plugin.installed && plugin.archived && <button disabled={busy||dirty} onClick={()=>void act(plugin,'restore')}>恢复插件（保持关闭）</button>}
      </div>
    </article>})}
    <CharacterPackManager/>
  </section>
}
