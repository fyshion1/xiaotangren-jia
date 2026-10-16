// 小窝 · 抽屉（§9.6 布局改造）：默认收起，点标题栏才展开。
//
// 为什么不用原生 <details>（NestApiPanel 里那种）：小窝要能**从外面把它打开** ——
// 点「一起玩」里的项目卡片得跳到「🚀 让功能跑起来」那一块，<details> 没法受控。
// 所以这里受控 + 自己画三角。
//
// 收起的抽屉里**不渲染 children** —— 这是「页面别太长」的一半：日语 / 英语那种上千行的面板、
// 各自的联网请求，不展开就一点都不发生。代价是展开时是重新挂载（里头的编辑草稿不保留），
// 换来的是切来切去不攒着一堆看不见的请求。

import type { ReactNode } from 'react'

export default function NestDrawer({
  title,
  hint,
  badge,
  open,
  onToggle,
  children,
}: {
  title: string
  /** 标题右边那句小字，说清这抽屉里是什么。窄屏隐藏（标题栏本来就挤）。 */
  hint?: string
  /** 最右边的角标（数量、「在跑」这种）。 */
  badge?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="mb-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition hover:bg-[color-mix(in_srgb,var(--pink)_8%,transparent)]"
      >
        <span className="w-3 shrink-0 text-[13px] text-[var(--text-3)]">{open ? '▾' : '▸'}</span>
        <span className="text-[15px] font-bold text-[var(--text)]">{title}</span>
        {hint && <span className="hidden truncate text-[11px] text-[var(--text-3)] sm:inline">{hint}</span>}
        {badge != null && <span className="ml-auto shrink-0 text-[11px] text-[var(--text-3)]">{badge}</span>}
      </button>
      {open && <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">{children}</div>}
    </section>
  )
}