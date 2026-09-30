// 画廊浮层（《项目要求》§9.4）：已收藏的重要图片 + 「照片记忆」开关。
// 每条 = 图片 + 一段文字描述；描述按 A 方案进 §9.2 的 RAG（家记忆）。
// B 方案（多模态 CLIP）在 backend/app/services/multimodal.py 留了接口占位，默认关闭。

import { useCallback, useEffect, useState } from 'react'
import {
  deleteGallery,
  describeImage,
  fetchGallery,
  updateGallery,
  type GalleryItem,
} from '../api/gallery'

type Props = {
  onClose: () => void
  onChanged?: () => void
  // 自动描述要用的 vision 模型来源（与聊天共用一套配置）
  baseUrl?: string
  apiKey?: string
  visionModel?: string
}

export default function GalleryPanel({ onClose, onChanged, baseUrl, apiKey, visionModel }: Props) {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setItems(await fetchGallery())
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightbox) setLightbox(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, lightbox])

  function flash(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }

  async function autoDescribe(id: string) {
    setBusyId(id)
    setError('')
    try {
      const r = await describeImage(id, {
        base_url: baseUrl,
        api_key: apiKey,
        model: visionModel,
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
            你主动收藏的重要图片 · 描述按 A 方案进记忆（聊到相关话题时她会想起）
          </span>
          <button onClick={onClose} className="ml-auto text-[var(--text-3)] hover:text-[var(--text)]">
            ✕
          </button>
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
            画廊还是空的。在聊天里对着图片气泡点 <b className="text-[var(--pink-deep)]">⭐</b> 就能收藏进来。
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((g) => {
              const thumb = g.thumb || g.orig
              const isEditing = editing?.id === g.id
              return (
                <div
                  key={g.id}
                  className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
                >
                  <button
                    type="button"
                    onClick={() => setLightbox(g.orig || g.thumb)}
                    className="shrink-0"
                    title="点开看大图"
                  >
                    <img
                      src={thumb}
                      alt={g.description || '画廊图片'}
                      className="h-[110px] w-[110px] rounded-lg border border-[var(--border)] object-cover"
                    />
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
                            disabled={busyId === g.id}
                            onClick={() => void autoDescribe(g.id)}
                            title="让看图模型看一眼，自动写一段中文描述"
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
          照片记忆（A 方案）：描述会以「你有一张照片：…」的形式进 §9.2 的检索，只在话题相关时自然流露。
          多模态 CLIP 直检索（B 方案）已在后端留了 Provider 接口占位，默认不启用。
        </p>
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation()
            setLightbox(null)
          }}
        >
          <img src={lightbox} alt="大图" className="max-h-[88vh] max-w-[88vw] rounded-xl shadow-2xl" />
        </div>
      )}
    </div>
  )
}