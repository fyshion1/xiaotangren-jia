import {emptyProfile} from '../lib/emptyProfile'
import { useTavernMode } from '../lib/tavernMode'
import CharacterStage from '../visual/CharacterStage'
import { useEffect, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import { MAIN_PERSONA_ID } from '../data/chats'
import { findGalleryByOrig, type GalleryItem } from '../api/gallery'
import { isUncensoredChannel, visionRoute } from '../lib/visionRoute'
import CharacterProfileCard from './CharacterProfileCard'
import GalleryGrid from './GalleryGrid'
import GalleryLightbox from './GalleryLightbox'
import CharacterEditor from './CharacterEditor'
import SelfProfilePanel from './SelfProfilePanel'
import PersonaMemorySection from './PersonaMemorySection'
import PersonalDatabasePanel from './PersonalDatabasePanel'
import WorldbookPanel from './WorldbookPanel'
import JailbreakPanel from './JailbreakPanel'
import Avatar from './Avatar'

type Props = {
  onCreateCharacter?:()=>void
  characters: CharacterProfile[]
  initialCharId?: string
  /** 私人空间（§22）：characters 换成「你的身份档案列表」，多出一排身份卡片。 */
  space?: boolean
  /** 当前正在用的身份（只有私人空间有）。 */
  activePersonaId?: string
  onSaveChar: (next: CharacterProfile) => void | Promise<void>
  onEnterChat: (sessionId?: string) => void
  /** 从聊天页「🧠 记忆」跳过来（§22.4）：滚到「这个身份的记忆」并高亮。 */
  focusMemory?: number
  /** 跳到「糖人小窝」（§9.6）：成员切换行最左边那个入口。 */
  onOpenNest: () => void
  // ---- 以下仅私人空间用（§22）----
  /** 新建一份身份档案（差量草稿，id 由后端生成）。 */
  onCreateProfile?: (draft: Omit<CharacterProfile, 'id'> & { id?: string }) => Promise<CharacterProfile>
  /** 「成为这个身份」：全局一处切换，聊天记录各自一条。 */
  onBecomePersona?: (personaId: string) => void | Promise<void>
  onDeletePersona?: (personaId: string) => void | Promise<void>
  /**
   * 删掉一张**导入的**角色卡（只有导入的卡能删，自家四位是种子数据）。
   * 与最近对话里那个 🗑 是同一个动作 —— 两处都能删，确认框与清理由上面统一做。
   */
  onDeleteImportedCard?: (c: CharacterProfile) => void | Promise<void>
}



export default function HomeView({
  characters,
  initialCharId,
  space,
  activePersonaId,
  onSaveChar,
  onEnterChat,
  focusMemory,
  onCreateProfile,
  onBecomePersona,
  onDeletePersona,
  onDeleteImportedCard,
  onCreateCharacter,
}: Props) {
  // 私人空间（§22）：characters 传进来的就是身份档案列表，active 跟着「当前身份」走。
  // 列表为空时（后端不可用）下面整块不渲染，不会白屏。
  const [tavernMode] = useTavernMode()
  const [showHidden, setShowHidden] = useState(false)
  const [saveError, setSaveError] = useState('')
  // The recovery toggle includes both manual hiding and tavern-mode hiding.
  const list = space ? characters : characters.filter(c => showHidden || (!c.hiddenInProfiles && (tavernMode || !c.imported)))
  const [activeId, setActiveId] = useState(initialCharId ?? list[0]?.id)
  const [editing, setEditing] = useState<CharacterProfile | null>(null)
  // 看立绘原图（§19.13）：介绍页自己的浮层，跟画廊那个同款。Esc 也能关。
  // 若这张立绘也收进了画廊（§9.4），浮层就升级成完整画廊浮层 —— 直接能写描述 / 改归属 /
  // 切私密，不用再跑去聊天的 🖼 画廊里翻。
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [galleryHit, setGalleryHit] = useState<GalleryItem | null>(null)

  // 自动描述 / 越狱判定用的 vision 上游（与聊天页共用同一份本地配置，§7）。
  const route = visionRoute()
  const uncensored = isUncensoredChannel()

  const active = list.find((c) => c.id === activeId) ?? list[0]

  // 从别处跳进来点「看介绍」时要真的切过去（§19.20）。
  // 以前 activeId 是 useState 的初值，只在**首次挂载**生效：在聊天页点完第一位的头像，
  // 再点别人的头像，view 已经等于 home、HomeView 没被重新挂载，initialCharId 变了也不理会 ——
  // 用户看到的就是「点了没反应」。
  useEffect(() => {
    if (initialCharId) setActiveId(initialCharId)
  }, [initialCharId])

  // 私人空间：当前身份变了就跟着切（从别处「成为」了别的身份 / 删掉当前身份回落）。
  useEffect(() => {
    if (space && activePersonaId) setActiveId(activePersonaId)
  }, [space, activePersonaId])

  useEffect(() => {
    // 画廊浮层会用同一个 Esc 做「编辑中先退编辑、否则关闭」的分层处理，这里别抢它的键。
    if (!lightbox || galleryHit) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, galleryHit])

  // 点开立绘时顺便问一句「这张进画廊了吗」—— 收过就摊开画廊动作，没收录就只看大图。
  useEffect(() => {
    if (!lightbox) {
      setGalleryHit(null)
      return
    }
    let cancelled = false
    findGalleryByOrig(lightbox)
      .then((hit) => {
        if (!cancelled) setGalleryHit(hit)
      })
      .catch(() => {
        /* 后端没起 / 查询失败 → 退回「只看大图」，不挡看图 */
      })
    return () => {
      cancelled = true
    }
  }, [lightbox])

  const onCreate = () => {
    if (!onCreateProfile) return
    setSaveError('')
    setEditing({ ...emptyProfile(), id: '' })
  }

  const onDelete = async (p: CharacterProfile) => {
    if (!onDeletePersona) return
    const ok = window.confirm(
      `删掉「${p.name}」这份身份档案？\n\n它名下的聊天记录会一起清掉（每个身份各自一条）。\n其他角色的记忆、画廊、世界书不受影响。`,
    )
    if (!ok) return
    await onDeletePersona(p.id)
  }

  return (
    <main className={(space ? "visual-space" : "visual-character-home") + " mx-auto max-w-6xl overflow-y-auto px-4 pb-16 pt-5"}>
      <p className="mb-4 rounded-[14px] border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] px-4 py-2.5 text-[13px] text-[var(--text-2)]">
        {space ? (
          <>
            这是<b className="text-[var(--pink-deep)]">你的</b>私人空间 —— 你的几份身份档案都在这里。
            点卡片看档案，点 <b className="text-[var(--pink-deep)]">成为这个身份</b> 才会真的换视角
            （聊天记录各自一条）；词条均可点 <b className="text-[var(--pink-deep)]">✎ 编辑资料</b> 随时修改。
          </>
        ) : (
          <>
            点击成员切换角色；词条（含「关于」提示词）均可点{' '}
            <b className="text-[var(--pink-deep)]">✎ 编辑资料</b> 随时修改。
          </>
        )}
      </p>

      {/* 私人空间（§22）：一排身份卡片，点开看档案 + 单独一个「成为这个身份」按钮。 */}
      {space ? (
        <div className="mb-6 flex flex-wrap gap-3">
          {characters.map((p) => (
            <div key={p.id} className={`persona-card ${p.id === active?.id ? 'on' : ''}`}>
              <button className="flex min-w-0 flex-1 items-center gap-2" onClick={() => setActiveId(p.id)}>
                <Avatar name={p.name} avatar={p.avatar} emoji={p.emoji} size={30} className="ear" />
                <span className="truncate">{p.name}</span>
                {p.id === activePersonaId && <span className="persona-badge">当前</span>}
              </button>
              {/* 单独按钮：不点就不成为 —— 避免「只是想看看」也被换掉视角 */}
              <button
                className="persona-become"
                disabled={p.id === activePersonaId}
                title={p.id === activePersonaId ? '已经在用这个身份了' : `以「${p.name}」的身份聊天`}
                onClick={() => void onBecomePersona?.(p.id)}
              >
                {p.id === activePersonaId ? '使用中' : '成为'}
              </button>
            </div>
          ))}
          {onCreateProfile && (
            <button className="member" onClick={() => void onCreate()} title="添加一份新的身份档案">
              <span className="ear">＋</span>
              新身份
            </button>
          )}
        </div>
      ) : (
        <div className="mb-6 flex flex-wrap gap-3">
          <label className="member"><input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />显示已隐藏角色</label>
          {onCreateCharacter&&<button className="btn ghost sm" onClick={onCreateCharacter}>＋ 创建助手</button>}
          {list.map((c) => (
            <button key={c.id} className={`member ${c.id === active?.id ? 'on' : ''}`} onClick={() => setActiveId(c.id)}>
              <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={30} className="ear" />
              {c.name}
              {c.hiddenInProfiles && <span className="text-xs text-[var(--text-3)]">（已隐藏）</span>}
              {!c.hiddenInProfiles && c.imported && !tavernMode && <span className="text-xs text-[var(--text-3)]">（酒馆模式已关闭）</span>}
            </button>
          ))}
        </div>
      )}

      {!space && active && (showHidden || !active.hiddenInProfiles) && <CharacterStage p={active} onChat={active.imported && !tavernMode ? undefined : ()=>onEnterChat(`single-${active.id}`)}/>}
      {!space && active?.imported && !tavernMode && <p role="status" className="mb-4 text-sm text-[var(--text-2)]">此角色因酒馆模式关闭而隐藏。开启酒馆模式后可进入她的聊天。</p>}
      <details open className="visual-original-profile"><summary>{space?'身份档案':'完整档案与形态设置'}<span>展开查看 / 编辑</span></summary>
      {active && (
        <CharacterProfileCard
          key={active.id}
          p={active}
          onEdit={() => setEditing(active)}
          onEnterChat={space || (active.imported && !tavernMode) ? undefined : () => onEnterChat(`single-${active.id}`)}
          onSwitchForm={(formId) => onSaveChar({ ...active, activeFormId: formId })}
          onOpenPortrait={setLightbox}
          extra={
            space ? (
              <PersonaActions p={active} onDelete={onDeletePersona ? onDelete : undefined} />
            ) : active.characterPackId ? (
              <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
                <p className="text-xs text-[var(--text-3)]">来自角色包，档案与图片已归入用户数据。移除档案会保留图片、聊天和记忆。</p>
                <button className="self-start rounded border border-[var(--border)] px-3 py-2 text-sm" onClick={() => void onDeleteImportedCard?.(active)}>移除角色档案</button>
              </div>
            ) : active.imported ? (
              /* 导入的角色卡：家里四位是种子数据、删了会被补种回来，所以只有她能删。
                 删完 App 会把 characters 换掉，active 自动回落到列表第一位（见上面 active 的兜底）。 */
              <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
                <p className="text-[11px] leading-snug text-[var(--text-3)]">
                  ＊ 这张是从酒馆角色卡导入的（原文照搬，没做清洗）。不想留了就删掉 ——
                  连她单独聊的记录、你让她记住的事、导入时存下的立绘一起清。
                </p>
                <button
                  className="self-start rounded-xl border border-[var(--border-strong)] px-3 py-1.5 text-[13px] text-[#d9534f] transition-colors hover:bg-[#d9534f]/10"
                  onClick={() => void onDeleteImportedCard?.(active)}
                >
                  🗑 删掉这张角色卡
                </button>
              </div>
            ) : undefined
          }
        />
      )}
      </details>

      {/* 自我档案面板（§23）：私人空间里放在档案卡下方 */}
      {space && active && <SelfProfilePanel personaId={active.id} />}
      {space && active && <div className="personal-libraries">
        <PersonaMemorySection personaId={active.id} personaName={active.name} highlight={Boolean(focusMemory)} />
        <PersonalDatabasePanel personaId={active.id} />
      </div>}

      {/* 这位角色的专属画廊（§9.4 归属）；家共用的那部分在「糖人小窝」 */}
      {active && <GalleryGrid owner={active.id} />}

      {!space && tavernMode && active && <WorldbookPanel owner={active.id} ownerLabel={`${active.name}的世界书`} />}

      {tavernMode && <JailbreakPanel />}

      {saveError && <p role="alert">{saveError}</p>}
      {editing && (
        <CharacterEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            setSaveError('')
            try {
              if (space && !editing.id && onCreateProfile) {
                const name = next.name.trim()
                if (!name) throw new Error('请先填写身份名字')
                const created = await onCreateProfile({ ...next, name })
                setActiveId(created.id)
              } else {
                await onSaveChar(next)
              }
              setEditing(null)
            } catch (e) { setSaveError(String(e)); throw e }
          }}
        />
      )}

      {/* 立绘原图浮层（§19.13）：点介绍页左侧立绘看高清大图。
          这张立绘若也收进了画廊（§9.4），就直接用画廊浮层 —— 摊开整套画廊动作
          （自动描述 / 编辑 / 进小糖人记忆 / 🔒 私密 / 归属），省得再去聊天里翻。 */}
      {lightbox && !galleryHit && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="立绘原图" className="max-h-[88vh] max-w-[88vw] rounded-xl shadow-2xl" />
        </div>
      )}
      {lightbox && galleryHit && (
        <GalleryLightbox
          item={galleryHit}
          characters={list.map((c) => ({ id: c.id, name: c.name }))}
          baseUrl={route.baseUrl}
          apiKey={route.apiKey}
          visionModel={route.model}
          uncensored={uncensored}
          onClose={() => setLightbox(null)}
          onChanged={(next) => {
            if (next) setGalleryHit(next)
          }}
        />
      )}
    </main>
  )
}

/** 私人空间专属：卡片里那两行「这个身份的定位」+ 删除按钮（§22 用户不能删）。 */
function PersonaActions({ p, onDelete }: { p: CharacterProfile; onDelete?: (p: CharacterProfile) => void }) {
  const isMain = p.id === MAIN_PERSONA_ID
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-3">
          <div className="mb-1 text-[12px] font-semibold text-[var(--pink-deep)]">与大家的关系（喂给模型）</div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text-2)]">
            {p.relation?.trim() || '尚未填写。填写后，角色可以据此识别当前身份关系。'}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-3">
          <div className="mb-1 text-[12px] font-semibold text-[var(--pink-deep)]">别人眼里的存在感</div>
          <p className="text-[13px] leading-relaxed text-[var(--text-2)]">
            {p.asCharacter
              ? '✅ 当你用别的身份聊天时，她会作为可聊角色出现在角色介绍 / 群聊阵容里。'
              : '⛔ 只作为「身份」存在，永远不进角色介绍 / 群聊阵容。'}
          </p>
        </div>
      </div>
      {!isMain && onDelete && (
        <button
          className="self-start rounded-xl border border-[var(--border-strong)] px-3 py-1.5 text-[13px] text-[#d9534f] transition-colors hover:bg-[#d9534f]/10"
          onClick={() => void onDelete(p)}
        >
          🗑 删掉这份档案
        </button>
      )}
      {isMain && (
        <p className="text-[12px] text-[var(--text-3)]">
          默认身份不能删 —— 老库里 `group` / `single-*` 的聊天记录都挂在它名下。
        </p>
      )}
    </div>
  )
}
