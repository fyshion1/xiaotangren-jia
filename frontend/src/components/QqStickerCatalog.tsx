import { useCallback, useEffect, useRef, useState } from 'react'
import { describeQqSticker, fetchQqStickers, saveQqSticker, type QqSticker } from '../api/client'

export default function QqStickerCatalog() {
  const [items, setItems] = useState<QqSticker[]>([])
  const [emotions, setEmotions] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [watch, setWatch] = useState(0)
  const dirty = useRef(new Set<string>())
  const load = useCallback(async () => {
    try {
      const data = await fetchQqStickers()
      setItems((old) => data.items.map((item) => dirty.current.has(item.id)
        ? old.find((x) => x.id === item.id) || item : item))
      setEmotions(data.emotions)
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!watch) return
    const timer = window.setInterval(() => {
      void load()
      if (Date.now() > watch) setWatch(0)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [watch, load])

  const recognize = async (item?: QqSticker) => {
    setBusy(item?.id || 'all')
    try {
      await describeQqSticker(item?.url, !!item)
      setNote(item ? '已提交重新识别。手动保存的描述优先保留。' : '已提交未识别的表情，每批最多 3 张，使用 QQ 桥的视觉模型。')
      setWatch(Date.now() + 90000)
      await load()
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  return <details open className="mt-4 rounded-xl border border-[var(--border)] p-3" onToggle={(e) => {
    if (e.currentTarget.open) { void load(); setWatch(Date.now() + 60000) }
  }}>
    <summary className="cursor-pointer text-[13px] font-bold">表情的含义与情绪</summary>
    <p className="my-2 text-[12px] text-[var(--text-2)]">只记录表情的动作和情绪，方便聊天时选图。不会因此写入个人长期记忆。拿不准的图可以先不选情绪，机器人就不会随意发送。</p>
    <div className="mb-3 flex flex-wrap gap-2">
      <button className="btn" onClick={() => void load()}>刷新图库</button>
      <button className="btn" disabled={!!busy} onClick={() => void recognize()}>识别未标注的表情</button>
    </div>
    {note && <p role="status" className="mb-2 text-[12px]">{note}</p>}
    {!items.length && <p className="text-[12px] text-[var(--text-3)]">暂无可用原图。先在上方表情包库上传或从 QQ 收集，再刷新。</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => <div key={item.id} className="rounded-lg border border-[var(--border)] p-2">
        <div className="flex gap-2">
          <img src={item.url} alt={item.description || '待标注表情'} loading="lazy" className="h-20 w-20 shrink-0 object-contain" />
          <div className="min-w-0 flex-1">
            <span className="text-[11px] text-[var(--text-3)]">{item.manual ? '已手动修订' : item.status === 'ready' ? '已识别' : item.status === 'error' ? '识别未完成' : '待识别'}</span>
            <textarea aria-label="表情描述" className="input mt-1 w-full text-[12px]" maxLength={300} disabled={busy === item.id}
              value={item.description} placeholder="例如：歪着头，像在问怎么啦"
              onChange={(e) => { dirty.current.add(item.id); setItems((all) => all.map((x) => x.id === item.id ? { ...x, description: e.target.value } : x)) }} />
          </div>
        </div>
        <div className="my-2 flex flex-wrap gap-x-3 gap-y-1">
          {emotions.map((emotion) => <label key={emotion} className="flex items-center gap-1 text-[11px]">
            <input type="checkbox" checked={item.emotions.includes(emotion)} disabled={busy === item.id || (!item.emotions.includes(emotion) && item.emotions.length >= 3)}
              onChange={(e) => { dirty.current.add(item.id); setItems((all) => all.map((x) => x.id === item.id ? { ...x,
                emotions: e.target.checked ? [...x.emotions, emotion] : x.emotions.filter((a) => a !== emotion) } : x)) }} />{emotion}
          </label>)}
        </div>
        {item.detail && <p className="mb-2 text-[11px] text-[var(--text-3)]">{item.detail}</p>}
        <div className="flex gap-2">
          <button className="btn" disabled={!!busy || !item.description.trim()} onClick={async () => {
            setBusy(item.id)
            try {
              const saved = await saveQqSticker(item.id, item.description, item.emotions)
              dirty.current.delete(item.id)
              setItems((all) => all.map((x) => x.id === saved.id ? saved : x))
              setNote('已保存；之后按这个描述和情绪选图。')
            } catch (e) { setNote(e instanceof Error ? e.message : String(e)) }
            finally { setBusy('') }
          }}>保存含义</button>
          <button className="btn" disabled={!!busy || item.manual} onClick={() => void recognize(item)}>重新识别</button>
        </div>
      </div>)}
    </div>
  </details>
}
