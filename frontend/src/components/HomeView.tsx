import { useEffect, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import { SELF_CHARACTER_ID } from '../data/chats'
import CharacterProfileCard from './CharacterProfileCard'
import GalleryGrid from './GalleryGrid'
import CharacterEditor from './CharacterEditor'
import WorldbookPanel from './WorldbookPanel'
import JailbreakPanel from './JailbreakPanel'
import Avatar from './Avatar'

type Props = {
  characters: CharacterProfile[]
  initialCharId?: string
  /** 私人空间（§21）：只显示大老大一个人的介绍 / 词条 / 画廊，隐藏成员切换行。 */
  space?: boolean
  onSaveChar: (next: CharacterProfile) => void
  onEnterChat: (sessionId?: string) => void
  /** 跳到「糖人小窝」（§9.6）：成员切换行最左边那个入口。 */
  onOpenNest: () => void
}

export default function HomeView({ characters, initialCharId, space, onSaveChar, onEnterChat, onOpenNest }: Props) {
  // 私人空间（§21）：只认大老大自己；普通介绍页维持原样（全部成员）。
  // 大老大的档案在后端是「逐条幂等补种」的（§8.5），老库启动后必然在场；真缺了也不崩 ——
  // list 为空 → active 为空 → 下面整块不渲染，不会白屏。
  const list = space ? characters.filter((c) => c.id === SELF_CHARACTER_ID) : characters
  const [activeId, setActiveId] = useState(initialCharId ?? list[0]?.id)
  const [editing, setEditing] = useState<CharacterProfile | null>(null)
  // 看立绘原图（§19.13）：介绍页自己的浮层，跟画廊那个同款。Esc 也能关。
  const [lightbox, setLightbox] = useState<string | null>(null)

  const active = list.find((c) => c.id === activeId) ?? list[0]

  // 从别处跳进来点「看介绍」时要真的切过去（§19.20）。
  // 以前 activeId 是 useState 的初值，只在**首次挂载**生效：在聊天页点完第一位的头像，
  // 再点别人的头像，view 已经等于 home、HomeView 没被重新挂载，initialCharId 变了也不理会 ——
  // 用户看到的就是「点了没反应」。
  useEffect(() => {
    if (initialCharId) setActiveId(initialCharId)
  }, [initialCharId])

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  return (
    <main className="mx-auto max-w-6xl overflow-y-auto px-4 pb-16 pt-5">
      <p className="mb-4 rounded-[14px] border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] px-4 py-2.5 text-[13px] text-[var(--text-2)]">
        {space ? (
          <>
            这是<b className="text-[var(--pink-deep)]">你的</b>私人空间 —— 档案、词条、画廊都只属于你。
            词条均可点 <b className="text-[var(--pink-deep)]">✎ 编辑资料</b> 随时修改。
          </>
        ) : (
          <>
            点击成员切换角色；词条（含「关于」提示词）均可点{' '}
            <b className="text-[var(--pink-deep)]">✎ 编辑资料</b> 随时修改。
          </>
        )}
      </p>

      {/* 普通介绍页才有「家成员切换行」；私人空间只属于你自己，不给切换（§21） */}
      {!space && (
        <div className="mb-6 flex flex-wrap gap-3">
          <button
            className="member"
            onClick={onOpenNest}
            title="糖人小窝：全家的共同回忆（共用画廊）+ 以后的小游戏 / 互动小家"
          >
            <span className="ear">🏠</span>
            糖人小窝
          </button>
          {characters.map((c) => (
            <button key={c.id} className={`member ${c.id === active.id ? 'on' : ''}`} onClick={() => setActiveId(c.id)}>
              <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={30} className="ear" />
              {c.name}
            </button>
          ))}
        </div>
      )}

      {active && (
        <CharacterProfileCard
          key={active.id}
          p={active}
          onEdit={() => setEditing(active)}
          onEnterChat={() => onEnterChat(`single-${active.id}`)}
          onSwitchForm={(formId) => onSaveChar({ ...active, activeFormId: formId })}
          onOpenPortrait={setLightbox}
        />
      )}

      {/* 这位角色的专属画廊（§9.4 归属）；家共用的那部分在「糖人小窝」 */}
      <GalleryGrid owner={active?.id} />

      <WorldbookPanel owner={active?.id ?? ''} ownerLabel={`${active?.name ?? '家'}的世界书`} />

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

      {/* 立绘原图浮层（§19.13）：点介绍页左侧立绘看高清大图 */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="立绘原图" className="max-h-[88vh] max-w-[88vw] rounded-xl shadow-2xl" />
        </div>
      )}
    </main>
  )
}