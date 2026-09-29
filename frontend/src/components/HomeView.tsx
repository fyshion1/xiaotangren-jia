import { useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import CharacterProfileCard from './CharacterProfileCard'
import GalleryGrid from './GalleryGrid'
import CharacterEditor from './CharacterEditor'
import WorldbookPanel from './WorldbookPanel'
import JailbreakPanel from './JailbreakPanel'

type Props = {
  characters: CharacterProfile[]
  initialCharId?: string
  onSaveChar: (next: CharacterProfile) => void
  onEnterChat: (sessionId?: string) => void
}

export default function HomeView({ characters, initialCharId, onSaveChar, onEnterChat }: Props) {
  const [activeId, setActiveId] = useState(initialCharId ?? characters[0]?.id)
  const [editing, setEditing] = useState<CharacterProfile | null>(null)

  const active = characters.find((c) => c.id === activeId) ?? characters[0]

  return (
    <main className="mx-auto max-w-6xl overflow-y-auto px-4 pb-16 pt-5">
      <p className="mb-4 rounded-[14px] border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] px-4 py-2.5 text-[13px] text-[var(--text-2)]">
        点击成员切换角色；词条（含「关于」提示词）均可点 <b className="text-[var(--pink-deep)]">✎ 编辑资料</b> 随时修改。
      </p>

      {/* 家成员切换 */}
      <div className="mb-6 flex flex-wrap gap-3">
        {characters.map((c) => (
          <button key={c.id} className={`member ${c.id === active.id ? 'on' : ''}`} onClick={() => setActiveId(c.id)}>
            <span className="ear">{c.emoji}</span>
            {c.name}
          </button>
        ))}
      </div>

      {active && (
        <CharacterProfileCard
          key={active.id}
          p={active}
          onEdit={() => setEditing(active)}
          onEnterChat={() => onEnterChat(`single-${active.id}`)}
        />
      )}

      <GalleryGrid />

      <WorldbookPanel />

      <JailbreakPanel />

      {editing && (
        <CharacterEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onSaveChar(next)
            setEditing(null)
          }}
        />
      )}
    </main>
  )
}