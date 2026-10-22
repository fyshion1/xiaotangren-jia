import { useRef, useState } from 'react'

export default function ListInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [draft, setDraft] = useState(() => value.join('，'))
  const previous = useRef(value)
  if (previous.current !== value) { previous.current = value; setDraft(value.join('，')) }
  return <input className="input" value={draft} onChange={e => {
    setDraft(e.target.value)
    const next = e.target.value.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
    previous.current = next
    onChange(next)
  }} />
}

