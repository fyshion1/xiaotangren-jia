// 个人介绍 / 糖人小窝下方的画廊（《项目要求》§9.4）。
// 有真图就展示真实收藏（缩略图 + 描述），点开看大图；一张都没有时退回占位格子。
// 收藏入口在聊天里：图片气泡右上角的 ⭐ 或顶栏的 🖼 画廊。
// owner（§9.4 归属）：不传 = 全量（兼容旧调用）；'' = 家共用；<charId> = 该角色专属。
// 介绍页传当前角色的 id，小窝传 ''。
//
// 两层显示（§26）：这里是「展示端」—— 默认只铺公开层（private === false）。
// 私密层收在下面一条折叠行里，默认收起、点了才渲染；展开状态只存组件 state，
// 刷新页面自动收回去（故意的：私密图不该一进页面就摊在屏幕上）。
// 私密 ≠ 瞒着小糖人 —— 照片记忆照常，这里只是不让别人瞥屏。

import { useEffect, useRef, useState } from 'react'
import { fetchGallery, uploadToGallery, type GalleryItem } from '../api/gallery'

const CELLS = [
  { cls: 't1', emoji: '🌸', cap: '日常 · 烘焙坊', framed: true },
  { cls: 't2', emoji: '🍵', cap: '午后 · 一起喝茶' },
  { cls: 't3', emoji: '🌙', cap: '晚安 · 睡前故事' },
  { cls: 't4', emoji: '🍰', cap: '生日 · 蛋糕' },
  { cls: 't5', emoji: '🎀', cap: '服饰 · 主题换装' },
  { cls: 't6', emoji: '🧣', cap: '冬日 · 围巾' },
]

type Props = {
  /** 归属过滤：不传 = 全部；'' = 家共用；<charId> = 该角色专属。 */
  owner?: string
  /** 小窝的文案调子（家共用画廊）与角色介绍页不同。 */
  variant?: 'character' | 'home'
}

export default function GalleryGrid({ owner, variant = 'character' }: Props) {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  // 私密层折叠（§26）：默认收起，刷新即收回 —— 这个状态刻意不持久化。
  const [showPrivate, setShowPrivate] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = () => fetchGallery(owner)

  useEffect(() => {
    let cancelled = false
    fetchGallery(owner)
      .then((rows) => {
        if (!cancelled) setItems(rows.filter((g) => g.thumb || g.orig))
      })
      .catch(() => {
        /* 后端没起来时静默退回占位 */
      })
    return () => {
      cancelled = true
    }
  }, [owner])

  // 直接上传到本页固定的归属（§9.4）：介绍页 = 该角色，小窝 = 家共用。
  // 需要改归属的场合去聊天的 🖼 画廊（那里有选择器）。
  async function pickAndUpload(file: File) {
    setUploading(true)
    setUploadErr('')
    try {
      await uploadToGallery(file, { owner: owner ?? '' })
      setItems((await reload()).filter((g) => g.thumb || g.orig))
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  const hasReal = items.length > 0
  const isHome = variant === 'home'
  // 两层（§26）：公开层照旧铺；私密层只在展开时渲染。
  const publicItems = items.filter((g) => !g.private)
  const privateItems = items.filter((g) => g.private)

  function renderCell(g: GalleryItem) {
    return (
      <button
        key={g.id}
        type="button"
        onClick={() => setLightbox(g.orig || g.thumb)}
        title={g.description || '点开看大图'}
        className="relative aspect-[3/4] cursor-pointer overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] shadow-[var(--shadow-sm)] transition hover:-translate-y-1 hover:border-[var(--pink)] hover:shadow-[var(--shadow)]"
      >
        <img src={g.thumb || g.orig} alt={g.description || '画廊图片'} className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute right-2 top-2 flex gap-1">
          {g.private && (
            <span
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] text-[11px]"
              title="私密层：默认不展示（防别人瞥屏），仍可进小糖人记忆"
            >
              🔒
            </span>
          )}
          {g.in_memory && (
            <span
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] text-[11px] text-[var(--pink-deep)]"
              title="这张进了小糖人的记忆"
            >
              🧠
            </span>
          )}
        </div>
        <div className="absolute bottom-0 left-0 right-0 line-clamp-2 bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] px-2.5 py-1.5 text-left text-[12px] text-[var(--text-2)] backdrop-blur">
          {g.description || '（还没有描述）'}
        </div>
      </button>
    )
  }

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 className="text-[20px] font-extrabold tracking-wide">{isHome ? '共同回忆 · 画廊' : '画廊'}</h2>
        <span className="text-[13px] text-[var(--text-3)]">
          {isHome ? 'Home Gallery' : 'Gallery'} · {hasReal ? `已收藏 ${items.length} 张` : isHome ? '全家的合照都放这儿' : 'CG / 立绘 · 在个人介绍下方'}
        </span>
        <button
          type="button"
          className="btn ml-auto text-[13px]"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          title={isHome ? '上传到「家 · 共用」' : '上传到这位小糖人的专属画廊'}
        >
          {uploading ? '上传中…' : '＋ 上传图片'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void pickAndUpload(f)
          }}
        />
      </div>
      {uploadErr && <p className="mb-3 text-[12px] text-[var(--pink-deep)]">上传失败：{uploadErr}</p>}

      {hasReal && publicItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-8 text-center text-[12px] text-[var(--text-3)]">
          公开层是空的 —— 这里的图都收在私密层了（下面那条展开）。
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
          {hasReal
            ? publicItems.map(renderCell)
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
      )}

      {/* 私密层（§26）：一条折叠行，默认收起。防的是别人瞥屏，不是瞒着小糖人 */}
      {privateItems.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowPrivate((v) => !v)}
            className="flex w-full items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--text-2)] transition hover:border-[var(--pink)]"
            title="私密层：展示端默认收起（防别人瞥屏）。展开状态不保存，刷新页面会收回去"
          >
            <span>🔒</span>
            <span>私密 {privateItems.length} 张</span>
            <span className="text-[var(--text-3)]">
              {showPrivate ? '（点一下收起）' : '（点一下展开）'}
            </span>
            <span className="ml-auto text-[var(--text-3)]">{showPrivate ? '▲' : '▼'}</span>
          </button>
          {showPrivate && (
            <div className="mt-3 grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
              {privateItems.map(renderCell)}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[12px] text-[var(--text-3)]">
        {hasReal
          ? isHome
            ? '这里是全家的共同回忆（归属「家 · 共用」的图）。每张的描述会作为「照片记忆」被小糖人们想起来；管理在聊天的 🖼 画廊里。标 🔒 的收在私密层，默认不铺开。'
            : '这是这位小糖人的专属画廊 —— 你和她之间的图都在这。描述可作为「照片记忆」被她想起来。管理（上传 / 自动描述 / 删除 / 改归属 / 公开·私密）在聊天的 🖼 画廊里。标 🔒 的收在私密层，默认不铺开。'
          : isHome
            ? '小窝的画廊还空着 —— 在聊天的 🖼 画廊里上传图片并把归属设为「家 · 共用」，全家共同的回忆就会在这里长出来。'
            : '画廊还是空的 —— 和她的私聊里对图片气泡点 ⭐，或在 🖼 画廊里上传图片，都会自动归到她名下。'}
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