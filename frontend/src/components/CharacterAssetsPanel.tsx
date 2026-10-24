import {useEffect, useState} from 'react'
import {asJson} from '../api/client'

type Owner = {id:string;name:string;avatar?:string;portrait?:string;kind:'characters'|'profiles'}
type Reference = {name:string;kind:string;owner_id:string;field:string}
type Asset = {id:string;url:string;mime:string;size:number;source:string;available:boolean;references:Reference[]}
type Inventory = {items:Asset[];legacy:(Reference & {url:string})[]}
const headers = {'Content-Type':'application/json','X-Exploration-Dashboard':'1'}

export default function CharacterAssetsPanel() {
  const [data,setData] = useState<Inventory>({items:[],legacy:[]})
  const [owners,setOwners] = useState<Owner[]>([])
  const [selected,setSelected] = useState('')
  const [field,setField] = useState<'avatar'|'portrait'>('avatar')
  const [busy,setBusy] = useState(false)
  const [loading,setLoading] = useState(true)
  const [message,setMessage] = useState('')
  const [error,setError] = useState('')
  const owner = owners.find(p=>`${p.kind}:${p.id}`===selected)
  async function load() {
    const [inventory,characters,profiles] = await Promise.all([
      asJson<Inventory>('/api/assets',{headers}),
      asJson<Omit<Owner,'kind'>[]>('/api/characters'),
      asJson<{profiles:Omit<Owner,'kind'>[]}>('/api/profiles'),
    ])
    setData(inventory)
    setOwners([...characters.map(p=>({...p,kind:'characters' as const})),
      ...profiles.profiles.map(p=>({...p,kind:'profiles' as const}))])
  }
  useEffect(()=>{void load().catch(e=>setError(String(e))).finally(()=>setLoading(false))},[])
  async function migrate() {
    setBusy(true);setError('');setMessage('正在备份并保存旧图片…')
    try {
      const result=await asJson<{updated:number;unresolved:unknown[]}>('/api/assets/preserve-legacy',{method:'POST',headers})
      await load()
      setMessage(`已更新 ${result.updated} 份档案；仍有 ${result.unresolved.length} 处旧图片未能保存。`)
    } catch(e) {setError(String(e));setMessage('')}
    finally {setBusy(false)}
  }
  async function upload(file:File) {
    if(!owner)return
    if(file.size>20*1024*1024){setError('图片不能超过 20 MB');return}
    setBusy(true);setError('');setMessage('正在保存图片…')
    try {
      const value=await new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(file)
      })
      const asset=await asJson<{id:string}>('/api/assets',{method:'POST',headers,body:JSON.stringify({data:value})})
      await asJson('/api/assets/assignment',{method:'PUT',headers,body:JSON.stringify({kind:owner.kind,owner_id:owner.id,field,asset_id:asset.id,expected_url:owner[field]??null})})
      await load();setMessage(`已保存“${owner.name}”的${field==='avatar'?'头像':'立绘'}。重新进入角色页可查看。`)
    } catch(e) {setError(String(e));setMessage('')}
    finally {setBusy(false)}
  }
  return <section className="character-assets" aria-label="角色资源" aria-busy={busy||loading}>
    <h2 className="text-xl font-semibold">角色资源</h2>
    <p className="mt-2 text-sm text-[var(--text-2)]">头像和立绘保存在用户数据目录，独立于主题。设定以角色及身份编辑器保存的档案为准，更新图片不会修改设定。</p>
    {loading&&<p role="status">正在加载资源…</p>}
    {error&&<p role="alert" className="my-3 text-red-600">{error}</p>}
    <p role="status" className="my-3 text-sm">{message}</p>
    <div className="my-4 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] p-4">
      <label className="text-sm">目标档案<select className="input mt-1 block" value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">选择角色或身份</option>{owners.map(p=><option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>{p.kind==='characters'?'角色':'身份'} · {p.name}</option>)}</select></label>
      <label className="text-sm">图片用途<select className="input mt-1 block" value={field} disabled={busy} onChange={e=>setField(e.target.value as 'avatar'|'portrait')}><option value="avatar">头像</option><option value="portrait">立绘</option></select></label>
      <label className="text-sm">上传图片<input className="mt-1 block max-w-full text-xs" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy||!owner} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value=''}}/></label>
    </div>
    {data.legacy.length>0&&<div className="my-4 rounded-lg border border-amber-500 p-4"><h3>仍有 {data.legacy.length} 处旧图片引用</h3><ul className="my-2 text-sm">{data.legacy.map((p,i)=><li key={i}>{p.name} · {p.field} · {p.url}</li>)}</ul><button className="btn sm" disabled={busy} onClick={()=>void migrate()}>备份并保存旧图片</button><p className="mt-2 text-xs">源素材缺失时保留原引用；请恢复原包或重新上传对应图片。</p></div>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{data.items.map(asset=><article key={asset.id} className="min-w-0 rounded-lg border border-[var(--border)] p-4">
      {asset.available?<img src={asset.url} alt={asset.references.length?asset.references[0].name+' · 角色资源':'未关联的图片资源'} loading="lazy" className="h-40 w-full rounded bg-[var(--surface-2)] object-contain"/>:<p className="text-red-600">文件缺失，请恢复备份</p>}
      <p className="mt-3 text-xs text-[var(--text-2)]">{asset.mime} · {(asset.size/1024).toFixed(0)} KB · {asset.source==='user-upload'?'用户上传':asset.source==='attachment-image-import'?'附件转存':asset.source==='embedded-image-import'?'内嵌图片转存':'角色素材导入'}</p>
      <ul className="mt-2 text-sm">{asset.references.map((ref,i)=><li key={i}>{ref.name} · {ref.field==='avatar'?'头像':ref.field==='portrait'?'立绘':ref.field}</li>)}</ul>
      {!asset.references.length&&<p className="mt-2 text-sm text-[var(--text-3)]">暂无档案引用，文件保留。</p>}
      <code className="mt-2 block break-all text-[10px] text-[var(--text-3)]">{asset.id}</code>
    </article>)}</div>
    {!loading&&!error&&!data.items.length&&<p className="mt-4 text-sm">暂无已登记的角色图片。可选择档案上传，或保存旧图片。</p>}
  </section>
}
