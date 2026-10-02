type View = 'home' | 'chat' | 'nest' | 'space'

type Props = {
  theme: 'light' | 'dark'
  view: View
  onToggleTheme: () => void
  onView: (v: View) => void
}

// 「糖人小窝」放最左（与介绍页成员切换行的顺序一致）；「我的私人空间」仅次于它 ——
// 两者都是「全家 / 个人」的总入口，跟三位一体的角色页 + 聊天分开排（§21）。
// short：手机端只显示短标 + emoji（§19.24）—— 全称四个字一排塞不下，
// 会各自折成两行，把顶栏撑成屏幕的三分之一。桌面端仍显示全称。
const NAV: { v: View; label: string; short: string; emoji: string }[] = [
  { v: 'nest', label: '🏠 糖人小窝', short: '小窝', emoji: '🏠' },
  { v: 'space', label: '🐻 私人空间', short: '空间', emoji: '🐻' },
  { v: 'home', label: '角色介绍', short: '介绍', emoji: '🎀' },
  { v: 'chat', label: '聊天', short: '聊天', emoji: '💬' },
]

export default function TopBar({ theme, view, onToggleTheme, onView }: Props) {
  return (
    // shrink-0（§19.24）：顶栏是列式 flex 的第一项，不写的话会被内容区挤扁。
    <header className="topbar z-10 shrink-0 border-b border-[var(--border)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-1.5 sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-bold tracking-wide sm:gap-2.5 sm:text-[17px]">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--pink)] to-[var(--pink-deep)] text-[14px] text-white shadow-[var(--shadow-sm)]">
            🍬
          </span>
          <span className="truncate">小糖人之家</span>
        </div>

        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full border border-[var(--border)] bg-[var(--surface)] p-0.5 sm:gap-1 sm:p-1">
            {NAV.map(({ v, label, short, emoji }) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className={`shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-[12px] transition sm:px-4 sm:py-1.5 sm:text-[13px] ${
                  view === v ? 'bg-[var(--pink)] text-white' : 'text-[var(--text-2)] hover:text-[var(--text)]'
                }`}
              >
                <span className="sm:hidden">{emoji}</span>
                <span className="hidden sm:inline">{label}</span>
                <span className="ml-0.5 sm:hidden">{short}</span>
              </button>
            ))}
          </nav>
          <button
            onClick={onToggleTheme}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text-2)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)] sm:px-3.5"
          >
            {theme === 'light' ? '🌙' : '☀️'}
            <span className="hidden sm:inline">{theme === 'light' ? '夜间' : '日间'}</span>
          </button>
        </div>
      </div>
    </header>
  )
}
