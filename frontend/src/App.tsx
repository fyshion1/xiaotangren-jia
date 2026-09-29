import { useCallback, useEffect, useRef, useState } from 'react'

type Message = {
  role: 'user' | 'assistant'
  content: string
}

async function streamChat(
  messages: Message[],
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
) {
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    })
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`)
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const evt of events) {
        const lines = evt.split('\n')
        const dataLine = lines.find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const payload = JSON.parse(dataLine.slice(5).trim())
        const type = lines.find((l) => l.startsWith('event:'))?.slice(6).trim()
        if (type === 'token' && payload.text) onToken(payload.text)
        else if (type === 'done') onDone()
        else if (type === 'error') onError(payload.message ?? '未知错误')
      }
    }
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e))
  }
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    const next: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setStreaming(true)
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }])
    await streamChat(
      next,
      (t) => setMessages((prev) => {
        const copy = [...prev]
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          content: copy[copy.length - 1].content + t,
        }
        return copy
      }),
      () => setStreaming(false),
      (msg) => {
        setMessages((prev) => {
          const copy = [...prev]
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: '[错误] ' + msg }
          return copy
        })
        setStreaming(false)
      },
    )
  }, [input, messages, streaming])

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-4 py-2 text-sm text-zinc-300">
        小糖人之家 · 文字聊天（MVP）
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.map((m, i) => (
          <div key={i} className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[70%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-[15px] ${
                m.role === 'user'
                  ? 'bg-pink-600 text-white'
                  : 'bg-zinc-800 text-zinc-100'
              }`}
            >
              {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <footer className="border-t border-zinc-800 p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={2}
            placeholder="和小糖人说点什么…（Enter 发送，Shift+Enter 换行）"
            className="flex-1 resize-none rounded-xl bg-zinc-800 px-3 py-2 text-[15px] outline-none placeholder:text-zinc-500"
          />
          <button
            onClick={send}
            disabled={streaming}
            className="rounded-xl bg-pink-600 px-5 text-sm font-medium text-white hover:bg-pink-500 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </footer>
    </div>
  )
}