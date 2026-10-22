import { useState, type ReactNode } from 'react'
export default function ProfileSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="visual-original-profile"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        {title}
        <span>{open ? '收起' : '展开查看'}</span>
      </summary>
      {open && children}
    </details>
  )
}
