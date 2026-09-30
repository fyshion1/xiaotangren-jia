// 个人介绍下方的画廊（《项目要求》§9.4）。
// 有真图就展示真实收藏（缩略图 + 描述），点开看大图；一张都没有时退回占位格子。
// 收藏入口在聊天里：图片气泡右上角的 ⭐ 或顶栏的 🖼 画廊。

import { useEffect, useState } from 'react'
import { fetchGallery, type GalleryItem } from '../api/gallery'

const CELLS = [
  { cls: 't1', emoji: '🌸', cap: '日常 · 烘焙坊', framed: true },
  { cls: 't2', emoji: '🍵', cap: '午后 · 一起喝茶' },
  { cls: 't3', emoji: '🌙', cap: '晚安 · 睡前故事' },
  { cls: 't4', emoji: '🍰', cap: '生日 · 蛋糕' },
  { cls: 't5', emoji: '🎀', cap: '服饰 · 主题换装' },
  { cls: 't6', emoji: '🧣', cap: '冬日 · 围巾' },
]

export default function GalleryGrid() {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchGallery()
      .then((rows) => {
        if (!cancelled) setItems(rows.filter((g) => g.thumb || g.orig))
      })
      .catch(() => {
        /* 后端没起来时静默退回占位 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  const hasReal = items.length > 0

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[20px] font-extrabold tracking-wide">画廊</h2>
        <span className="text-[13px] text-[var(--text-3)]">
          Gallery · {hasReal ? `已收藏 ${items.length} 张` : 'CG / 立绘 · 在个人介绍下方'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
        {hasReal
          ? items.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setLightbox(g.orig || g.thumb)}
                title={g.description || '点开看大图'}
                className="relative aspect-[3/4] cursor-pointer overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] shadow-[var(--shadow-sm)] transition hover:-translate-y-1 hover:border-[var(--pink)] hover:shadow-[var(--shadow)]"
              >
                <img src={g.thumb || g.orig} alt={g.description || '画廊图片'} className="absolute inset-0 h-full w-full object-cover" />
                {g.in_memory && (
                  <span
                    className="absolute right-2 top-2 flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] text-[11px] text-[var(--pink-deep)]"
                    title="这张进了小糖人的记忆"
                  >
                    🧠
                  </span>
                )}
                <div className="absolute bottom-0 left-0 right-0 line-clamp-2 bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] px-2.5 py-1.5 text-left text-[12px] text-[var(--text-2)] backdrop-blur">
                  {g.description || '（还没有描述）'}
                </div>
              </button>
            ))
          : CELLS.map((c) => (
              <div
                key={c.cap}
                className="relative aspect-[3/4] cursor-pointer overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] shadow-[var(--shadow-sm)] transition hover:-translate-y-1 hover:border-[var(--pink)] hover:shadow-[var(--shadow)]"
              >
                <div className={`absolute inset-0 flex items-center justify-center text-[40px] ${c.cls}`}>{c.emoji}</div>
                {c.framed && (
                  <span className="absolute right-2 top-2 flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] text-[11px] text-[var(--text-3)]">
                    ♡
                  </span>
                )}
                <div className="absolute bottom-0 left-0 right-0 bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--text-2)] backdrop-blur">
                  {c.cap}
                </div>
              </div>
            ))}
      </div>

      <p className="mt-3 text-[12px] text-[var(--text-3)]">
        {hasReal
          ? '画廊里是你主动收藏的重要图片；描述可作为「照片记忆」被小糖人想起来。管理（自动描述 / 删除 / 进不进记忆）在聊天的 🖼 画廊里。'
          : '画廊还是空的 —— 在聊天里对图片气泡点 ⭐ 存入画廊，这里就会长出真图（现在是占位格）。'}
      </p>

      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="大图" className="max-h-[88vh] max-w-[88vw] rounded-xl shadow-2xl" />
        </div>
      )}
    </section>
  )
}