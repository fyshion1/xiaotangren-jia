import { useEffect, useState } from 'react'

type Item = { id: string; text: string; review_status: string; perspective: string; reviewer?: string; state: string }
type Space = { location: string; sources: number; docs: string[]; items: Item[] }

export default function SandboxPersonalMemory({ persona, speaker }: { persona: string; speaker: string }) {
  const [space, setSpace] = useState<Space | null>(null)
  const [error, setError] = useState('')
  const [document, setDocument] = useState('')
  useEffect(() => { setSpace(null); setDocument(''); setError('') }, [persona, speaker])
  async function read(path?: string) {
    const requested = new URLSearchParams({ persona, speaker, ...(path ? { path } : {}) })
    try {
      const response = await fetch('/api/exploration-projects/personal-space' + (path ? '/document' : '') + '?' + requested,
        { headers: { 'X-Exploration-Dashboard': '1' } })
      const value = await response.json()
      if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '个人工作区读取失败')
      if (path) setDocument(value.content)
      else setSpace(value)
      setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return <details className="my-3 rounded border border-[var(--border)] p-2 text-sm">
    <summary className="cursor-pointer">她的独立记忆与工作手册</summary>
    <p className="my-2 text-xs text-[var(--text-3)]">由此角色自行提出、审核和召回，与主记忆库分开。自己审核不代表主人认可或获得工具权限；主记忆和当前身份全角色历史对话可只读观察。</p>
    <button type="button" className="btn ghost sm" disabled={!persona || !speaker} onClick={() => void read()}>查看个人记忆与文档</button>
    {error && <p role="alert">{error}</p>}
    {space && <>
      <p className="mt-2 text-xs break-all">工作区：{space.location}</p>
      <p className="my-2 text-xs">原始依据 {space.sources} 条 · 待审核 {space.items.filter(i => i.review_status === 'pending').length} 条 · 已由她审核 {space.items.filter(i => i.review_status === 'approved').length} 条</p>
      <div className="flex flex-wrap gap-2">{space.docs.map(path => <button key={path} type="button" className="btn ghost sm" onClick={() => void read(path)}>{path}</button>)}</div>
      {document && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{document}</pre>}
      {space.items.map(i => <details key={i.id} className="mt-2 rounded border p-2 text-xs">
        <summary>{({ pending: '待她审核', approved: '她已收录', rejected: '她已拒绝', archived: '已归档' } as Record<string, string>)[i.review_status] || i.review_status} · {({ self: '自身记录', observed: '只读观察', reflection: '自述与感想' } as Record<string, string>)[i.perspective] || i.perspective}</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words">{i.text}</pre>
        <p>{i.reviewer || '尚未审核'} · {i.state}</p>
      </details>)}
    </>}
  </details>
}
