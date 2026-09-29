import { useCallback, useEffect, useState } from 'react'
import TopBar from './components/TopBar'
import HomeView from './components/HomeView'
import ChatView from './components/ChatView'
import { loadCharacters, saveCharacters } from './data/characters'
import type { CharacterProfile } from './data/characters'

type Theme = 'light' | 'dark'
type View = 'home' | 'chat'

const THEME_KEY = 'xtr.theme'

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [view, setView] = useState<View>('chat')
  const [characters, setCharacters] = useState<CharacterProfile[]>(loadCharacters)
  // 跨页导航：从聊天页点「缩略头像」跳去某角色的介绍；从介绍页「进入聊天」跳去某会话
  const [profileCharId, setProfileCharId] = useState<string | undefined>(undefined)
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(undefined)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])

  const onSaveChar = useCallback((next: CharacterProfile) => {
    setCharacters((list) => {
      const nextList = list.map((c) => (c.id === next.id ? next : c))
      saveCharacters(nextList)
      return nextList
    })
  }, [])

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
        {view === 'home' ? (
          <HomeView
            characters={characters}
            initialCharId={profileCharId}
            onSaveChar={onSaveChar}
            onEnterChat={openChat}
          />
        ) : (
          <ChatView
            characters={characters}
            initialSessionId={chatSessionId}
            onOpenProfile={openProfile}
          />
        )}
      </div>
    </div>
  )
}