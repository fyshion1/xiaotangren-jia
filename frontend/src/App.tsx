import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ===== 类型 =====
type Message = {
  role: 'user' | 'assistant'
  content: string
  image?: string // 图片消息（data URL，仅 user 消息）
}

export type ModelConfig = {
  baseUrl: string
  apiKey: string
  chatModel: string
  visionModel: string
}

const DEFAULT_CONFIG: ModelConfig = {
  baseUrl: 'https://moyuu.cc/v1',
  apiKey: '',
  chatModel: 'gemini-3.6-flash',
  visionModel: 'gemini-3.1-flash-image',
}

const STORAGE_KEY = 'xiaotangren.config'

function loadConfig(): ModelConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG
}

// ===== SSE 流式请求（通用） =====
async function streamSSE(
  url: string,
  body: unknown,
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`)
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false
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
        else if (type === 'done') {
          finished = true
          onDone()
        } else if (type === 'error') {
          finished = true
          onError(payload.message ?? '未知错误')
        }
      }
    }
    if (!finished) onDone()
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e))
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [config, setConfig] = useState<ModelConfig>(loadConfig)
  const [showSettings, setShowSettings] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const saveConfig = useCallback((c: ModelConfig) => {
    setConfig(c)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  }, [])

  const appendAssistantToken = useCallback((t: string) => {
    setMessages((prev) => {
      const copy = [...prev]
      const last = copy[copy.length - 1]
      copy[copy.length - 1] = { ...last, content: last.content + t }
      return copy
    })
  }, [])

  const appendAssistantError = useCallback((msg: string) => {
    setMessages((prev) => {
      const copy = [...prev]
      const last = copy[copy.length - 1]
      copy[copy.length - 1] = { ...last, content: last.content || `[错误] ${msg}` }
      return copy
    })
  }, [])

  // ===== 发送文字 =====
  const sendText = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    const next: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setStreaming(true)
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }])
    await streamSSE(
      '/api/chat',
      {
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.chatModel,
      },
      appendAssistantToken,
      () => {
        setStreaming(false)
      },
      (msg) => {
        appendAssistantError(msg)
        setStreaming(false)
      },
    )
  }, [input, messages, streaming, config, appendAssistantToken, appendAssistantError])

  // ===== 上传图片看图 =====
  const onPickImage = useCallback(
    async (file: File) => {
      if (streaming) return
      const dataUrl = await fileToDataUrl(file)
      const base64 = dataUrl.split(',')[1]
      const mime = file.type || 'image/png'
      const prompt = '（这是一张发给你的图片）请看图回答。'
      const userMsg: Message = { role: 'user', content: prompt, image: dataUrl }
      const next = [...messages, userMsg]
      setMessages(next)
      setStreaming(true)
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])
      await streamSSE(
        '/api/images/chat',
        { image_base64: base64, mime, prompt, base_url: config.baseUrl, api_key: config.apiKey, model: config.visionModel },
        appendAssistantToken,
        () => {
          setStreaming(false)
        },
        (msg) => {
          appendAssistantError(msg)
          setStreaming(false)
        },
      )
    },
    [messages, streaming, config, appendAssistantToken, appendAssistantError],
  )

  const busy = useMemo(() => streaming, [streaming])

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-sm text-zinc-300">
        <span>小糖人之家 · 文字聊天（MVP）</span>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="rounded-lg bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700"
        >
          ⚙ 模型设置
        </button>
      </header>

      {showSettings && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-4 py-3">
          <div className="mb-1 text-xs text-zinc-400">模型来源（存入本地浏览器，不下发）</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <Field label="Base URL（OpenAI 兼容 /v1）">
              <Input value={config.baseUrl} onChange={(v) => setConfig({ ...config, baseUrl: v })} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label="API Key">
              <Input type="password" value={config.apiKey} onChange={(v) => setConfig({ ...config, apiKey: v })} placeholder="sk-..." />
            </Field>
            <Field label="聊天模型（chat）">
              <Input value={config.chatModel} onChange={(v) => setConfig({ ...config, chatModel: v })} placeholder="gpt-4o-mini" />
            </Field>
            <Field label="看图模型（vision）">
              <Input value={config.visionModel} onChange={(v) => setConfig({ ...config, visionModel: v })} placeholder="gpt-4o-mini" />
            </Field>
          </div>
          <div className="mt-2 flex justify-end">
            <button
              onClick={() => {
                saveConfig(config)
                setShowSettings(false)
              }}
              className="rounded-lg bg-pink-600 px-4 py-1.5 text-xs text-white hover:bg-pink-500"
            >
              保存并关闭
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">
            和小糖人说点什么吧（先点右上角 ⚙ 填好模型）
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[70%] rounded-2xl px-4 py-2 text-[15px] ${
                m.role === 'user' ? 'bg-pink-600 text-white' : 'bg-zinc-800 text-zinc-100'
              }`}
            >
              {m.image && <img src={m.image} alt="upload" className="mb-2 max-h-48 rounded-lg" />}
              <div className="whitespace-pre-wrap">
                {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <footer className="border-t border-zinc-800 p-3">
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="发送图片给小糖人看"
            className="rounded-xl bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50"
          >
            🖼
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onPickImage(f)
              e.target.value = ''
            }}
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendText()
              }
            }}
            rows={2}
            placeholder="和小糖人说点什么…（Enter 发送，Shift+Enter 换行）"
            className="flex-1 resize-none rounded-xl bg-zinc-800 px-3 py-2 text-[15px] outline-none placeholder:text-zinc-500"
          />
          <button
            onClick={sendText}
            disabled={busy}
            className="rounded-xl bg-pink-600 px-5 py-2 text-sm font-medium text-white hover:bg-pink-500 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </footer>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

function Input({
  value,
  onChange,
  type,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-sm outline-none placeholder:text-zinc-600"
    />
  )
}