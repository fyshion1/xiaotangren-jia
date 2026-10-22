import { useEffect, useRef } from 'react'

/** Native details with outside-click and Escape dismissal. */
export function useDismissableDetails() {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const node = ref.current
      if (node?.open && event.target instanceof Node && !node.contains(event.target))
        node.open = false
    }
    const escape = (event: KeyboardEvent) => {
      const node = ref.current
      if (event.key === 'Escape' && node?.open) {
        node.open = false
        node.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  return ref
}
