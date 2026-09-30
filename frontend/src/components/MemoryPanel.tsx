// 记忆管理浮层（《项目要求》§9.2 三层 RAG / §9.3 手动+自动记忆）。
// 三层里的前两层在这里可看可管：家记忆（共享）与个人记忆（按角色，天然私密）；
// 第三层「会话上下文」是最近几轮，不进库，所以不在此处显示。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import {
  deleteMemory,
  fetchMemories,
  fetchMemoryStatus,
  reindexMemories,
  rememberMemory,
  type MemoryItem,
  type MemoryStatus,
} from '../api/memory'

type Props = {
  characters: CharacterProfile[]
  // 当前会话上下文：用于「留空=自动打标」的默认值（§9.2.2）
  sessionKind: 'group' | 'single'
  characterIds: string[]
  onClose: () => void
}

export default function MemoryPanel({ characters, sessionKind, characterIds, onClose }: Props) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 新增表单
  const [text, setText] = useState('')
  const [bucket, setBucket] = useState<'auto' | 'home' | 'personal'>('auto')
  const [charId, setCharId] = useState(characterIds[0] ?? characters[0]?.id ?? '')

  const nameOf = useMemo(() => {
    const m: Record<string, string> = {}
    characters.forEach((c) => (m[c.id] = c.name))
    return m
  }, [characters])

  const reload = useCallback(async () => {
    setLoading(true)
    const [list, st] = await Promise.all([fetchMemories(), fetchMemoryStatus()])
    setItems(list)
    setStatus(st)
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Esc 关闭（与其它浮层一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 自动打标时，预览这条会落到哪个桶（跟前端显示一致，避免用户猜）
  const autoTarget = useMemo(() => {
    if (sessionKind === 'single' && characterIds.length === 1) {
      return { bucket: 'personal' as const, char_id: characterIds[0] }
    }
    return { bucket: 'home' as const, char_id: '' }
  }, [sessionKind, characterIds])

  const target =
    bucket === 'auto'
      ? autoTarget
      : bucket === 'personal'
        ? { bucket: 'personal' as const, char_id: charId }
        : { bucket: 'home' as const, char_id: '' }

  const homeItems = items.filter((m) => m.bucket === 'home')
  const personalByChar = useMemo(() => {
    const groups: Record<string, MemoryItem[]> = {}
    items
      .filter((m) => m.bucket === 'personal')
      .forEach((m) => (groups[m.char_id] ||= []).push(m))
    return groups
  }, [items])

  async function submit() {
    const t = text.trim()
    if (!t || busy) return
    if (target.bucket === 'personal' && !target.char_id) {
      setError('个人记忆必须选一位角色')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await rememberMemory({
        text: t,
        bucket: target.bucket,
        char_id: target.char_id,
      })
      setText('')
      setNotice('记住了 ✓')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      await deleteMemory(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function reindex() {
    setBusy(true)
    setNotice('')
    setError('')
    try {
      const r = await reindexMemories()
      setNotice(`重建完成：${r.done}/${r.total}${r.failed ? `，失败 ${r.failed}` : ''}`)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mt-6 w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[15px] font-semibold text-[var(--text)]">记忆</span>
          <span className="text-[11px] text-[var(--text-3)]">三层中的长期两层 · 会话上下文不进库</span>
          <button onClick={onClose} className="ml-auto text-[var(--text-3)] hover:text-[var(--text)]">
            ✕
          </button>
        </div>

        {/* embedding 状态：模型没装好 / 换了引擎没重建索引，都在这提示 */}
        {status && (
          <div
            className={`mb-3 rounded-xl border px-3 py-2 text-[12px] leading-snug ${
              !status.available || status.stale_vectors > 0
                ? 'border-[color-mix(in_srgb,var(--pink)_45%,var(--border))] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span>{status.available ? '🧠' : '⚠'}</span>
              <span className="min-w-0 flex-1">
                向量引擎：{status.engine}（{status.signature}
                {status.dim ? ` · ${status.dim} 维` : ''}）
                {status.available ? '' : ' · 不可用'}
                {status.stale_vectors > 0 && ` · ${status.stale_vectors} 条待重建`}
              </span>
              {status.stale_vectors > 0 && (
                <button className="btn ghost sm shrink-0" disabled={busy} onClick={() => void reindex()}>
                  重建索引
                </button>
              )}
            </div>
            {!status.available && (
              <p className="mt-1 text-[var(--text-3)]">
                本地模型没就绪时，记忆照样能存、能看，检索会退化成关键词匹配。装法见仓库根目录
                download_embedding.sh。{status.detail ? `（${status.detail}）` : ''}
              </p>
            )}
          </div>
        )}

        {/* 新增一条 */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <textarea
            className="input min-h-[64px] w-full resize-y"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="想让她（们）记住的事，例如：大诗音怕打雷，这是她的秘密"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-[var(--border-strong)]">
              {(
                [
                  ['auto', '自动打标'],
                  ['home', '家记忆'],
                  ['personal', '个人记忆'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setBucket(k)}
                  className={`px-2.5 py-1 text-[12px] transition ${
                    bucket === k
                      ? 'bg-[var(--pink)] text-white'
                      : 'bg-[var(--surface)] text-[var(--text-2)] hover:text-[var(--pink-deep)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {bucket === 'personal' && (
              <select
                className="input w-auto py-1 text-[12px]"
                value={charId}
                onChange={(e) => setCharId(e.target.value)}
              >
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.name}
                  </option>
                ))}
              </select>
            )}
            <span className="text-[11px] text-[var(--text-3)]">
              → 存进
              {target.bucket === 'home' ? '家记忆（大家共享）' : `${nameOf[target.char_id] ?? target.char_id} 的个人记忆（只有她知道）`}
            </span>
            <button className="btn sm ml-auto" disabled={busy || !text.trim()} onClick={() => void submit()}>
              {busy ? '处理中…' : '记住这条'}
            </button>
          </div>
          {(error || notice) && (
            <div className={`mt-1.5 text-[12px] ${error ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'}`}>
              {error || notice}
            </div>
          )}
        </div>

        {/* 列表：家记忆 + 按角色分组的个人记忆 */}
        <div className="mt-3 max-h-[42vh] overflow-y-auto pr-1">
          {loading ? (
            <div className="py-6 text-center text-[12px] text-[var(--text-3)]">读取中…</div>
          ) : items.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-[var(--text-3)]">还没有记忆，上面写一条试试</div>
          ) : (
            <>
              <MemoryGroup
                title="🏠 家记忆（在场者都知道）"
                items={homeItems}
                onDelete={busy ? undefined : remove}
              />
              {characters
                .filter((c) => personalByChar[c.id]?.length)
                .map((c) => (
                  <MemoryGroup
                    key={c.id}
                    title={`${c.emoji} ${c.name} 的个人记忆（只有她知道）`}
                    items={personalByChar[c.id]}
                    onDelete={busy ? undefined : remove}
                  />
                ))}
              {/* 兜底：角色被删了但记忆还在 */}
              {Object.keys(personalByChar)
                .filter((cid) => !characters.some((c) => c.id === cid))
                .map((cid) => (
                  <MemoryGroup
                    key={cid}
                    title={`${cid} 的个人记忆`}
                    items={personalByChar[cid]}
                    onDelete={busy ? undefined : remove}
                  />
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function MemoryGroup({
  title,
  items,
  onDelete,
}: {
  title: string
  items: MemoryItem[]
  onDelete?: (id: string) => void | Promise<void>
}) {
  if (!items.length) return null
  return (
    <div className="mb-3">
      <div className="mb-1.5 text-[12px] font-semibold text-[var(--text-2)]">{title}</div>
      {items.map((m) => (
        <div
          key={m.id}
          className="group mb-1.5 flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] text-[var(--text)]">{m.text}</span>
          {m.source === 'auto' && (
            <span className="shrink-0 rounded-full bg-[var(--pink-soft)] px-1.5 py-0.5 text-[10px] text-[var(--pink-deep)]">
              自动
            </span>
          )}
          <button
            className="shrink-0 text-[11px] text-[var(--text-3)] opacity-0 transition hover:text-[var(--pink-deep)] group-hover:opacity-100"
            onClick={() => onDelete?.(m.id)}
            title="删掉这条记忆"
          >
            删除
          </button>
        </div>
      ))}
    </div>
  )
}