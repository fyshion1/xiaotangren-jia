import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import HomeView from './components/HomeView'
import ChatView from './components/ChatView'
import NestView from './components/NestView'
import type { CharacterProfile } from './data/characters'
import { PROFILE_FALLBACK } from './data/characters'
import { fetchCharacters, saveCharacter } from './api/client'

type Theme = 'light' | 'dark'
type View = 'home' | 'chat' | 'nest'

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
    return () => {
      alive = false
    }
  }, [])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])

  const onSaveChar = useCallback(async (next: CharacterProfile) => {
    const saved = await saveCharacter(next)
    setCharacters((list) => list.map((c) => (c.id === saved.id ? saved : c)))
  }, [])

  // 形态切换（§17）：只改 activeFormId，写回后端 → 刷新 / 换设备 / 换会话都保持。
  const onSwitchForm = useCallback(
    async (charId: string, formId: string) => {
      const cur = characters.find((c) => c.id === charId)
      if (!cur) return
      await onSaveChar({ ...cur, activeFormId: formId })
    },
    [characters, onSaveChar],
  )

  const openProfile = useCallback((charId: string) => {
    setProfileCharId(charId)
    setView('home')
  }, [])

  const openChat = useCallback((sessionId?: string) => {
    setChatSessionId(sessionId)
    setView('chat')
  }, [])

  return (
    <div className="flex h-screen flex-col">
      <TopBar theme={theme} view={view} onToggleTheme={toggleTheme} onView={setView} />
      <div className="min-h-0 flex-1">
        {!charsReady ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-3)]">加载中…</div>
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
        ) : (
          <ChatView
            characters={characters}
            initialSessionId={chatSessionId}
            onOpenProfile={openProfile}
            onSwitchForm={onSwitchForm}
          />
        )}
      </div>
    </div>
  )
}