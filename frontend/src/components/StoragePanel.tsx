// 存储管理（《项目要求》§15.3）：列出本会话磁盘上的媒体文件，用户自己勾选要删的那些，
// 再确认一次才真删 —— 不会再出现「点一下就把全部原图删光」。
//
// 旧版只有一个「清理本会话原图…」按钮，一点就整目录清空：误触即不可恢复。
// 现在改成：勾选 → 汇总体积 → 二次确认 → 只删勾中的（连带它们的画廊收藏）。
// 缩略图不单独列出（它是原图的衍生物，删原图时按 hash 一并回收）。

import { useEffect, useState } from 'react'
import {
  attachmentStats,
  loadMessages,
  deleteMessages,
  type StoredMessage,
  deleteAttachments,
  listAttachments,
  type AttachmentFile,
  type AttachmentStats,
} from '../api/storage'

type Props = { sessionKey?: string; sessionName?: string; onClose?: () => void; embedded?: boolean }

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

export default function StoragePanel({ sessionKey = 'group', sessionName = '群聊', onClose = () => {}, embedded = false }: Props) {
  const [tab,setTab] = useState<'messages'|'files'>('messages')
  const [sessions,setSessions] = useState<{session_id:string;count:number}[]>([])
  const [messages,setMessages] = useState<StoredMessage[]>([])
  const [pickedMessages,setPickedMessages] = useState<Set<string>>(new Set())
  const [more,setMore] = useState(false)
  const [cursor,setCursor] = useState<number|null>(null)
  const [confirmMessages,setConfirmMessages] = useState(false)
  useEffect(()=>{void fetch('/api/storage/sessions').then(r=>r.json()).then(d=>setSessions(d.items || [])).catch(e=>setError(String(e)))},[])
  const [stats, setStats] = useState<AttachmentStats | null>(null)
  const [files, setFiles] = useState<AttachmentFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingFiles, setLoadingFiles] = useState(true)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  // 只看某一类：图片 / 视频 / 全部。
  const [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video'>('all')
  // 看哪个会话的落盘 —— 画廊 / 介绍页上传的素材统一落在 "gallery"，不隶属任何聊天会话；
  // 一个聊天会话的存储面板看不到它们，而大视频恰恰都堆在那里。所以这里给一个会话选择器。
  const [target, setTarget] = useState(sessionKey)

  async function reloadFiles(session = target) {
    setLoadingFiles(true)
    try {
      const data = await listAttachments(session)
      setFiles(data.items)
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingFiles(false)
    }
  }

  useEffect(() => {
    let active = true
    setError('')
    setResult('')
    setConfirming(false)
    attachmentStats(target).then(
      (value) => { if (active) setStats(value) },
      (e) => { if (active) setError(String(e.message ?? e)) },
    )
    void reloadFiles(target)
    setPickedMessages(new Set());setConfirmMessages(false)
    void loadMessages(target,undefined,50).then(page=>{if(active && page){setMessages(page.items);setMore(page.has_more);setCursor(page.next_cursor)}})
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const current = stats?.sessions.find((s) => s.session === stats.current_session)
  const shown = files.filter((f) => kindFilter === 'all' || f.kind === kindFilter)
  const picked = files.filter((f) => selected.has(f.name))
  const pickedBytes = picked.reduce((sum, f) => sum + f.size, 0)

  // 可切换的会话：当前会话 + 画廊素材库 + 统计里出现过（有原图占用）的那些，去重。
  const targets = Array.from(new Set([sessionKey, 'gallery', ...sessions.map(s=>s.session_id), ...(stats?.sessions ?? []).map((s) => s.session)])).filter(
    (s) => s,
  )
  const targetLabel = (s: string) => (s === 'gallery' ? '画廊 / 介绍页素材' : s === sessionKey ? sessionName : s)

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleAll() {
    const names = shown.map((f) => f.name)
    const allOn = names.every((n) => selected.has(n))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const n of names) {
        if (allOn) next.delete(n)
        else next.add(n)
      }
      return next
    })
  }

  async function purge() {
    if (!confirming || busy || !picked.length) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      const r = await deleteAttachments(target, picked.map((f) => f.name))
      setConfirming(false)
      setResult(
        `已删除 ${picked.length} 个文件（共 ${size(pickedBytes)}）` +
          (r.gallery_rows ? `，连带清掉 ${r.gallery_rows} 条画廊收藏。` : '。') +
          (r.skipped.length ? ` ${r.skipped.length} 个没能删掉，请刷新后重试。` : ''),
      )
      await reloadFiles()
      setStats(await attachmentStats(target))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={embedded ? "storage-settings" : "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"}
      onClick={() => { if (!busy) onClose() }}
    >
      <section
        role={embedded ? undefined : "dialog"}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="storage-title"
        className={`storage-panel w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 ${embedded ? "" : "my-6 max-w-2xl shadow-xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="storage-title" className="font-bold">存储管理</h2>
          {!embedded && <button className="btn ghost sm" disabled={busy} onClick={onClose}>关闭</button>}
        </div>
        <p className="break-words text-sm">聊天、图片和视频完整保存在本地。删除原始记录会同步更新 01 日归档；已审核的记忆单独在私人空间管理。</p>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-[var(--text-2)]">看哪个库：</span>
          <select
            className="input !w-auto !py-1 text-[12px]"
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
            title="画廊 / 介绍页上传的图片和视频统一落在「画廊 / 介绍页素材」里，聊天会话的存储面板看不到它们"
          >
            {targets.map((s) => (
              <option key={s} value={s}>
                {targetLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <nav className="memory-tabs"><button className={tab==='messages'?'active':''} onClick={()=>setTab('messages')}>聊天记录</button><button className={tab==='files'?'active':''} onClick={()=>setTab('files')}>图片与视频</button></nav>
        {tab==='messages' && <div className="mt-4">
          <p className="text-[12px] text-[var(--text-3)] mb-3">{sessions.find(s=>s.session_id===target)?.count || messages.length} 条消息 · 按时间排序。删除消息会回收不再被其他消息引用的附件。</p>
          <button className="btn sm ghost" onClick={()=>setPickedMessages(new Set(messages.map(m=>m.id)))}>选择已加载消息</button>
          <div className="max-h-[55vh] overflow-y-auto mt-3">{messages.map(m=><label className="context-message flex gap-3" key={m.id}><input type="checkbox" checked={pickedMessages.has(m.id)} onChange={e=>setPickedMessages(prev=>{const n=new Set(prev);e.target.checked?n.add(m.id):n.delete(m.id);return n})}/><span className="min-w-0"><small>{m.created_at ? new Date(m.created_at.replace(' ','T')+'Z').toLocaleString() : ''} · {m.role==='user'?'你':'角色'}</small><p className="whitespace-pre-wrap">{m.content}</p>{m.image && <a className="text-[var(--pink-deep)]" href={m.image} target="_blank" rel="noreferrer">{m.image_source==='video'?'查看视频原文件':'查看图片'}</a>}</span></label>)}</div>
          {more && <button className="btn sm ghost" onClick={async()=>{const p=await loadMessages(target,cursor || undefined,50);if(p){setMessages(prev=>[...p.items,...prev]);setMore(p.has_more);setCursor(p.next_cursor)}}}>加载更早消息</button>}
          <div className="mt-3 flex flex-wrap gap-2">{!confirmMessages ? <button className="btn sm" disabled={busy || !pickedMessages.size} onClick={()=>setConfirmMessages(true)}>删除选中 {pickedMessages.size} 条记录</button> : <><span className="text-[12px]">将删除原文及其未被引用的附件，确定继续？</span><button className="btn sm" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const r=await deleteMessages([...pickedMessages]);if(!r)throw Error('删除失败，请重试');setMessages(prev=>prev.filter(m=>!pickedMessages.has(m.id)));setPickedMessages(new Set());setConfirmMessages(false);setResult(`已删除 ${r.deleted} 条消息`);const d=await fetch('/api/storage/sessions').then(r=>r.json());setSessions(d.items || []);await reloadFiles();window.dispatchEvent(new Event('chat-storage-changed'))}catch(e){setError(String(e))}finally{setBusy(false)}}}>确认删除</button><button className="btn sm ghost" onClick={()=>setConfirmMessages(false)}>取消</button></>}</div>
        </div>}
        {tab==='files' && <>
        {stats && (
          <div className="my-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[var(--text-2)]">
            <span>本会话原图：{size(current?.orig_bytes ?? 0)}</span>
            <span>本会话缩略图：{size(current?.thumb_bytes ?? 0)}</span>
            <span>全部会话原图占用：{size(stats.orig_bytes)}</span>
          </div>
        )}

        <p className="my-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-2)]">
          下面列出的是本会话落盘的原文件。<b className="text-[var(--pink-deep)]">勾上你要删的那些，再点删除</b> ——
          只会删掉你勾中的，不再是一点删光。删原图会连带删掉它的缩略图，以及它在画廊里的收藏（和对应照片记忆）；
          聊天记录本身保留，但那张图会变成打不开的空图。标「引用 N」的是还被消息 / 画廊用着的，删之前想清楚。
        </p>

        {/* 类型筛选 + 全选 */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-0.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] p-0.5">
            {(['all', 'image', 'video'] as const).map((k) => {
              const count = files.filter((f) => k === 'all' || f.kind === k).length
              const on = kindFilter === k
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKindFilter(k)}
                  className={`rounded-md px-2 py-0.5 text-[12px] transition ${
                    on ? 'bg-[var(--pink)] text-white' : 'text-[var(--text-2)] hover:bg-[var(--surface)]'
                  }`}
                >
                  {k === 'all' ? '全部' : k === 'image' ? '图片' : '视频'} {count}
                </button>
              )
            })}
          </span>
          {shown.length > 0 && (
            <button className="btn ghost sm" disabled={busy} onClick={toggleAll}>
              {shown.every((f) => selected.has(f.name)) ? '取消全选' : '全选本页'}
            </button>
          )}
          <span className="ml-auto text-[12px] text-[var(--text-3)]">
            已选 {picked.length} 个 · {size(pickedBytes)}
          </span>
        </div>

        {/* 文件清单 */}
        <div className="max-h-[46vh] overflow-y-auto rounded-xl border border-[var(--border)]">
          {loadingFiles ? (
            <div className="py-8 text-center text-[12px] text-[var(--text-3)]">读取文件…</div>
          ) : shown.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-[var(--text-3)]">
              这个筛选下没有文件。原图被清过的会话只看得到缩略图，会显示为空。
            </div>
          ) : (
            shown.map((f) => (
              <label
                key={f.name}
                className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 py-2 last:border-b-0 hover:bg-[var(--surface-2)]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(f.name)}
                  disabled={busy}
                  onChange={() => toggle(f.name)}
                />
                {f.kind === 'video' ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video src={f.orig} muted playsInline preload="metadata" className="h-11 w-11 shrink-0 rounded-md border border-[var(--border)] object-cover" />
                ) : (
                  <img src={f.thumb} alt="" className="h-11 w-11 shrink-0 rounded-md border border-[var(--border)] object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-[var(--text)]">
                    {f.kind === 'video' ? '▶ ' : ''}
                    {f.stem}.{f.ext.replace(/^\./, '')}
                  </div>
                  <div className="text-[11px] text-[var(--text-3)]">
                    {size(f.size)}
                    {f.refs > 0 ? ` · 引用 ${f.refs}` : ' · 无引用'}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>

        {error && <p role="alert" className="my-3 text-sm text-[var(--pink-deep)]">{error}</p>}
        {result && <p role="status" className="my-3 text-sm">{result}</p>}

        {confirming ? (
          <div className="mt-3 rounded-xl border border-[var(--pink)] p-3">
            <p className="mb-3 text-sm font-semibold">
              确认永久删除「{targetLabel(target)}」里勾选的 {picked.length} 个文件（共 {size(pickedBytes)}）？此操作无法撤销。
            </p>
            <ul className="mb-3 max-h-[18vh] overflow-y-auto text-[12px] text-[var(--text-2)]">
              {picked.slice(0, 40).map((f) => (
                <li key={f.name} className="truncate">
                  · {f.stem}.{f.ext.replace(/^\./, '')}（{size(f.size)}）
                </li>
              ))}
              {picked.length > 40 && <li>… 还有 {picked.length - 40} 个</li>}
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn ghost sm" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
              <button className="btn sm" disabled={busy} onClick={() => void purge()}>
                {busy ? '删除中…' : '确认删除勾选的'}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn ghost sm mt-3"
            disabled={!picked.length || busy}
            onClick={() => { setResult(''); setConfirming(true) }}
          >
            删除勾选的 {picked.length} 个…
          </button>
        )}
        </>}
        {tab==='messages' && <>{error && <p role="alert" className="err-tip mt-3">{error}</p>}{result && <p role="status" className="text-[12px] mt-3">{result}</p>}</>}
      </section>
    </div>
  )
}