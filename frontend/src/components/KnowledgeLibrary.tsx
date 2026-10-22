import { useEffect, useRef, useState } from 'react'
import { captureKnowledge, decideCapture, decideKnowledge, importKnowledge, indexKnowledge, loadKnowledge, proposeKnowledge, readKnowledge, searchKnowledge, type KnowledgeHit } from '../api/knowledge'
import { fetchToolConfig, saveToolConfig } from '../api/tools'
import './knowledge.css'

const excerpt = (text: string) => text.split('\n').slice(0, 8).join('\n').slice(0, 220)

export default function KnowledgeLibrary({ personaId, onOpen }: { personaId: string; onOpen: (path: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadKnowledge>> | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('宋代的货币和贸易')
  const [region, setRegion] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState('待核实')
  const [anchor, setAnchor] = useState('')
  const [preview, setPreview] = useState('')
  const [captureTitle, setCaptureTitle] = useState('')
  const [captureBody, setCaptureBody] = useState('')
  const [captureCategory, setCaptureCategory] = useState('未分类')
  const [captureSource, setCaptureSource] = useState('')
  const generation = useRef(0)
  async function reload() {
    const token = generation.current
    const next = await loadKnowledge()
    if (token === generation.current) {
      if (next.persona_id === personaId) setData(next)
      else { setData(null); setNotice('请先成为当前查看的身份，再使用它的知识资料。') }
    }
  }
  useEffect(() => {
    generation.current++
    setData(null); setHits([]); setTarget(''); setPreview(''); setBody(''); setAnchor(''); setNotice(''); setSelected([])
    setCaptureTitle(''); setCaptureBody(''); setCaptureCategory('未分类'); setCaptureSource('')
    void reload().catch(e => setNotice(String(e)))
    const interval = window.setInterval(() => { void reload().catch(() => {}) }, 15000)
    return () => { generation.current++; window.clearInterval(interval) }
  }, [personaId])
  async function task(fn: () => Promise<void>) {
    setBusy(true); setNotice('')
    try { await fn() } catch (error) { setNotice(String(error)) } finally { setBusy(false) }
  }
  return <details className="knowledge-library" open>
    <summary><b>知识资料 · 通用资料库</b><span>{data?.documents.length ?? 0} 份正文 · {(data?.proposals.length ?? 0) + (data?.captures?.length ?? 0)} 条待确认草稿</span></summary>
    <p>收录文章、歌词、代码、食谱和各种文本笔记。原文保留，确认后加入个人知识检索；历史笔记仍可按年代查询。</p>
    <div className="knowledge-actions">
      <button className="btn sm ghost" disabled={busy} onClick={() => void task(reload)}>刷新资料与草案</button>
      <button className="btn sm ghost" disabled={busy || !data?.documents.length} onClick={() => void task(async () => {
        const token = generation.current
        let remaining = 1
        while (remaining && token === generation.current) {
          const result = await indexKnowledge(); remaining = result.remaining
          setNotice(`语义索引：${result.done} / ${result.total}${remaining ? '，继续处理中…' : '，已完成。'}`)
        }
      })}>建立／补齐语义索引</button>
      <button className="btn sm" disabled={busy || !data} onClick={() => void task(async () => {
        const current = await fetchToolConfig()
        if (current.config.owner_persona_id !== personaId) throw new Error('请先在工具中心核对主人身份，再开启知识工具')
        await saveToolConfig({ ...current.config, enabled: true, allowed_names: [...new Set([...current.config.allowed_names, 'knowledge_search', 'knowledge_read', 'knowledge_propose'])] })
        setNotice('已开启知识查询与补充草案工具。聊天中的补充在此处确认后写回。')
      })}>允许小糖人查资料、提补充</button>
    </div>
    <details><summary>收录新资料（粘贴文本）</summary>
      <form className="knowledge-draft" onSubmit={e => { e.preventDefault(); void task(async () => {
        const token = generation.current
        const result = await captureKnowledge(captureTitle, captureBody, captureCategory, captureSource, personaId)
        if (token !== generation.current) return
        setCaptureBody(''); await reload()
        setNotice(`已生成收录草稿：${result.title}。请核对原文并确认后入库。`)
      }) }}>
        <p>保留换行和缩进，每份最多 20 万字符。这里只生成草稿；来源未知可留空。图片、音视频和扫描 PDF 需先转成文本。</p>
        <label>资料标题<input className="input" value={captureTitle} maxLength={160} required onChange={e => setCaptureTitle(e.target.value)} /></label>
        <label>资料分类<input className="input" value={captureCategory} maxLength={80} onChange={e => setCaptureCategory(e.target.value)} placeholder="如歌词、文章、代码，也可以自定义" /></label>
        <label>资料来源（可选）<input className="input" value={captureSource} maxLength={2000} onChange={e => setCaptureSource(e.target.value)} placeholder="链接、作者、版本或自己的笔记" /></label>
        <label>资料原文<textarea className="textarea" rows={10} value={captureBody} maxLength={200000} required onChange={e => setCaptureBody(e.target.value)} /></label>
        <small>{captureBody.length.toLocaleString()} / 200,000 字符</small>
        <button className="btn sm" disabled={busy || !data || !captureTitle.trim() || !captureBody.trim()}>生成收录草稿</button>
      </form>
    </details>
    {data?.captures?.map(draft => <article className="knowledge-proposal" key={draft.id}>
      <b>待收录：{draft.title} · {draft.category}</b><small>{draft.created_at} · {draft.body.length.toLocaleString()} 字符</small>
      <p>来源：{draft.source || '未提供'}。确认后保存为独立资料，不追加到其他文档。</p>
      <details><summary>预览完整原文</summary><pre className="knowledge-preview">{draft.body}</pre></details>
      <div className="knowledge-actions">
        <button className="btn sm" disabled={busy || !data} onClick={() => void task(async () => {
          const token = generation.current
          const result = await decideCapture(draft.id, 'confirm', personaId)
          if (token !== generation.current) return
          await reload(); setHits([]); setNotice('已收录独立资料，原文已保存并可检索；语义向量可按需补齐。')
          if (result.path) onOpen(result.path)
        })}>确认收录</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => void task(async () => { await decideCapture(draft.id, 'reject', personaId); await reload() })}>放弃收录</button>
      </div>
    </article>)}
    <details><summary>导入历史原笔记</summary>
      <p>重复导入保留已有工作正文；Word 后续变更会提示，不会覆盖聊天补充。</p>
      <div className="knowledge-sources">{data?.sources.map(source => <label key={source.path}>
        <input type="checkbox" checked={selected.includes(source.path)} onChange={e => setSelected(old => e.target.checked ? [...old, source.path] : old.filter(p => p !== source.path))} />{source.path.split('/').slice(-2).join('/')}
      </label>)}</div>
      <button className="btn sm" disabled={busy || !selected.length} onClick={() => void task(async () => {
        const result = await importKnowledge(selected); await reload()
        setNotice(`新增 ${result.items.filter(i => i.status === 'imported').length} 份，其余已存在、重复或无有效正文。`)
      })}>导入所选 {selected.length} 份</button>
    </details>
    <form className="knowledge-search" onSubmit={e => { e.preventDefault(); void task(async () => {
      if ((start && !Number.isInteger(Number(start))) || (end && !Number.isInteger(Number(end)))) throw new Error('年代请输入整数，公元前使用负数')
      const result = await searchKnowledge(query, region, start ? Number(start) : undefined, end ? Number(end) : undefined)
      setHits(result.items); setNotice(`${result.items.length} 条结果。${result.mode.startsWith('keyword') ? '本次使用关键词检索。' : result.mode === 'hybrid_partial' ? '混合检索，向量索引仍在分批建立。' : '本次使用混合检索。'}${result.note}`)
    }) }}>
      <label>查什么<input className="input" value={query} onChange={e => setQuery(e.target.value)} required maxLength={400} /></label>
      <label>地区<select className="input" value={region} onChange={e => setRegion(e.target.value)}><option value="">全部地区</option>{['中国', '日本', '欧洲', '俄国', '印度', '美国', '东南亚', '中东', '非洲', '拉丁美洲'].map(r => <option key={r}>{r}</option>)}</select></label>
      <label>开始年<input className="input" type="number" min={-10000} max={3000} value={start} onChange={e => setStart(e.target.value)} placeholder="如 618" /></label>
      <label>结束年<input className="input" type="number" min={-10000} max={3000} value={end} onChange={e => setEnd(e.target.value)} placeholder="如 907" /></label>
      <button className="btn sm" disabled={busy || !data?.documents.length}>{busy ? '处理中…' : '查笔记'}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    <div className="knowledge-hits">{hits.map(hit => <article key={hit.id}>
      <b>{hit.title}</b><small>{hit.region} · {hit.themes} {hit.year_start !== null ? `· ${hit.year_start}～${hit.year_end}` : '· 年代未标定'}{hit.uncertain ? ' · 含存疑或宽泛年代标记' : ''}{hit.partial_time_match ? ' · 仅年代范围相交' : ''}</small>
      <pre>{excerpt(hit.text)}{excerpt(hit.text) !== hit.text ? '…' : ''}</pre>
      {excerpt(hit.text) !== hit.text && <details><summary>展开本段原文</summary><pre>{hit.text}</pre></details>}
      {hit.warning && <p>{hit.warning}</p>}
      {!!hit.related_versions?.length && <details><summary>另有同名版本，内容可能存在差异</summary>{hit.related_versions.map(path => <p key={path}>{path}</p>)}</details>}
      {!!hit.alternative_sources?.length && <details><summary>相同引文的其他来源</summary>{hit.alternative_sources.map(path => <p key={path}>{path}</p>)}</details>}
      <div className="knowledge-actions"><a href={`/api/knowledge/citations/${encodeURIComponent(hit.id)}`} target="_blank" rel="noreferrer">原文与上下文</a>
        <button className="btn sm ghost" onClick={() => onOpen(hit.path)}>编辑工作正文</button>
        <button className="btn sm ghost" onClick={() => { setTarget(hit.doc_id); setAnchor(''); setPreview(''); setBody('') }}>向此文档补充想法</button></div>
    </article>)}</div>
    <details><summary>已导入的知识正文</summary>{data?.documents.map(doc => <div className="knowledge-document" key={doc.id}>
      <button className="btn sm ghost" onClick={() => onOpen(doc.path)}>{doc.title}</button><small>{doc.category ? `${doc.category} · ` : ''}{doc.chunks} 个片段{doc.source_changed ? ' · 源资料已变化，工作正文未被覆盖' : ''}</small>
      {doc.source_note && <small>来源：{doc.source_note}</small>}
      {!!doc.related_versions?.length && <small>另有 {doc.related_versions.length} 份同名版本，保留各自出处</small>}
    </div>)}</details>
    {target && <div className="knowledge-draft">
      <b>补充到：{data?.documents.find(d => d.id === target)?.title}</b>
      <p>保留现有正文。可指定原文中唯一出现的一段文字，补充将插入其所在段落后；留空则放到文末。</p>
      <button className="btn sm ghost" disabled={busy} onClick={() => void task(async () => { setPreview((await readKnowledge(target)).content) })}>查看当前全文</button>
      {preview && <pre className="knowledge-preview">{preview}</pre>}
      <label>分类<select className="input" value={kind} onChange={e => setKind(e.target.value)}>{['想法', '讨论结论', '待核实'].map(k => <option key={k}>{k}</option>)}</select></label>
      <label>定位原文（可选）<textarea className="textarea" value={anchor} maxLength={800} onChange={e => setAnchor(e.target.value)} /></label>
      <label>补充内容<textarea className="textarea" value={body} maxLength={4000} onChange={e => setBody(e.target.value)} /></label>
      <button className="btn sm" disabled={busy || !body.trim()} onClick={() => void task(async () => {
        await proposeKnowledge(target, body, kind, anchor); setBody(''); setTarget(''); await reload(); setNotice('补充草案已生成，请核对后确认。')
      })}>生成补充草案</button>
    </div>}
    {data?.proposals.map(proposal => <article className="knowledge-proposal" key={proposal.id}>
      <b>待确认：{proposal.title} · {proposal.kind}</b><small>{proposal.created_at}</small>
      <p>{proposal.anchor ? `插入位置：原文“${proposal.anchor}”所在段落后` : '插入位置：文末'}</p><pre>{proposal.body}</pre>
      <div className="knowledge-actions"><button className="btn sm ghost" onClick={() => onOpen(proposal.path)}>核对原文</button>
        <button className="btn sm" disabled={busy} onClick={() => void task(async () => { await decideKnowledge(proposal.id, 'confirm'); await reload(); setHits([]); setNotice('已补入工作正文，保留历史版本，索引已更新。'); onOpen(proposal.path) })}>确认补入正文</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => void task(async () => { await decideKnowledge(proposal.id, 'reject'); await reload() })}>放弃</button></div>
    </article>)}
  </details>
}
