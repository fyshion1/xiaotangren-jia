import { useCallback, useEffect, useState } from 'react'
import type { WorldbookEntry } from '../data/worldbook'
import { keywordList } from '../data/worldbook'
import {
  createWorldbookEntry,
  deleteWorldbookEntry,
  fetchWorldbook,
  updateWorldbookEntry,
} from '../api/client'

// 编辑/新建时的表单态（id 为空 = 新建）
type Draft = {
  id: string
  title: string
  keywords: string
  content: string
  enabled: boolean
  priority: number
}

const EMPTY: Draft = { id: '', title: '', keywords: '', content: '', enabled: true, priority: 0 }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-0.5 block">{label}</span>
      {children}
    </label>
  )
}

export default function WorldbookPanel() {
  const [entries, setEntries] = useState<WorldbookEntry[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      setEntries(await fetchWorldbook())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const submit = useCallback(async () => {
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      if (draft.id) {
        const full = entries.find((e) => e.id === draft.id)
        if (!full) throw new Error('词条不存在')
        await updateWorldbookEntry({
          ...full,
          title: draft.title,
          keywords: draft.keywords,
          content: draft.content,
          enabled: draft.enabled,
          priority: draft.priority,
        })
      } else {
        await createWorldbookEntry({
          title: draft.title,
          keywords: draft.keywords,
          content: draft.content,
          enabled: draft.enabled,
          priority: draft.priority,
        })
      }
      setDraft(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [draft, entries, reload])

  const toggleEnabled = useCallback(
    async (e: WorldbookEntry) => {
      setError('')
      try {
        await updateWorldbookEntry({ ...e, enabled: !e.enabled })
        await reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [reload],
  )

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm('删除这个词条？')) return
      setError('')
      try {
        await deleteWorldbookEntry(id)
        if (draft?.id === id) setDraft(null)
        await reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [draft, reload],
  )

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[20px] font-extrabold tracking-wide">世界书</h2>
        <span className="text-[13px] text-[var(--text-3)]">World Info · 关键词触发的设定集</span>
      </div>

      <p className="mb-4 rounded-[14px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-2.5 text-[13px] text-[var(--text-2)]">
        世界书 = 你预先写好的静态设定。聊天最近几轮里出现「关键词」里任意一个词，就会把这条设定临时注入
        给模型（不会常驻，只在相关时出现）。用纯文本关键词，逗号分隔即可；优先数越大越靠前注入。
      </p>

      {error && <p className="mb-3 text-[13px] text-[var(--pink-deep)]">⚠ {error}</p>}

      <div className="flex justify-end">
        <button className="btn sm mb-3" onClick={() => setDraft({ ...EMPTY })}>
          ＋ 新增词条
        </button>
      </div>

      <div className="space-y-3">
        {entries.map((e) => (
          <div
            key={e.id}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]"
          >
            <div className="flex items-center gap-3">
              <button
                onClick={() => toggleEnabled(e)}
                className={`btn sm ${e.enabled ? '' : 'ghost'}`}
                title={e.enabled ? '点击停用' : '点击启用'}
              >
                {e.enabled ? '启用中' : '已停用'}
              </button>
              <span className="min-w-0 flex-1 text-[15px] font-semibold">{e.title}</span>
              <span className="text-[12px] text-[var(--text-3)]">优先 {e.priority}</span>
              <button className="btn ghost sm" onClick={() => setDraft({ ...e, id: e.id })}>
                ✎ 编辑
              </button>
              <button className="btn ghost sm" onClick={() => remove(e.id)}>
                🗑
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {keywordList(e).map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--text-2)]">
              {e.content}
            </p>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-[13px] text-[var(--text-3)]">还没有词条，点右上角「新增词条」创建一条。</p>
        )}
      </div>

      {draft && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
          <div className="my-4 w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[17px] font-bold">{draft.id ? '编辑词条' : '新增词条'}</h3>
              <button
                onClick={() => setDraft(null)}
                className="rounded-lg px-2.5 py-1 text-[var(--text-3)] hover:bg-[var(--surface-2)]"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3">
              <Field label="标题">
                <input
                  className="input"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="如：怕黑设定"
                />
              </Field>
              <Field label="关键词（逗号分隔，命中即触发）">
                <input
                  className="input"
                  value={draft.keywords}
                  onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
                  placeholder="停电, 打雷, 熄灯, 怕黑"
                />
              </Field>
              <Field label="正文（被注入的内容）">
                <textarea
                  className="textarea"
                  rows={4}
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  placeholder="大诗音其实很怕黑，一停电或打雷就会不自觉地靠过来…"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="优先级（越大越靠前）">
                  <input
                    className="input"
                    type="number"
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 0 })}
                  />
                </Field>
                <label className="flex items-end gap-2 pb-2 text-[14px] text-[var(--text-2)]">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  />
                  启用此词条
                </label>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2.5">
              <button className="btn ghost sm" onClick={() => setDraft(null)}>
                取消
              </button>
              <button className="btn sm" onClick={submit} disabled={busy || !draft.title.trim()}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}