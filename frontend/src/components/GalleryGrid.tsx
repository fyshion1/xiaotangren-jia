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
import { fetchGallery, uploadManyToGallery, type GalleryItem } from '../api/gallery'
import { fetchCharacters } from '../api/client'
import { isUncensoredChannel, visionRoute } from '../lib/visionRoute'
import GalleryLightbox from './GalleryLightbox'

// 画廊里图片 / 视频统一渲染（§9.4）：视频用 <video> 播，图片用 <img>。
// 抽出来一处，公开层 / 私密层 / 大图浮层共用，免得三种入口各写一份。
function GalleryMedia({ item, className }: { item: GalleryItem; className?: string }) {
  if (item.kind === 'video') {
    return (
      <video
        src={item.orig}
        className={className}
        muted
        playsInline
        preload="metadata"
        onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
        onMouseLeave={(e) => {
          e.currentTarget.pause()
          e.currentTarget.currentTime = 0
        }}
      />
    )
  }
  return <img src={item.thumb || item.orig} alt={item.description || '画廊图片'} className={className} />
}

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
  /** 由外面的抽屉提供标题（§9.6 布局改造）—— 画廊本身照旧，只是不再自带标题行。 */
  bare?: boolean
}

export default function GalleryGrid({ owner, variant = 'character', bare = false }: Props) {
  // 自动描述要用的 vision 上游：从本地模型配置里解析，规则与聊天页一致（§7）。
  const route = visionRoute()
  const uncensored = isUncensoredChannel()
  const [items, setItems] = useState<GalleryItem[]>([])
  // 大图浮层：存整条画廊项（不只是 URL）—— 视频要按 kind 走 <video>，图片走 <img>，
  // 而且浮层里要摊出画廊动作（自动描述 / 归属 / 私密…）。
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null)
  // 归属下拉要的角色名单（这里不经过 App 的 characters prop，单独拉一次）。
  const [characters, setCharacters] = useState<{ id: string; name: string }[]>([])
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

  // 浮层的「归属」下拉要角色名单；拉不到就只留「家 · 共用」，不挡看图。
  useEffect(() => {
    let cancelled = false
    fetchCharacters()
      .then((cs) => {
        if (!cancelled) setCharacters(cs.map((c) => ({ id: c.id, name: c.name })))
      })
      .catch(() => {
        /* 拉不到名单不影响看图 / 改描述，只是归属下拉少几个人 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 直接上传到本页固定的归属（§9.4）：介绍页 = 该角色，小窝 = 家共用。
  // 支持多选（照片 + 视频混选）：一次挑一堆，整批落盘再收藏。
  // 需要改归属的场合去聊天的 🖼 画廊（那里有选择器）。
  async function pickAndUpload(files: File[]) {
    if (!files.length) return
    setUploading(true)
    setUploadErr('')
    try {
      const { items: added, errors } = await uploadManyToGallery(files, { owner: owner ?? '' })
      setItems((await reload()).filter((g) => g.thumb || g.orig))
      if (errors.length) {
        setUploadErr(`${added.length} 个成功、${errors.length} 个失败：${errors[0].error}`)
      }
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // Esc 关闭交给 GalleryLightbox 自己处理（它还要处理「编辑中先退出编辑」的层级）。

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
        onClick={() => setLightbox(g)}
        title={g.description || (g.kind === 'video' ? '点开看视频' : '点开看大图')}
        className="relative aspect-[3/4] cursor-pointer overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] shadow-[var(--shadow-sm)] transition hover:-translate-y-1 hover:border-[var(--pink)] hover:shadow-[var(--shadow)]"
      >
        <GalleryMedia
          item={g}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute right-2 top-2 flex gap-1">
          {g.kind === 'video' && (
            <span
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] text-[11px]"
              title="视频"
            >
              ▶
            </span>
          )}
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
    <section className={bare ? '' : 'mt-10'}>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        {!bare && (
          <>
            <h2 className="text-[20px] font-extrabold tracking-wide">{isHome ? '共同回忆 · 画廊' : '画廊'}</h2>
            <span className="text-[13px] text-[var(--text-3)]">
              {isHome ? 'Home Gallery' : 'Gallery'} · {hasReal ? `已收藏 ${items.length} 项` : isHome ? '全家的合照都放这儿' : 'CG / 立绘 · 在个人介绍下方'}
            </span>
          </>
        )}
        <button
          type="button"
          className="btn ml-auto text-[13px]"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          title={isHome ? '上传到「家 · 共用」（可多选照片 / 视频）' : '上传到这位小糖人的专属画廊（可多选照片 / 视频）'}
        >
          {uploading ? '上传中…' : '＋ 上传图片 / 视频'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? [])
            if (fs.length) void pickAndUpload(fs)
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
            <span>私密 {privateItems.length} 项</span>
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

      {/* 大图 / 视频浮层 + 画廊动作（§9.4）：和 🖼 画廊浮层共用同一个组件 */}
      {lightbox && (
        <GalleryLightbox
          item={lightbox}
          characters={characters}
          baseUrl={route.baseUrl}
          apiKey={route.apiKey}
          visionModel={route.model}
          uncensored={uncensored}
          onClose={() => setLightbox(null)}
          onChanged={async (next) => {
            const rows = (await reload()).filter((g) => g.thumb || g.orig)
            setItems(rows)
            // 浮层里的改动（描述 / 层级 / 移除）要立刻反映到浮层自己身上。
            if (next === null) setLightbox(null)
            else if (next) setLightbox(next)
            else setLightbox(rows.find((g) => g.id === lightbox.id) ?? null)
          }}
        />
      )}
    </section>
  )
}