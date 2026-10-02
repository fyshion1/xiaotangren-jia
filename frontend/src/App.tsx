import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import HomeView from './components/HomeView'
import ChatView from './components/ChatView'
import NestView from './components/NestView'
import type { CharacterProfile } from './data/characters'
import { PERSONA_FALLBACK, PROFILE_FALLBACK } from './data/characters'
import { MAIN_PERSONA_ID } from './data/chats'
import {
  createProfile,
  deleteProfile,
  fetchCharacters,
  fetchProfiles,
  saveCharacter,
  saveProfile,
  switchProfile,
} from './api/client'

type Theme = 'light' | 'dark'
type View = 'home' | 'chat' | 'nest' | 'space'

const THEME_KEY = 'xtr.theme'

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [view, setView] = useState<View>('chat')
  const [characters, setCharacters] = useState<CharacterProfile[]>([])
  const [charsReady, setCharsReady] = useState(false)
  // 个人档案（§22）：用户自己的身份，放在「私人空间」里切换。与 characters 分开存，
  // 因为两者语义不同 —— 前者是「被聊的小糖人」，后者是「正在说话的你」。
  const [personas, setPersonas] = useState<CharacterProfile[]>([])
  const [activePersonaId, setActivePersonaId] = useState<string>(MAIN_PERSONA_ID)
  // 跨页导航：从聊天页点「缩略头像」跳去某角色的介绍；从介绍页「进入聊天」跳去某会话
  const [profileCharId, setProfileCharId] = useState<string | undefined>(undefined)
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(undefined)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // 人设唯一真相源在后端 SQLite：启动时拉取一次。
  useEffect(() => {
    let alive = true
    fetchCharacters()
      .then((list) => {
        if (!alive) return
        setCharacters(list)
        setCharsReady(true)
      })
      .catch(() => {
        if (!alive) return
        setCharacters(PROFILE_FALLBACK) // 后端拉不到也先渲染出四位角色，避免白屏
        setCharsReady(true)
      })
    // 档案列表 + 当前身份一起拉。失败就保持默认（大老大），聊天照常可用。
    fetchProfiles()
      .then((payload) => {
        if (!alive) return
        setPersonas(payload.profiles)
        setActivePersonaId(payload.active_id || payload.main_id || MAIN_PERSONA_ID)
      })
      .catch(() => {
        // 后端不可用也把两份身份摆出来（§22），否则私人空间整页空白、聊天页拿不到「当前身份」。
        setPersonas(PERSONA_FALLBACK)
        setActivePersonaId(MAIN_PERSONA_ID)
      })
    return () => {
      alive = false
    }
  }, [])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])

  const onSaveChar = useCallback(async (next: CharacterProfile) => {
    const saved = await saveCharacter(next)
    setCharacters((list) => list.map((c) => (c.id === saved.id ? saved : c)))
  }, [])

  const onSavePersona = useCallback(async (next: CharacterProfile) => {
    const saved = await saveProfile(next)
    setPersonas((list) => list.map((p) => (p.id === saved.id ? saved : p)))
  }, [])

  /** 「成为这个身份」（§22）：全局一处切换 —— 私聊群聊一起走，聊天记录各自一条。 */
  const onBecomePersona = useCallback(async (personaId: string) => {
    const { active_id } = await switchProfile(personaId)
    setActivePersonaId(active_id)
  }, [])

  const onCreatePersona = useCallback(async (draft: Omit<CharacterProfile, 'id'> & { id?: string }) => {
    const saved = await createProfile(draft)
    setPersonas((list) => [...list, saved])
    return saved
  }, [])

  /** 删档案：后端连这个身份名下的会话一起清掉，所以当前身份要跟着回落。 */
  const onDeletePersona = useCallback(async (personaId: string) => {
    await deleteProfile(personaId)
    setPersonas((list) => list.filter((p) => p.id !== personaId))
    setActivePersonaId((cur) => (cur === personaId ? MAIN_PERSONA_ID : cur))
  }, [])

  // 形态切换（§17）：只改 activeFormId，写回后端 → 刷新 / 换设备 / 换会话都保持。
  // 在场的可能是小糖人，也可能是「别的身份」（如汐子视角下的大老大），两者存两张表。
  const onSwitchForm = useCallback(
    async (charId: string, formId: string) => {
      const persona = personas.find((p) => p.id === charId)
      if (persona) {
        const saved = await saveProfile({ ...persona, activeFormId: formId })
        setPersonas((list) => list.map((p) => (p.id === saved.id ? saved : p)))
        return
      }
      const cur = characters.find((c) => c.id === charId)
      if (!cur) return
      const saved = await saveCharacter({ ...cur, activeFormId: formId })
      setCharacters((list) => list.map((c) => (c.id === saved.id ? saved : c)))
    },
    [characters, personas],
  )

  const openProfile = useCallback((charId: string) => {
    setProfileCharId(charId)
    setView('home')
  }, [])

  const openChat = useCallback((sessionId?: string) => {
    setChatSessionId(sessionId)
    setView('chat')
  }, [])

  const activePersona = personas.find((p) => p.id === activePersonaId) ?? personas[0]

  // h-[100dvh] 而不是 h-screen（§19.21）：手机上 100vh 大于可视高度（地址栏收放、
  // 键盘弹出），会让整页产生一层可滚区间，顶栏跟着滚走。dvh 跟着真实可视高度走。
  return (
    <div className="flex h-[100dvh] flex-col">
      <TopBar theme={theme} view={view} onToggleTheme={toggleTheme} onView={setView} />
      {/* 内容区自己滚（§19.23）：聊天页撑满 h-full 在内部滚；介绍页 / 小窝 / 私人空间
          是长文档，溢出的部分交给这一层 —— 以前它们靠 body 滚，body 一锁就整页滑不动。 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!charsReady ? (
          <div className="flex min-h-full items-center justify-center text-sm text-[var(--text-3)]">加载中…</div>
        ) : view === 'home' ? (
          <HomeView
            characters={characters}
            initialCharId={profileCharId}
            onSaveChar={onSaveChar}
            onEnterChat={openChat}
            onOpenNest={() => setView('nest')}
          />
        ) : view === 'nest' ? (
          <NestView />
        ) : view === 'space' ? (
          /* 私人空间（§21 / §22）：你自己的身份档案页。复用角色介绍页的全部内容，
             但 active 跟着「当前身份」走，成员行换成一排可切换的身份卡片。 */
          <HomeView
            characters={personas}
            initialCharId={activePersonaId}
            space
            activePersonaId={activePersonaId}
            onSaveChar={onSavePersona}
            onCreateProfile={onCreatePersona}
            onBecomePersona={onBecomePersona}
            onDeletePersona={onDeletePersona}
            onEnterChat={openChat}
            onOpenNest={() => setView('nest')}
          />
        ) : (
          <ChatView
            characters={characters}
            personas={personas}
            activePersona={activePersona}
            initialSessionId={chatSessionId}
            onOpenProfile={openProfile}
            onOpenSelf={() => setView('space')}
            onSwitchForm={onSwitchForm}
          />
        )}
      </div>
    </div>
  )
}