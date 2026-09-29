import { useRef } from 'react'
import type { ChatSession } from '../data/chats'

type Props = {
  sessions: ChatSession[]
  activeId: string
  onSelect: (id: string) => void
  onImport: (name: string) => void
}

export default function SessionList({ sessions, activeId, onSelect, onImport }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)

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
            <span className="session-emoji">{s.emoji}</span>
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