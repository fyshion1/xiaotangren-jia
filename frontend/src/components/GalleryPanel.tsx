// 画廊浮层（《项目要求》§9.4）：已收藏的重要图片 + 「照片记忆」开关 + 归属分类。
// 每条 = 图片 + 一段文字描述；描述按 A 方案进 §9.2 的 RAG。
// 归属（owner）：'' = 家共用，<charId> = 该角色专属。私聊里 ⭐ / 上传会自动归属该角色，
// 这里可以手动改（用户原话：「不用自动识别，我会自己手动分类」）。
// B 方案（多模态 CLIP）在 backend/app/services/multimodal.py 留了接口占位，默认关闭。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteGallery,
  describeImage,
  fetchGallery,
  updateGallery,
  uploadManyToGallery,
  type GalleryItem,
} from '../api/gallery'
import { ownerLabel, type Owner } from '../lib/owner'
import GalleryLightbox from './GalleryLightbox'

type Props = {
  onClose: () => void
  onChanged?: () => void
  // 自动描述要用的 vision 模型来源（与聊天共用一套配置）
  baseUrl?: string
  apiKey?: string
  visionModel?: string
  // 当前是否走无审查通道：决定自动描述是否注入越狱提示（§7）
  uncensored?: boolean
  /** 可选的归属对象（角色列表，由调用方传入，别硬编码中文名）。 */
  characters?: { id: string; name: string }[]
  /** 新建上传时的默认归属（= 当前会话推导出的 owner，见 lib/owner.ts）。 */
  defaultOwner?: Owner
}

export default function GalleryPanel({
  onClose,
  onChanged,
  baseUrl,
  apiKey,
  visionModel,
  uncensored,
  characters = [],
  defaultOwner = '',
}: Props) {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  // 归属筛选：'all' = 不看归属全列（默认，便于把一张图改到别的归属）
  const [filter, setFilter] = useState<'all' | Owner>('all')
  // 层级筛选（§26）：'public' 公开层 / 'private' 私密层 / 'all' 两层都看。
  // 默认只看公开层 —— 别人凑过来时屏幕上不会先铺一屏私密图。
  const [tier, setTier] = useState<'public' | 'private' | 'all'>('public')
  const [uploadOwner, setUploadOwner] = useState<Owner>(defaultOwner)
  const [uploadPrivate, setUploadPrivate] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // 单张详阅浮层（§9.4）：点缩略图打开，带整套画廊动作（自动描述 / 归属 / 私密…）。
  const [openId, setOpenId] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setItems(await fetchGallery())
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const shown = items.filter(
    (g) => (filter === 'all' || g.owner === filter) && (tier === 'all' || g.private === (tier === 'private')),
  )
  // 详阅浮层用的当前项（列表刷新后按 id 重新取，拿到最新的描述 / 层级）。
  // 必须 useMemo，且只依赖 items（reload 时才换引用）：浮层内部按「传入的项」重置编辑态，
  // 若每次渲染都造一个新对象，用户刚敲进编辑框的内容会被立刻清掉。
  const openItem = useMemo(() => items.find((g) => g.id === openId) ?? null, [items, openId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 详阅浮层开着时，Esc 先关它，不要连面板一起关掉。
        if (openId) setOpenId('')
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, openId])

  function flash(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }

  async function pickAndUpload(files: File[]) {
    if (!files.length) return
    setUploading(true)
    setError('')
    try {
      const { items: added, errors } = await uploadManyToGallery(files, {
        owner: uploadOwner,
        private: uploadPrivate,
      })
      await reload()
      onChanged?.()
      if (errors.length) {
        setError(`${added.length} 个成功、${errors.length} 个失败：${errors[0].error}`)
      } else {
        flash(
          `已上传 ${added.length} 个到「${ownerLabel(uploadOwner, characters)}」${uploadPrivate ? '的私密层 🔒' : ' ✓'}`,
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function setOwner(id: string, owner: Owner) {
    setBusyId(id)
    setError('')
    try {
      await updateGallery(id, { owner })
      await reload()
      onChanged?.()
      flash(`归属已改为「${ownerLabel(owner, characters)}」（照片记忆跟着搬过去了）`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  async function autoDescribe(id: string) {
    setBusyId(id)
    setError('')
    try {
      const r = await describeImage(id, {
        base_url: baseUrl,
        api_key: apiKey,
        model: visionModel,
        uncensored,
      })
      await reload()
      onChanged?.()
      flash(r.saved ? '描述写好了，已同步进记忆 ✓' : '描述写好了 ✓')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  async function saveDescription(id: string, description: string) {
    setBusyId(id)
    setError('')
    try {
      await updateGallery(id, { description })
      setEditing(null)
      await reload()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  async function toggleMemory(id: string, next: boolean) {
    setBusyId(id)
    setError('')
    try {
      await updateGallery(id, { in_memory: next })
      await reload()
      onChanged?.()
      flash(next ? '已进小糖人记忆 ✓' : '已移出记忆（图还在画廊里）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  // 切公开层 / 私密层（§26）：只动界面归属，不碰照片记忆 —— 私密是防瞥屏，不是瞒角色。
  async function togglePrivate(id: string, next: boolean) {
    setBusyId(id)
    setError('')
    try {
      await updateGallery(id, { private: next })
      await reload()
      onChanged?.()
      flash(next ? '已收进私密层 🔒（展示端默认不列出，记忆不受影响）' : '已放回公开层 ✓')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  async function remove(id: string) {
    setBusyId(id)
    setError('')
    try {
      await deleteGallery(id)
      await reload()
      onChanged?.()
      flash('已从画廊移除（连带删掉它的照片记忆）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-6 w-full max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[15px] font-semibold text-[var(--text)]">🖼 画廊</span>
          <span className="text-[11px] text-[var(--text-3)]">
            重要图片 · 分公开 / 私密两层 · 按归属分类（私聊自动归属，这里可手改）
          </span>
          <button onClick={onClose} className="ml-auto text-[var(--text-3)] hover:text-[var(--text)]">
            ✕
          </button>
        </div>

        {/* 归属筛选 + 层级筛选 + 上传 */}
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
          {/* 层级（§26）：公开 / 私密 / 全部。默认公开 —— 别人凑过来时不会先看到一屏私密图 */}
          <span className="flex items-center gap-0.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-0.5">
            {(['public', 'private', 'all'] as const).map((t) => {
              const count = items.filter((g) => t === 'all' || g.private === (t === 'private')).length
              const on = tier === t
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  className={`rounded-md px-2 py-0.5 text-[12px] transition ${
                    on
                      ? t === 'private'
                        ? 'bg-[var(--pink-deep)] text-white'
                        : 'bg-[var(--pink)] text-white'
                      : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                  }`}
                  title={
                    t === 'public'
                      ? '公开层：介绍页 / 小窝默认展示的那些'
                      : t === 'private'
                        ? '私密层：展示端默认不列出（防别人瞥屏）；仍可进小糖人记忆'
                        : '两层一起看'
                  }
                >
                  {t === 'public' ? '公开' : t === 'private' ? '🔒 私密' : '全部'} {count}
                </button>
              )
            })}
          </span>

          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', '', ...characters.map((c) => c.id)] as ('all' | Owner)[]).map((o) => {
              const active = filter === o
              const count = o === 'all' ? items.length : items.filter((g) => g.owner === o).length
              return (
                <button
                  key={o || 'home'}
                  type="button"
                  onClick={() => setFilter(o)}
                  className={`rounded-full border px-2.5 py-1 text-[12px] transition ${
                    active
                      ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:border-[var(--pink)]'
                  }`}
                >
                  {o === 'all' ? `全部 ${count}` : `${ownerLabel(o, characters)} ${count}`}
                </button>
              )
            })}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <select
              className="input !w-auto !py-1 text-[12px]"
              value={uploadOwner}
              onChange={(e) => setUploadOwner(e.target.value)}
              title="新上传的图片归到谁名下"
            >
              <option value="">家 · 共用</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label
              className="flex cursor-pointer items-center gap-1 text-[12px] text-[var(--text-2)]"
              title="勾上 = 直接传进私密层，展示端默认不列出"
            >
              <input
                type="checkbox"
                checked={uploadPrivate}
                onChange={(e) => setUploadPrivate(e.target.checked)}
              />
              🔒 私密
            </label>
            <button
              className="btn sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              title="从本地选照片 / 视频上传进画廊，可多选（在别处生的图也能收进来）"
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
        </div>

        {(error || notice) && (
          <div
            className={`mb-3 rounded-xl border px-3 py-2 text-[12px] ${
              error
                ? 'border-[color-mix(in_srgb,var(--pink)_45%,var(--border))] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]'
            }`}
          >
            {error || notice}
          </div>
        )}

        {loading ? (
          <div className="py-10 text-center text-[12px] text-[var(--text-3)]">读取中…</div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-[var(--text-3)]">
            画廊还是空的。对着图片气泡点 <b className="text-[var(--pink-deep)]">⭐</b> 收藏，
            或点右上角 <b>＋ 上传图片</b> 把在别处生的图也收进来。
          </div>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-[var(--text-3)]">
            {tier === 'private'
              ? '私密层还是空的。在公开层勾上某张图的「🔒 私密」，或上传时勾「🔒 私密」收进来。'
              : '这个筛选下还没有图。切到「全部」层级或别的归属，或用「＋ 上传图片」往这里放一张。'}
          </div>
        ) : (
          <div className="space-y-3">
            {shown.map((g) => {
              const thumb = g.thumb || g.orig
              const isEditing = editing?.id === g.id
              return (
                <div
                  key={g.id}
                  className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
                >
                  <button
                    type="button"
                    onClick={() => setOpenId(g.id)}
                    className="relative shrink-0"
                    title={g.kind === 'video' ? '点开看视频（带画廊动作）' : '点开看大图（带画廊动作）'}
                  >
                    {g.kind === 'video' ? (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <video src={g.orig} muted playsInline preload="metadata" className="h-[110px] w-[110px] rounded-lg border border-[var(--border)] object-cover" />
                    ) : (
                      <img
                        src={thumb}
                        alt={g.description || '画廊图片'}
                        className="h-[110px] w-[110px] rounded-lg border border-[var(--border)] object-cover"
                      />
                    )}
                    {g.kind === 'video' && (
                      <span
                        className="absolute left-1 top-1 flex h-[20px] w-[20px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_75%,transparent)] text-[11px]"
                        title="视频"
                      >
                        ▶
                      </span>
                    )}
                    {g.private && (
                      <span
                        className="absolute right-1 top-1 flex h-[20px] w-[20px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_75%,transparent)] text-[11px]"
                        title="私密层：展示端默认不列出"
                      >
                        🔒
                      </span>
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <textarea
                        className="input min-h-[64px] w-full resize-y text-[13px]"
                        value={editing.text}
                        onChange={(e) => setEditing({ id: g.id, text: e.target.value })}
                        placeholder="写一段描述，例如：大诗音系着围裙在烘焙坊里端着刚烤好的小饼干"
                      />
                    ) : (
                      <div className="text-[13px] leading-snug text-[var(--text)]">
                        {g.description ? (
                          g.description
                        ) : (
                          <span className="text-[var(--text-3)]">（还没有描述，点「自动描述」或「编辑」写一句）</span>
                        )}
                      </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {isEditing ? (
                        <>
                          <button
                            className="btn sm"
                            disabled={busyId === g.id}
                            onClick={() => void saveDescription(g.id, editing.text)}
                          >
                            保存描述
                          </button>
                          <button className="btn ghost sm" onClick={() => setEditing(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn ghost sm"
                            disabled={busyId === g.id || g.kind === 'video'}
                            onClick={() => void autoDescribe(g.id)}
                            title={g.kind === 'video' ? '视频不支持自动描述，请手写一句' : '让看图模型看一眼，自动写一段中文描述'}
                          >
                            {busyId === g.id ? '看图…' : '自动描述'}
                          </button>
                          <button
                            className="btn ghost sm"
                            onClick={() => setEditing({ id: g.id, text: g.description })}
                          >
                            编辑
                          </button>
                          <label
                            className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-2)]"
                            title="关掉后这张图不再进小糖人的长期记忆，但图片仍留在画廊里"
                          >
                            <input
                              type="checkbox"
                              checked={g.in_memory}
                              disabled={busyId === g.id}
                              onChange={(e) => void toggleMemory(g.id, e.target.checked)}
                            />
                            进小糖人记忆
                          </label>
                          <label
                            className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-2)]"
                            title="收进私密层：介绍页 / 小窝默认不列出它（防别人瞥屏）。不影响的记忆 —— 私密 ≠ 瞒着小糖人"
                          >
                            <input
                              type="checkbox"
                              checked={g.private}
                              disabled={busyId === g.id}
                              onChange={(e) => void togglePrivate(g.id, e.target.checked)}
                            />
                            🔒 私密
                          </label>
                          <label
                            className="flex items-center gap-1.5 text-[12px] text-[var(--text-2)]"
                            title="这张图归谁 —— 决定它出现在谁的画廊里，以及照片记忆进谁的脑袋"
                          >
                            归属
                            <select
                              className="input !w-auto !py-1 text-[12px]"
                              value={g.owner}
                              disabled={busyId === g.id}
                              onChange={(e) => void setOwner(g.id, e.target.value)}
                            >
                              <option value="">家 · 共用</option>
                              {characters.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                              {/* 归属指向了已不存在的角色时，别让它静默变成空白 */}
                              {g.owner && !characters.some((c) => c.id === g.owner) && (
                                <option value={g.owner}>{g.owner}（已不存在）</option>
                              )}
                            </select>
                          </label>
                          <button
                            className="ml-auto text-[12px] text-[var(--text-3)] hover:text-[var(--pink-deep)]"
                            disabled={busyId === g.id}
                            onClick={() => void remove(g.id)}
                          >
                            移除
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className="mt-4 text-[11px] leading-snug text-[var(--text-3)]">
          归属：私聊里 ⭐ / 上传的图自动归到对方名下，「家 · 共用」则是全家的共同回忆（见「糖人小窝」）。
          改了归属，它的照片记忆会跟着搬 —— 专属归属的记忆只有那个人在场时才检索得到。
          层级（§26）：<b>私密</b>只是「介绍页 / 小窝默认不列出它」，防的是别人瞥屏，
          和「进小糖人记忆」是两回事 —— 私密图照样能被小糖人想起来。
          照片记忆（A 方案）：描述以「你有一张照片：…」的形式进 §9.2 的检索，只在话题相关时自然流露。
          多模态 CLIP 直检索（B 方案）已在后端留了 Provider 接口占位，默认不启用。
        </p>
      </div>

      {/* 单张详阅浮层（§9.4）：点缩略图打开，动作和介绍页立绘浮层共用一套组件 */}
      {openItem && (
        <GalleryLightbox
          item={openItem}
          characters={characters}
          baseUrl={baseUrl}
          apiKey={apiKey}
          visionModel={visionModel}
          uncensored={uncensored}
          onClose={() => setOpenId('')}
          onChanged={async (next) => {
            await reload()
            onChanged?.()
            if (next === null) setOpenId('')
          }}
        />
      )}
    </div>
  )
}