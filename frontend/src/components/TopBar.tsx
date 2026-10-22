import BrainHealthDot from './BrainHealthDot'
import {useDesignChoice} from '../visual/designChoices'
import TopbarAccent from '../visual/TopbarAccent'
import AppearanceSwitcher from '../visual/AppearanceSwitcher'
import UiIcon from '../visual/UiIcon'
import BrandIdentity from '../visual/BrandIdentity'
type View = 'home' | 'chat' | 'nest' | 'space'

type Props = {
  theme: 'light' | 'dark'
  view: View
  onToggleTheme: () => void
  onView: (v: View) => void
  title?: string
}

// 「糖人小窝」放最左（与介绍页成员切换行的顺序一致）；「我的私人空间」仅次于它 ——
// 两者都是「全家 / 个人」的总入口，跟三位一体的角色页 + 聊天分开排（§21）。
// short：手机端只显示短标 + emoji（§19.24）—— 全称四个字一排塞不下，
// 会各自折成两行，把顶栏撑成屏幕的三分之一。桌面端仍显示全称。
const NAV: { v: View; label: string; short: string; en: string }[] = [
  { v: 'nest', label: '糖人小窝', short: '小窝', en: 'SUGAR HOME' },
  { v: 'space', label: '私人空间', short: '空间', en: 'MY SPACE' },
  { v: 'home', label: '角色介绍', short: '介绍', en: 'CHARACTER' },
  { v: 'chat', label: '聊天', short: '聊天', en: 'CONVERSATION' },
]

export default function TopBar({ theme, view, onToggleTheme, onView }: Props) {
  const topbarChoice=useDesignChoice('topbar')
  return (
    // shrink-0（§19.24）：顶栏是列式 flex 的第一项，不写的话会被内容区挤扁。
    <header data-topbar={topbarChoice} className="topbar z-10 shrink-0 border-b border-[var(--border)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-1.5 sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-bold tracking-wide sm:gap-2.5 sm:text-[17px]">
          {view === 'chat' ? (
            <button aria-label="返回最近聊天" onClick={() => window.dispatchEvent(new Event('xtr-mobile-sessions'))} className="md:hidden text-xl leading-none">◁</button>
          ) : (
            <button aria-label="返回聊天" onClick={() => onView('chat')} className="md:hidden text-xl leading-none">◁</button>
          )}
          <BrandIdentity/>
        </div>

        <TopbarAccent variant={topbarChoice} view={view}/>
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <nav className="visual-main-nav hidden md:flex">
            {NAV.map(({ v, label, short, en }) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className="visual-nav-link" aria-current={view === v ? 'page' : undefined}
              >

                <span className="hidden sm:inline">{label}</span>
                <span className="ml-0.5 sm:hidden">{short}</span><small>{en}</small>
              </button>
            ))}
          </nav>
          <AppearanceSwitcher/>
          <BrainHealthDot/>
          <button aria-label={theme === 'light' ? '切换夜间' : '切换日间'}
            onClick={onToggleTheme}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text-2)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)] sm:px-3.5"
          >
            <UiIcon name={theme === 'light' ? 'moon' : 'sun'}/>
            <span className="hidden sm:inline">{theme === 'light' ? '夜间' : '日间'}</span>
          </button>
        </div>
      </div>
    </header>
  )
}
