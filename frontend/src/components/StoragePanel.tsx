import { useEffect, useRef, useState } from 'react'
import { attachmentStats, clearOriginals, type AttachmentStats } from '../api/storage'

type Props = { sessionKey: string; sessionName: string; onClose: () => void }
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

export default function StoragePanel({ sessionKey, sessionName, onClose }: Props) {
  const [stats, setStats] = useState<AttachmentStats | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    let active = true
    attachmentStats(sessionKey).then(
      (value) => { if (active) setStats(value) },
      (e) => { if (active) setError(String(e.message ?? e)) },
    )
    return () => { active = false }
  }, [sessionKey])

  const current = stats?.sessions.find((s) => s.session === stats.current_session)
  const purge = async () => {
    if (!confirming || busyRef.current || !current?.orig_bytes) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setResult('')
    try {
      const removed = await clearOriginals(sessionKey)
      setConfirming(false)
      setStats(null)
      setResult(`已清理 ${removed} 个原图文件，缩略图和聊天记录已保留。`)
      setStats(await attachmentStats(sessionKey))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => { if (!busy) onClose() }}>
      <section role="dialog" aria-modal="true" aria-labelledby="storage-title"
        className="my-6 w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="storage-title" className="font-bold">存储管理</h2>
          <button className="btn ghost sm" disabled={busy} onClick={onClose}>关闭</button>
        </div>
        <p className="break-words text-sm">当前会话：{sessionName}</p>
        {stats ? (
          <div className="my-4 space-y-2 text-sm text-[var(--text-2)]">
            <p>本会话原图：{size(current?.orig_bytes ?? 0)}</p>
            <p>本会话缩略图：{size(current?.thumb_bytes ?? 0)}</p>
            <p>全部会话原图占用：{size(stats.orig_bytes)}</p>
          </div>
        ) : !error && <p className="my-4 text-sm">加载存储统计…</p>}
        <p className="my-3 text-sm leading-relaxed text-[var(--text-2)]">
          清理会永久删除本会话的高清原图，包括已收藏到画廊的图片原文件。
          缩略图、聊天记录和收藏记录保留；其他会话里的引用若使用同一原图，也只能查看缩略图。
          恢复高清需要重新上传或生成。
        </p>
        {error && <p role="alert" className="my-3 text-sm text-[var(--pink-deep)]">{error}</p>}
        {result && <p role="status" className="my-3 text-sm">{result}</p>}
        {confirming ? (
          <div className="mt-4 rounded-xl border border-[var(--pink)] p-3">
            <p className="mb-3 text-sm font-semibold">确认永久清理「{sessionName}」的原图（{size(current?.orig_bytes ?? 0)}）？此操作无法撤销。</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn ghost sm" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
              <button className="btn sm" disabled={busy} onClick={() => void purge()}>{busy ? '清理中…' : '确认清理原图'}</button>
            </div>
          </div>
        ) : (
          <button className="btn ghost sm mt-3" disabled={!current?.orig_bytes || busy}
            onClick={() => { setResult(''); setConfirming(true) }}>清理本会话原图…</button>
        )}
      </section>
    </div>
  )
}
