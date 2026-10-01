import { useRef } from 'react'
import type { ChatSession } from '../data/chats'
import type { CharacterProfile } from '../data/characters'
import Avatar from './Avatar'

type Props = {
  sessions: ChatSession[]
  activeId: string
  onSelect: (id: string) => void
  onImport: (name: string) => void
  /** 角色列表：单聊会话按 characterIds[0] 反查头像（未传则退回 emoji）。 */
  characters?: CharacterProfile[]
}

export default function SessionList({ sessions, activeId, onSelect, onImport, characters = [] }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)

  // 单聊用对方头像（QQ 式）；群聊 / 导入会话没有单一角色，保留 emoji 图标。
  const faceOf = (s: ChatSession) => {
    if (s.kind !== 'single') return null
    const c = characters.find((x) => x.id === s.characterIds[0])
    if (!c) return null
    return <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={34} />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-3 text-[12px] font-semibold tracking-wide text-[var(--text-3)]">最近聊天</div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`session-item ${s.id === activeId ? 'on' : ''}`}
          >
            {faceOf(s) ?? <span className="session-emoji">{s.emoji}</span>}
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[14px] font-medium text-[var(--text)]">{s.name}</span>
              <span className="block truncate text-[12px] text-[var(--text-3)]">{s.subtitle}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="border-t border-[var(--border)] p-2">
        <button className="session-item w-full" onClick={() => fileRef.current?.click()} title="导入酒馆角色卡（阶段 2 解析人设，先占位）">
          <span className="session-emoji">🎴</span>
          <span className="text-[13px] text-[var(--text-2)]">导入角色卡（酒馆）</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onImport(f.name.replace(/\.[^.]+$/, ''))
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}