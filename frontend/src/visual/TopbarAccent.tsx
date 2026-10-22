export const topbarViews = { home: '角色介绍', chat: '聊天', nest: '糖人小窝', space: '私人空间' }
export default function TopbarAccent({
  variant,
  view = 'home',
}: {
  variant: string
  view?: keyof typeof topbarViews
}) {
  return (
    <div className="topbar-accent" data-topbar-accent={variant}>
      {variant === 'w2' ? (
        <svg viewBox="0 0 230 45" fill="none" aria-hidden="true">
          <path d="M5 30C50 10 70 35 110 21s65-13 115-3" stroke="currentColor" strokeWidth=".8" />
          <circle cx="48" cy="22" r="2" fill="currentColor" />
          <circle cx="111" cy="21" r="3" fill="currentColor" />
          <circle cx="181" cy="14" r="2" fill="currentColor" />
        </svg>
      ) : variant === 'w3' ? (
        <>
          <span>当前位置</span>
          <strong>{topbarViews[view]}</strong>
        </>
      ) : null}
    </div>
  )
}
