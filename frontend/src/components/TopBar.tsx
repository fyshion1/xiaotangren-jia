type View = 'home' | 'chat' | 'nest'

type Props = {
  theme: 'light' | 'dark'
  view: View
  onToggleTheme: () => void
  onView: (v: View) => void
}

const NAV: { v: View; label: string }[] = [
  { v: 'home', label: '角色介绍' },
  { v: 'chat', label: '聊天' },
  { v: 'nest', label: '🏠 糖人小窝' },
]

export default function TopBar({ theme, view, onToggleTheme, onView }: Props) {
  return (
    <header className="topbar sticky top-0 z-10 border-b border-[var(--border)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-3 py-2 sm:px-4 sm:py-2.5">
        <div className="flex items-center gap-2 text-[15px] font-bold tracking-wide sm:gap-2.5 sm:text-[17px]">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--pink)] to-[var(--pink-deep)] text-[14px] text-white shadow-[var(--shadow-sm)]">
            🍬
          </span>
          <span>小糖人之家</span>
        </div>

        <div className="flex items-center gap-2">
          <nav className="mr-1 flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] p-1">
            {NAV.map(({ v, label }) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className={`rounded-full px-3 py-1.5 text-[13px] transition sm:px-4 ${
                  view === v ? 'bg-[var(--pink)] text-white' : 'text-[var(--text-2)] hover:text-[var(--text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            onClick={onToggleTheme}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-1.5 text-[13px] text-[var(--text-2)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)] sm:px-3.5"
          >
            {theme === 'light' ? '🌙' : '☀️'}
            <span className="hidden sm:inline">{theme === 'light' ? '夜间' : '日间'}</span>
          </button>
        </div>
      </div>
    </header>
  )
}