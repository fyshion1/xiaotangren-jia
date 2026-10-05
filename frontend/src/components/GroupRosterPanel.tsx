/** 群聊阵容面板（§25）：改「谁在群里、谁先退场」。
 *
 * 存后端 settings 的 `group_roster`（角色 id 的 JSON 数组）—— 不新建表、不新建端点。
 * 只改默认群聊的成员；私聊一条不少（「不在场」是暂时不让她插话，不是把人删掉）。
 *
 * 至少留 1 人：空阵容会被后端当成「没设置」回退成全员在场，反而更糟，所以这里拦住。
 *
 * 与项目其他浮层同款：Esc / 点外面关闭、Nekopara 配色、内容区自己滚。
 */

import { useEffect, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import Avatar from './Avatar'

type Props = {
  open: boolean
  onClose: () => void
  /** 可出场的全部角色（已排除「用户自己的身份」，由调用方过滤好）。 */
  castable: CharacterProfile[]
  /** 当前阵容（角色 id）；空 = 全员在场。 */
  roster: string[]
  /** 保存并写回后端。抛错 = 保存失败，面板留在原地并提示。 */
  onSave: (ids: string[]) => Promise<void>
}

export default function GroupRosterPanel({ open, onClose, castable, roster, onSave }: Props) {
  const [sel, setSel] = useState<string[]>(roster)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // 每次打开都从「当前阵容」重新起算 —— 上次点了没保存的改动不该留到下一次。
  useEffect(() => {
    if (open) {
      setSel(roster.length > 0 ? roster : castable.map((c) => c.id))
      setErr('')
    }
    // roster / castable 每次渲染都是新数组，直接进依赖会每帧重跑 —— 用长度与内容签名代替
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // 只认场上的角色顺序，免得保存出一个和角色列表顺序不一致的数组
  const ids = castable.map((c) => c.id).filter((id) => sel.includes(id))
  const toggle = (id: string) =>
    setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const save = async () => {
    if (ids.length === 0) {
      setErr('至少留 1 位 —— 空阵容会被当成「全员在场」，反而更糟。')
      return
    }
    setSaving(true)
    setErr('')
    try {
      await onSave(ids)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
          <span className="text-[15px] font-semibold text-[var(--text)]">👥 群聊成员</span>
          <span className="text-[11px] text-[var(--text-3)]">谁在「小糖人的家」里</span>
          <button onClick={onClose} className="ml-auto text-[var(--text-3)] hover:text-[var(--text)]">
            ✕
          </button>
        </header>

        <div className="border-b border-[var(--border)] px-4 py-2 text-[11px] leading-snug text-[var(--text-3)]">
          勾掉的只是<b>这个群里先不说话</b> —— 私聊照旧，记忆、世界书、人设都还在。
          勾回来就照常。改动立刻生效，刷新页面也保持。
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="space-y-1.5">
            {castable.map((c) => {
              const on = sel.includes(c.id)
              return (
                <label
                  key={c.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition ${
                    on
                      ? 'border-[var(--pink)] bg-[var(--pink-soft)]'
                      : 'border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
                  <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={30} className="bg-white" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--text)]">{c.name}</span>
                    <span className="block truncate text-[11px] text-[var(--text-3)]">
                      {c.alias || '小糖人'}
                    </span>
                  </span>
                  <span className={`text-[11px] ${on ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'}`}>
                    {on ? '在场' : '不在'}
                  </span>
                </label>
              )
            })}
          </div>
          {castable.length === 0 && (
            <p className="py-8 text-center text-[12px] text-[var(--text-3)]">还没有可以出场的角色。</p>
          )}
        </div>

        {err && <p className="px-4 pb-1 text-[12px] text-[var(--pink-deep)]">{err}</p>}

        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
          <button
            className="btn ghost sm"
            onClick={() => setSel(castable.map((c) => c.id))}
            title="全员都回到群里"
          >
            全选（{castable.length}）
          </button>
          <button
            className="btn ghost sm"
            onClick={() => (castable.length > 0 ? setSel([castable[0].id]) : undefined)}
            title="只留列表里第一位（其余先退场）"
          >
            只留一位
          </button>
          <span className="ml-auto text-[11px] text-[var(--text-3)]">已选 {ids.length} 位</span>
          <button className="btn sm" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}
