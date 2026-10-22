import { useState } from 'react'
type Style = 'spark' | 'ribbon' | 'home'
const options: { id: Style; name: string; note: string }[] = [
  { id: 'spark', name: '01 星糖 · 轻盈', note: '四角星与圆点，字样轻巧柔和' },
  { id: 'ribbon', name: '02 糖结 · 甜美', note: '缎带糖果，字样更活泼亲近' },
  { id: 'home', name: '03 小屋 · 温暖', note: '屋檐与心形，字样圆润工整' },
]
function Mark({ kind }: { kind: Style }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'spark' ? (
          <>
            <path d="M23 6C23 17 18 23 7 24c11 1 16 6 16 18 1-12 6-17 17-18C29 23 24 17 23 6Z" />
            <circle cx="38" cy="9" r="2.5" fill="currentColor" stroke="none" />
          </>
        ) : kind === 'ribbon' ? (
          <>
            <path d="m15 18-9-5 2 11-2 11 9-5m18-12 9-5-2 11 2 11-9-5" />
            <rect x="14" y="14" width="20" height="20" rx="8" />
            <path
              d="M20 20c1-2 3-2 4 0 1-2 4-2 4 0 0 3-4 6-4 6s-4-3-4-6Z"
              fill="currentColor"
              stroke="none"
            />
          </>
        ) : (
          <>
            <path d="m7 22 17-14 17 14M12 20v19h24V20" />
            <path
              d="M18 25c0-4 5-5 6-1 2-4 6-3 6 1 0 4-6 8-6 8s-6-4-6-8Z"
              fill="currentColor"
              stroke="none"
            />
          </>
        )}
      </g>
    </svg>
  )
}
export default function BrandIdentity() {
  const [style] = useState<Style>(() => {
    try {
      const s = localStorage.getItem('xtr.visual.brand')
      return options.some((o) => o.id === s) ? (s as Style) : 'spark'
    } catch {
      return 'spark'
    }
  })
  return (
    <div className="brand-identity">
      <div className={'brand-lockup brand-' + style} aria-label="糖人之家">
        <span className="brand-mark">
          <Mark kind={style} />
        </span>
        <div>
          <span className="brand-word">糖人之家</span>
        </div>
      </div>
    </div>
  )
}
