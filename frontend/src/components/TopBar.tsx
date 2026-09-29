type Props = {
  theme: 'light' | 'dark'
  view: 'home' | 'chat'
  onToggleTheme: () => void
  onView: (v: 'home' | 'chat') => void
}

export default function TopBar({ theme, view, onToggleTheme, onView }: Props) {
  return (
    <header className="topbar sticky top-0 z-10 border-b border-[var(--border)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2.5 text-[17px] font-bold tracking-wide">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--pink)] to-[var(--pink-deep)] text-[14px] text-white shadow-[var(--shadow-sm)]">
            🍬
          </span>
          小糖人之家
        </div>

        <div className="flex items-center gap-2">
          <nav className="mr-1 flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] p-1">
            {(['home', 'chat'] as const).map((v) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className={`rounded-full px-4 py-1.5 text-[13px] transition ${
                  view === v ? 'bg-[var(--pink)] text-white' : 'text-[var(--text-2)] hover:text-[var(--text)]'
                }`}
              >
                {v === 'home' ? '角色介绍' : '聊天'}
              </button>
            ))}
          </nav>
          <button
            onClick={onToggleTheme}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-1.5 text-[13px] text-[var(--text-2)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)]"
          >
            {theme === 'light' ? '🌙 夜间' : '☀️ 日间'}
          </button>
        </div>
      </div>
    </header>
  )
}