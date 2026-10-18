/** 这个身份的记忆（§22.4）：私人空间「我的档案」下方那一段。
 *
 * 两个来源并排：长期记忆（03 记忆池，日常聊天 / QQ 里攒下的）和个人数据库 03 里
 * 已批准的真实信息。每个身份各挑各的 —— 大老大挑中的，汐子不会跟着看到。
 *
 * 开关立即生效，没有「保存」按钮：聊天 / QQ 下一轮组装 prompt 时直接读这张表。
 * **不兜底**：没挑中的一条都不带，宁可暂时想不起来，也不要两个身份记忆打架。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  clearPersonaPick,
  fetchPersonaPicks,
  setPersonaPick,
  type PersonaDbItem,
  type PersonaMemoryItem,
  type PersonaPicks,
} from '../api/client'
import { deleteMemory } from '../api/memory'

type Props = {
  personaId: string
  personaName?: string
  /** 从聊天页「🧠 记忆」跳过来时高亮一下，提示这是刚跳到的地方。 */
  highlight?: boolean
}

type Kind = 'memory' | 'db'

const BUCKET_LABEL: Record<string, string> = { home: '家记忆', personal: '个人记忆' }

/** 本地时间字符串 → 'YYYY/MM/DD HH:MM:SS'，精确到秒；缺哪段就显示到哪段，解析不了就原样显示。 */
function stampOf(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw || '')
  if (!m) return raw || ''
  const out = `${m[1]}/${m[2]}/${m[3]}`
  if (!m[4]) return out
  return `${out} ${m[4]}:${m[5]}${m[6] ? ':' + m[6] : ''}`
}

export default function PersonaMemorySection({ personaId, personaName, highlight }: Props) {
  const [data, setData] = useState<PersonaPicks | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const [query, setQuery] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setData(await fetchPersonaPicks(personaId))
    } catch (e) {
      setErr('加载失败：' + String(e))
    } finally {
      setLoading(false)
    }
  }, [personaId])

  useEffect(() => {
    setData(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!highlight) return
    const el = document.getElementById('persona-memory')
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [highlight, data])

  // 乐观更新：下拉框按下去就翻转，请求失败再翻回来
  const flip = async (kind: Kind, refId: string, next: boolean, apply: (d: PersonaPicks) => PersonaPicks) => {
    setData((d) => (d ? apply(d) : d))
    const key = `${kind}:${refId}`
    setBusyKey(key)
    try {
      await setPersonaPick(personaId, kind, refId, next)
    } catch (e) {
      setErr('没改成：' + String(e))
      await load()
    } finally {
      setBusyKey('')
    }
  }

  const toggleMemory = (m: PersonaMemoryItem) =>
    flip('memory', m.id, !m.enabled, (d) => ({
      ...d,
      memories: d.memories.map((x) => (x.id === m.id ? { ...x, picked: true, enabled: !m.enabled } : x)),
    }))

  const toggleDb = (item: PersonaDbItem) =>
    flip('db', item.ref_id, !item.enabled, (d) => ({
      ...d,
      database: d.database.map((x) => (x.ref_id === item.ref_id ? { ...x, picked: true, enabled: !item.enabled } : x)),
    }))

  const unpick = async (kind: Kind, refId: string) => {
    setBusyKey(`${kind}:${refId}`)
    try {
      await clearPersonaPick(personaId, kind, refId)
      await load()
    } catch (e) {
      setErr('取消失败：' + String(e))
    } finally {
      setBusyKey('')
    }
  }

  // 删除是连库一起删（不只是取消挑选），所以先问一句
  const remove = async (m: PersonaMemoryItem) => {
    if (!window.confirm(`删掉这条记忆？\n\n${m.text}\n\n删了就找不回来了。`)) return
    setBusyKey(`memory:${m.id}`)
    try {
      await deleteMemory(m.id)
      await load()
    } catch (e) {
      setErr('删除失败：' + String(e))
    } finally {
      setBusyKey('')
    }
  }

  const q = query.trim().toLowerCase()
  const hit = (text: string) => !q || text.toLowerCase().includes(q)
  const memories = (data?.memories ?? []).filter((m) => hit(m.text))
  const dbItems = (data?.database ?? []).filter((d) => hit(d.title + '\n' + d.content))

  const onCount = (data?.memories.filter((m) => m.enabled).length ?? 0)
    + (data?.database.filter((d) => d.enabled).length ?? 0)

  return (
    <section className="self-profile-panel persona-memory-panel" id="persona-memory">
      <div className="panel-header">
        <span className="eyebrow">🧠 {personaName ? `${personaName}的记忆` : '这个身份的记忆'}</span>
        <div className="flex items-center gap-2">
          <span className="persona-memory-count">{onCount} 条进入对话</span>
          <button className="btn sm ghost" onClick={() => void load()} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      <p className="persona-memory-hint">
        这里挑的是「<b>{personaName || '这个身份'}</b>」和她们说话时会记得的事。没打开的一条都不会带进对话 ——
        别的身份挑了的也不会串过来。
      </p>

      {err && <p className="err-tip">{err}</p>}

      <div className="db-toolbar">
        <input
          className="input"
          placeholder="搜一搜记忆 / 现实信息…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="panel-body persona-memory-body">
        {/* 左：长期记忆 03 */}
        <div className="block-list persona-memory-list">
          <div className="persona-memory-list-title">💭 长期记忆 · 03 记忆池</div>
          {!loading && memories.length === 0 && <p className="empty-tip">没有可挑的记忆。</p>}
          {memories.map((m) => (
            <div key={m.id} className={`block-item persona-memory-item ${m.enabled ? 'on' : ''}`}>
              <div className="persona-memory-text">
                <span>{m.text}</span>
                <span className="persona-memory-meta">
                  {stampOf(m.created_at)} · {BUCKET_LABEL[m.bucket] ?? m.bucket}
                  {m.picked && !m.enabled && ' · 已关'}
                </span>
              </div>
              <div className="persona-memory-actions">
                <button
                  className="del-btn persona-memory-del"
                  title="删掉这条记忆（连库一起删，不可恢复）"
                  onClick={() => void remove(m)}
                  disabled={busyKey === `memory:${m.id}`}
                >
                  🗑
                </button>
                {m.picked && (
                  <button
                    className="del-btn"
                    title="取消挑选（回到没挑中）"
                    onClick={() => void unpick('memory', m.id)}
                    disabled={busyKey === `memory:${m.id}`}
                  >
                    ×
                  </button>
                )}
                <label className="switch" title={m.enabled ? '关掉：这条不进对话' : '打开：这条进对话'}>
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    disabled={busyKey === `memory:${m.id}`}
                    onChange={() => void toggleMemory(m)}
                  />
                  <span className="switch-knob" />
                </label>
              </div>
            </div>
          ))}
        </div>

        {/* 右：个人数据库 03 真实信息 */}
        <div className="block-list persona-memory-list">
          <div className="persona-memory-list-title">📁 个人数据库 · 03 真实信息</div>
          {!loading && dbItems.length === 0 && (
            <p className="empty-tip">个人数据库 03 里还没有已批准的条目。</p>
          )}
          {dbItems.map((d) => (
            <div key={d.ref_id} className={`block-item persona-memory-item ${d.enabled ? 'on' : ''}`}>
              <div className="persona-memory-text">
                <span className="persona-memory-db-title">{d.title}</span>
                <span className="persona-memory-db-body">{d.content}</span>
                <span className="persona-memory-meta">
                  {stampOf(d.created_at) || d.ref_id}
                  {d.picked && !d.enabled && ' · 已关'}
                </span>
              </div>
              <div className="persona-memory-actions">
                {d.picked && (
                  <button
                    className="del-btn"
                    title="取消挑选（回到没挑中）"
                    onClick={() => void unpick('db', d.ref_id)}
                    disabled={busyKey === `db:${d.ref_id}`}
                  >
                    ×
                  </button>
                )}
                <label className="switch" title={d.enabled ? '关掉：这条不进对话' : '打开：这条进对话'}>
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    disabled={busyKey === `db:${d.ref_id}`}
                    onChange={() => void toggleDb(d)}
                  />
                  <span className="switch-knob" />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
