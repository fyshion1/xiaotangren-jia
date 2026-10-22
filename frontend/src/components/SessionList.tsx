import { useTavernMode } from '../lib/tavernMode'
import UiIcon from '../visual/UiIcon'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ChatSession } from '../data/chats'
import type { CharacterProfile } from '../data/characters'
import Avatar from './Avatar'

const WorldbookPanel = lazy(() => import('./WorldbookPanel'))

type Props = {
  sessions: ChatSession[]
  activeId: string
  onSelect: (id: string) => void
  /** 选了文件才回调 —— 读卡 / 解析在后端，这里只管把 File 递上去。 */
  onImport: (file: File) => void
  /** 角色列表：单聊会话按 characterIds[0] 反查头像（未传则退回 emoji）。 */
  characters?: CharacterProfile[]
  /** 「消息」栏里的入口 → 糖人小窝（§28）：手机端从小窝也能走回这栏，再从这栏进小窝。 */
  onOpenNest?: () => void
  /** 删掉导入的角色卡（只有她能删）。会话列表里给一个 🗑，鼠标划过去才露出来。 */
  onDeleteImported?: (c: CharacterProfile) => void
  cardDisplayMode: 'chat' | 'html'
  onCardDisplayModeChange: (mode: 'chat' | 'html') => void
}

export default function SessionList({ sessions, activeId, onSelect, onImport, characters = [], onOpenNest, onDeleteImported, cardDisplayMode, onCardDisplayModeChange }: Props) {
  const [tavernMode] = useTavernMode()
  const fileRef = useRef<HTMLInputElement>(null)
  const worldbookRef = useRef<HTMLDialogElement>(null)
  const [worldbookOpen, setWorldbookOpen] = useState(false)
  useEffect(() => {
    if (!tavernMode) setWorldbookOpen(false)
  }, [tavernMode])
  useEffect(() => {
    if (worldbookOpen && tavernMode) worldbookRef.current?.showModal()
    else worldbookRef.current?.close()
  }, [worldbookOpen, tavernMode])

  // 单聊用对方头像（QQ 式）；群聊没有单一角色，保留 emoji 图标。
  const faceOf = (s: ChatSession) => {
    if (s.kind !== 'single') return null
    const c = characters.find((x) => x.id === s.characterIds[0])
    if (!c) return null
    return <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={34} />
  }

  /** 这一条会话背后是不是「导入的角色卡」—— 只有这种才给删除按钮（自家四位删不掉）。 */
  const importedOf = (s: ChatSession): CharacterProfile | null => {
    if (s.kind !== 'single' || !onDeleteImported) return null
    const c = characters.find((x) => x.id === s.characterIds[0])
    return c?.imported ? c : null
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-3 text-[12px] font-semibold tracking-wide text-[var(--text-3)]">最近聊天</div>
      {tavernMode && <label className="mx-4 mb-3 flex items-center gap-2 text-xs text-[var(--text-2)]">
        角色卡显示
        <select className="input min-w-0 flex-1" aria-label="角色卡显示方式" value={cardDisplayMode}
          onChange={e => onCardDisplayModeChange(e.target.value as 'chat' | 'html')}>
          <option value="chat">仅聊天</option><option value="html">HTML 渲染</option>
        </select>
      </label>}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.filter(s => tavernMode || !characters.find(c => s.kind === 'single' && c.id === s.characterIds[0])?.imported).map((s) => {
          const doomed = importedOf(s)
          return (
            // 外层是 div（分组）：会话行本身是按钮，导入角色的 🗑 是它旁边另一个按钮 ——
            // 按钮不能嵌按钮，所以不能再把删除塞进会话行里面。
            <div key={s.id} className="group/session relative">
              <button
                onClick={() => onSelect(s.id)}
                className={`session-item ${s.id === activeId ? 'on' : ''} ${doomed ? 'pr-9' : ''}`}
              >
                {faceOf(s) ?? <span className="session-emoji">{s.emoji}</span>}
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[14px] font-medium text-[var(--text)]">{s.name}</span>
                  <span className="block truncate text-[12px] text-[var(--text-3)]">{s.subtitle}</span>
                </span>
              </button>
              {doomed && (
                <button
                  type="button"
                  title={`删掉导入的「${doomed.name}」（连她的聊天记录、个人记忆、立绘一起清）`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteImported?.(doomed)
                  }}
                  // 手机上划不出 hover，所以窄屏常显；桌面端鼠标进这一行才露面。
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg px-1.5 py-1 text-[13px] text-[var(--text-3)] opacity-100 transition hover:bg-[#d9534f]/12 hover:text-[#d9534f] md:opacity-0 md:group-hover/session:opacity-100"
                >
                  🗑
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t border-[var(--border)] p-2">
        {tavernMode && <button type="button" className="session-item w-full" onClick={() => setWorldbookOpen(true)}>
          <span className="session-emoji"><UiIcon name="book"/></span>
          <span className="text-[13px] text-[var(--text-2)]">共用世界书</span>
        </button>}
        {onOpenNest && (
          <button
            className="session-item w-full"
            onClick={onOpenNest}
            title="糖人小窝：全家的共同回忆（共用画廊）+ 以后的小游戏 / 互动小家"
          >
            <span className="session-emoji"><UiIcon name="home"/></span>
            <span className="text-[13px] text-[var(--text-2)]">糖人小窝</span>
          </button>
        )}
        {tavernMode && <button
          className="session-item w-full"
          onClick={() => fileRef.current?.click()}
          title="导入酒馆（SillyTavern）角色卡：PNG 卡或 JSON 卡都认，读出来的人设原文照搬，不洗不改"
        >
          <span className="session-emoji"><UiIcon name="card"/></span>
          <span className="text-[13px] text-[var(--text-2)]">导入角色卡（酒馆）</span>
        </button>}
        {tavernMode && <input
          ref={fileRef}
          type="file"
          accept=".json,.png,image/png,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onImport(f)
            e.target.value = '' // 同一个文件连选两次也要能触发
          }}
        />}
      </div>
      {tavernMode && worldbookOpen && <dialog ref={worldbookRef} aria-label="共用世界书"
        onClose={() => setWorldbookOpen(false)}
        className="m-auto max-h-[85dvh] w-[min(56rem,94vw)] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)] backdrop:bg-black/40">
        <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">共用世界书</h2>
          <button type="button" className="btn ghost sm" onClick={() => setWorldbookOpen(false)} aria-label="关闭共用世界书">关闭</button>
        </div>
        <Suspense fallback={<p role="status">加载世界书…</p>}>
          <WorldbookPanel owner="" ownerLabel="家 · 共用世界书" bare />
        </Suspense>
      </dialog>}
    </div>
  )
}
