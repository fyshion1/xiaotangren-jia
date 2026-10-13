// 画廊大图浮层（§9.4 / §19.13）：点开一张收藏图 / 一段画廊视频，把画廊那一套按钮
// 直接摊在大图上 —— 自动描述 / 编辑 / 进小糖人记忆 / 🔒 私密 / 归属 / 移除。
//
// 为什么单独抽出来：介绍页的立绘浮层和聊天里的 🖼 画廊浮层本来各写一份 <img>，
// 介绍页那份只有「看大图」，没有画廊动作 —— 用户要在两个地方来回跳才能改一张图。
// 现在两处共用这一个组件，点开就能改。
//
// 与 GalleryPanel 的区别：这里是「单张详阅 + 操作」，不带筛选 / 批量上传。

import { useEffect, useState } from 'react'
import { deleteGallery, describeImage, updateGallery, type GalleryItem } from '../api/gallery'
import { ownerLabel, type Owner } from '../lib/owner'

type Props = {
  item: GalleryItem
  characters?: { id: string; name: string }[]
  /** 自动描述用的 vision 模型来源（与聊天共用一套配置）。 */
  baseUrl?: string
  apiKey?: string
  visionModel?: string
  /** 当前是否走无审查通道：决定自动描述是否注入越狱提示（§7）。 */
  uncensored?: boolean
  onClose: () => void
  /** 任何一项改动（改描述 / 归属 / 层级 / 记忆 / 移除）后回调，让列表刷新。 */
  onChanged?: (next?: GalleryItem | null) => void
}

export default function GalleryLightbox({
  item,
  characters = [],
  baseUrl,
  apiKey,
  visionModel,
  uncensored,
  onClose,
  onChanged,
}: Props) {
  const [cur, setCur] = useState<GalleryItem>(item)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  // 传到浮层的项换了（列表刷新后 id 相同但内容变了）→ 同步。
  useEffect(() => {
    setCur(item)
    setEditing(null)
  }, [item])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editing !== null) setEditing(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  function apply(next: GalleryItem | undefined | null) {
    if (next) setCur(next)
    onChanged?.(next)
  }

  async function autoDescribe() {
    setBusy(true)
    setError('')
    try {
      const r = await describeImage(cur.id, {
        base_url: baseUrl,
        api_key: apiKey,
        model: visionModel,
        uncensored,
      })
      apply(r.item ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveDescription(text: string) {
    setBusy(true)
    setError('')
    try {
      apply(await updateGallery(cur.id, { description: text }))
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggleMemory(next: boolean) {
    setBusy(true)
    setError('')
    try {
      apply(await updateGallery(cur.id, { in_memory: next }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function togglePrivate(next: boolean) {
    setBusy(true)
    setError('')
    try {
      apply(await updateGallery(cur.id, { private: next }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function setOwner(owner: Owner) {
    setBusy(true)
    setError('')
    try {
      apply(await updateGallery(cur.id, { owner }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('从画廊移除这一项？\n\n它的照片记忆会一起删掉；图片文件本身仍留着（要去存储管理里回收）。')) return
    setBusy(true)
    setError('')
    try {
      await deleteGallery(cur.id)
      onChanged?.(null)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const isVideo = cur.kind === 'video'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="gallery-lightbox-card my-4 w-full max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[14px] font-semibold text-[var(--text)]">
            {isVideo ? '▶ 画廊视频' : '🖼 画廊图片'}
          </span>
          {cur.private && <span className="text-[11px] text-[var(--text-3)]">🔒 私密层</span>}
          <button onClick={onClose} className="ml-auto text-[var(--text-3)] hover:text-[var(--text)]" title="关闭（Esc）">
            ✕
          </button>
        </div>

        {/* 大图 / 视频本体 */}
        <div className="flex items-center justify-center rounded-xl bg-black/20">
          {isVideo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={cur.orig} controls autoPlay playsInline className="max-h-[62vh] w-full rounded-xl" />
          ) : (
            <img
              src={cur.orig || cur.thumb}
              alt={cur.description || '画廊图片'}
              className="max-h-[62vh] w-full rounded-xl object-contain"
            />
          )}
        </div>

        {(error || (!isVideo && busy)) && (
          <div
            className={`mt-3 rounded-xl border px-3 py-2 text-[12px] ${
              error
                ? 'border-[color-mix(in_srgb,var(--pink)_45%,var(--border))] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-3)]'
            }`}
          >
            {error || '处理中…'}
          </div>
        )}

        {/* 描述（编辑中 / 只读） */}
        <div className="mt-3">
          {editing !== null ? (
            <div className="flex flex-col gap-2">
              <textarea
                className="input min-h-[64px] w-full resize-y text-[13px]"
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                placeholder="写一段描述，例如：大诗音系着围裙在烘焙坊里端着刚烤好的小饼干"
                autoFocus
              />
              <div className="flex gap-2">
                <button className="btn sm" disabled={busy} onClick={() => void saveDescription(editing)}>
                  保存描述
                </button>
                <button className="btn ghost sm" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-[13px] leading-snug text-[var(--text)]">
                {cur.description || (
                  <span className="text-[var(--text-3)]">（还没有描述，点「自动描述」或「编辑」写一句）</span>
                )}
              </p>
              <button className="btn ghost sm shrink-0" onClick={() => setEditing(cur.description)}>
                编辑
              </button>
            </div>
          )}
        </div>

        {/* 画廊动作按钮：和 🖼 画廊浮层里那一套完全一致 */}
        <div className="gallery-lightbox-actions mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
          <button
            className="btn ghost sm"
            disabled={busy || isVideo}
            onClick={() => void autoDescribe()}
            title={isVideo ? '视频不支持自动描述，请手写一句' : '让看图模型看一眼，自动写一段中文描述'}
          >
            {busy && !isVideo ? '看图…' : '自动描述'}
          </button>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-2)]"
            title="关掉后这一项不再进小糖人的长期记忆，但内容仍留在画廊里"
          >
            <input
              type="checkbox"
              checked={cur.in_memory}
              disabled={busy}
              onChange={(e) => void toggleMemory(e.target.checked)}
            />
            进小糖人记忆
          </label>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-2)]"
            title="收进私密层：介绍页 / 小窝默认不列出它（防别人瞥屏）。不影响记忆 —— 私密 ≠ 瞒着小糖人"
          >
            <input
              type="checkbox"
              checked={cur.private}
              disabled={busy}
              onChange={(e) => void togglePrivate(e.target.checked)}
            />
            🔒 私密
          </label>
          <label
            className="flex items-center gap-1.5 text-[12px] text-[var(--text-2)]"
            title="这一项归谁 —— 决定它出现在谁的画廊里，以及照片记忆进谁的脑袋"
          >
            归属
            <select
              className="input !w-auto !py-1 text-[12px]"
              value={cur.owner}
              disabled={busy}
              onChange={(e) => void setOwner(e.target.value)}
            >
              <option value="">家 · 共用</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {cur.owner && !characters.some((c) => c.id === cur.owner) && (
                <option value={cur.owner}>{cur.owner}（已不存在）</option>
              )}
            </select>
          </label>
          <button
            className="ml-auto text-[12px] text-[var(--text-3)] hover:text-[var(--pink-deep)]"
            disabled={busy}
            onClick={() => void remove()}
          >
            移除
          </button>
        </div>

        <p className="mt-2 text-[11px] leading-snug text-[var(--text-3)]">
          当前归属：<b>{ownerLabel(cur.owner, characters)}</b>。改归属会让它的照片记忆跟着搬家；
          专属归属的记忆只有那个人在场时才检索得到。
        </p>
      </div>
    </div>
  )
}