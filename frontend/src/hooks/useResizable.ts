// 侧边栏拖宽（§19.11）：一条把「拖动量 → 宽度 → localStorage」串起来的 hook。
//
// 用法：
//   const nav = useResizable('xtr.w.nav', 230, 160, 420)
//   <aside className="md:w-[var(--sb-w)]" style={nav.style}> … <div {...nav.handleProps} /> </aside>
//
// 设计取舍：
// - **不监听 window.resize**：宽度是用户定的，不该被窗口尺寸改写；夹取只发生在拖动那一刻。
// - **md 以下不生效**：手机端侧栏是整屏 tab，宽度没意义。handle 用 `hidden md:block` 藏掉，
//   宽度也只写在 `md:` 前缀的类上，窄屏完全不受影响。
// - **拖动期间锁选择**：不然鼠标划过文字会一路高亮，手感很脏。
import { useCallback, useRef, useState } from 'react'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function useResizable(key: string, initial: number, min: number, max: number, dir: 1 | -1 = 1) {
  const [width, setWidth] = useState(() => {
    const raw = Number(localStorage.getItem(key))
    return Number.isFinite(raw) && raw > 0 ? clamp(raw, min, max) : initial
  })
  const dragRef = useRef<{ x: number; w: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = { x: e.clientX, w: width }
      // 拖动期间整页禁选 + 指针始终是「左右拽」，哪怕手滑出了把手那一小条
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [width],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const st = dragRef.current
      if (!st) return
      // dir = 1：把手在侧栏右缘，往右拖变宽；dir = -1：把手在左缘，往左拖变宽。
      setWidth(clamp(st.w + dir * (e.clientX - st.x), min, max))
    },
    [dir, min, max],
  )

  const end = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* 指针已经丢了就算了 */
      }
    },
    [],
  )

  const handleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: end,
    onPointerCancel: end,
    onDoubleClick: () => setWidth(initial), // 双击把手 = 恢复默认宽度
  }

  // 落盘：拖动过程中会写很多次，但 localStorage 同步写、量很小，不值得再防抖。
  if (typeof window !== 'undefined') localStorage.setItem(key, String(width))

  return { width, style: { '--sb-w': `${width}px` } as React.CSSProperties, handleProps }
}
