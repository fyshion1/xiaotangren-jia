import {useEffect, useRef, useState} from 'react'
import {asJson} from '../api/client'

type Metadata = {id:string;name:string;version:string;author:string;license:string;description:string}
type Pack = Metadata & {installed:boolean;characters:{character_id:string;available:number}[]}
type Entry = Metadata & {catalog_id:string;source:'local'|'github'}
type Preview = Metadata & {token:string;sha256:string;asset_count:number;installed_version:string|null;characters:{template_id:string;name:string;about:string;existing:boolean;action:string}[]}
const headers = {'X-Exploration-Dashboard':'1'}

export default function CharacterPackManager() {
  const [installed,setInstalled] = useState<Pack[]>([])
  const [catalog,setCatalog] = useState<Entry[]>([])
  const [catalogErrors,setCatalogErrors] = useState<{source:string;message:string}[]>([])
  const [preview,setPreview] = useState<Preview|null>(null)
  const [message,setMessage] = useState('')
  const [error,setError] = useState('')
  const [busy,setBusy] = useState('')
  const [loading,setLoading] = useState(true)
  const file = useRef<HTMLInputElement>(null)
  async function load() {
    const [packs,entries] = await Promise.all([
      asJson<{items:Pack[]}>('/api/character-packs',{headers}),
      asJson<{items:Entry[];errors:{source:string;message:string}[]}>('/api/character-packs/catalog',{headers}),
    ])
    setInstalled(packs.items);setCatalog(entries.items);setCatalogErrors(entries.errors)
  }
  useEffect(()=>{void load().catch(e=>setError(String(e))).finally(()=>setLoading(false))},[])
  async function run(label:string,work:()=>Promise<void>) {
    if(busy)return
    setBusy(label);setError('');setMessage('')
    try {await work()}catch(e){setError(String(e))}finally{setBusy('')}
  }
  async function upload(selected:File) {
    setPreview(null)
    if(selected.size>64*1024*1024){setError('角色包不能超过 64 MB');return}
    await run('正在校验角色包…',async()=>{
      const body = new FormData();body.append('file',selected)
      setPreview(await asJson<Preview>('/api/character-packs/preview',{method:'POST',headers,body}))
    })
  }
  async function inspect(entry:Entry) {
    setPreview(null)
    await run(entry.source==='github'?'正在下载并校验…':'正在校验本机包…',async()=>{
      setPreview(await asJson<Preview>(`/api/character-packs/catalog/${encodeURIComponent(entry.catalog_id)}/preview`,{method:'POST',headers}))
    })
  }
  async function install() {
    if(!preview)return
    const token=preview.token
    await run('正在导入角色与图片…',async()=>{
      const result=await asJson<{message:string}>('/api/character-packs/install',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({token})})
      setPreview(null);setMessage(result.message);await load()
      window.dispatchEvent(new Event('characters-changed'))
    })
  }
  async function uninstall(pack:Pack) {
    if(!window.confirm(`卸载“${pack.name}”的安装记录？已导入角色、个人修改、图片、聊天和记忆都会保留。`))return
    await run('正在卸载角色包…',async()=>{
      const result=await asJson<{message:string}>(`/api/character-packs/${encodeURIComponent(pack.id)}/uninstall`,{method:'POST',headers})
      setMessage(result.message);await load()
    })
  }
  return <section aria-label="角色包" className="mt-8 border-t border-[var(--border)] pt-6" aria-busy={Boolean(busy)||loading}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2>角色包</h2><p className="text-sm text-[var(--text-2)]">从本机包或已配置的 GitHub 发行目录选择，预览后导入。</p></div><button disabled={Boolean(busy)} onClick={()=>file.current?.click()}>选择角色包 ZIP</button></div>
    <input type="file" accept=".zip,application/zip" aria-label="选择角色包文件" className="hidden" ref={file} disabled={Boolean(busy)} onChange={e=>{const selected=e.target.files?.[0];e.target.value='';if(selected)void upload(selected)}}/>
    <p className="mt-2 text-xs text-[var(--text-3)]">仅导入资料和图片，不运行脚本。安装不覆盖已有角色；卸载保留用户数据。</p>
    <p role="status" className="my-3 text-sm">{loading?'正在读取角色包目录…':busy||message}</p>
    {error&&<p role="alert" className="my-3 text-sm text-red-600">{error}</p>}
    {catalogErrors.map((item,i)=><p key={i} role="alert" className="text-sm text-red-600">{item.source}：{item.message}</p>)}
    {preview&&<section aria-label="角色包安装预览" className="my-4 rounded-lg border-2 border-[var(--pink-deep)] bg-[var(--surface)] p-4">
      <h3>{preview.name} <span className="text-xs text-[var(--text-3)]">{preview.version}</span></h3>
      <p className="my-2 text-sm">{preview.description}</p><p className="text-xs">作者：{preview.author} · {preview.asset_count} 张图片</p>
      <details className="my-2 text-sm"><summary>授权说明与校验值</summary><p className="whitespace-pre-wrap">{preview.license}</p><code className="block break-all text-xs">SHA-256：{preview.sha256}</code></details>
      <p className="my-2 text-sm">{preview.installed_version?`已安装 ${preview.installed_version}；更新只补充新角色，已有角色保持原样。`:'确认后才会创建角色。预览本身不会导入。'} 同名角色不会自动合并；首次导入可能创建独立档案。</p>
      {preview.characters.map(character=><details key={character.template_id} className="my-2 rounded border border-[var(--border)] p-3"><summary className="cursor-pointer">{character.name} · {character.action}</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm">{character.about||'未提供角色说明'}</p></details>)}
      <div className="mt-4 flex flex-wrap gap-3"><button disabled={Boolean(busy)} onClick={()=>void install()}>确认导入（保留已有修改）</button><button disabled={Boolean(busy)} onClick={()=>setPreview(null)}>取消预览</button></div>
    </section>}
    <h3 className="mt-5 font-semibold">可获取的角色包</h3>
    {!loading&&!catalog.length&&!error&&<p className="my-3 text-sm text-[var(--text-2)]">尚未配置发行目录。可选择本机 ZIP；目前没有公共中心市场服务。</p>}
    {catalog.map(entry=><article key={entry.catalog_id} className="my-3 rounded-lg border border-[var(--border)] p-4"><h3>{entry.name} <span className="text-xs">{entry.version}</span></h3><p>{entry.description}</p><p className="mt-1">{entry.source==='local'?'本机可用包':'GitHub 发行文件'} · 作者：{entry.author}</p><button className="mt-3" disabled={Boolean(busy)} onClick={()=>void inspect(entry)}>{entry.source==='github'?'下载并预览':'预览角色包'}</button></article>)}
    <h3 className="mt-5 font-semibold">安装记录</h3>
    {!loading&&!installed.length&&!error&&<p className="my-3 text-sm text-[var(--text-2)]">暂无角色包安装记录。</p>}
    {installed.map(pack=><article key={pack.id} className="my-3 rounded-lg border border-[var(--border)] p-4"><h3>{pack.name} <span className="text-xs">{pack.version} · {pack.installed?'已安装':'已卸载，角色保留'}</span></h3><p>{pack.characters.filter(c=>c.available).length} 个已导入角色仍在档案中</p>{pack.installed&&<button className="mt-3" disabled={Boolean(busy)} onClick={()=>void uninstall(pack)}>卸载角色包</button>}</article>)}
  </section>
}
