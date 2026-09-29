import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import type { ChatSession, ChatMessage } from '../data/chats'
import { buildSessions, suggestionsFor } from '../data/chats'
import SessionList from './SessionList'
import StatusSidebar from './StatusSidebar'

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-0.5 block">{label}</span>
      {children}
    </label>
  )
}

type Props = {
  characters: CharacterProfile[]
  initialSessionId?: string
  onOpenProfile: (charId: string) => void
}

export default function ChatView({ characters, initialSessionId, onOpenProfile }: Props) {
  const sessions = useMemo(() => buildSessions(characters), [characters])
  const [activeId, setActiveId] = useState<string>(initialSessionId ?? sessions[0]?.id ?? 'group')
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]

  const [history, setHistory] = useState<Record<string, ChatMessage[]>>({})
  const messages = active ? history[active.id] ?? [] : []

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

  const push = useCallback((id: string, msg: ChatMessage) => {
    setHistory((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), msg] }))
  }, [])

  const appendAssistantToken = useCallback(
    (id: string) => (t: string) => {
      setHistory((prev) => {
        const list = prev[id] ?? []
        const copy = [...list]
        const last = copy[copy.length - 1]
        copy[copy.length - 1] = { ...last, content: last.content + t }
        return { ...prev, [id]: copy }
      })
    },
    [],
  )

  const appendAssistantError = useCallback(
    (id: string) => (msg: string) => {
      setHistory((prev) => {
        const list = prev[id] ?? []
        const copy = [...list]
        const last = copy[copy.length - 1]
        copy[copy.length - 1] = { ...last, content: last.content || `[错误] ${msg}` }
        return { ...prev, [id]: copy }
      })
    },
    [],
  )

  const sendText = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming || !active) return
    const id = active.id
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setHistory((prev) => ({ ...prev, [id]: next }))
    setInput('')
    setStreaming(true)
    push(id, { role: 'assistant', content: '' })
    await streamSSE(
      '/api/chat',
      {
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        character_ids: active.characterIds,
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.chatModel,
      },
      appendAssistantToken(id),
      () => setStreaming(false),
      (msg) => {
        appendAssistantError(id)(msg)
        setStreaming(false)
      },
    )
  }, [input, messages, streaming, active, push, config, appendAssistantToken, appendAssistantError])

  const onPickImage = useCallback(
    async (file: File) => {
      if (streaming || !active) return
      const id = active.id
      const dataUrl = await fileToDataUrl(file)
      const base64 = dataUrl.split(',')[1]
      const mime = file.type || 'image/png'
      const prompt = '（这是一张发给你的图片）请看图回答。'
      const userMsg: ChatMessage = { role: 'user', content: prompt, image: dataUrl }
      const next = [...messages, userMsg]
      setHistory((prev) => ({ ...prev, [id]: next }))
      setStreaming(true)
      push(id, { role: 'assistant', content: '' })
      await streamSSE(
        '/api/images/chat',
        { image_base64: base64, mime, prompt, character_ids: active.characterIds, base_url: config.baseUrl, api_key: config.apiKey, model: config.visionModel },
        appendAssistantToken(id),
        () => setStreaming(false),
        (msg) => {
          appendAssistantError(id)(msg)
          setStreaming(false)
        },
      )
    },
    [messages, streaming, active, push, config, appendAssistantToken, appendAssistantError],
  )

  const onImport = useCallback((name: string) => {
    const imported: ChatSession = { id: `imported-${Date.now()}`, kind: 'imported', name, emoji: '🎴', subtitle: '导入角色卡（解析待阶段 2）', characterIds: [] }
    setSessionsExtra((prev) => [...prev, imported])
    setActiveId(imported.id)
  }, [])

  const [sessionsExtra, setSessionsExtra] = useState<ChatSession[]>([])
  const allSessions = [...sessions, ...sessionsExtra]

  const suggestions = active ? suggestionsFor(active) : []

  if (!active) return null

  return (
    <div className="flex h-full">
      {/* 左：最近聊天 / 会话列表 */}
      <aside className="w-[230px] shrink-0 border-r border-[var(--border)] bg-[var(--surface)]">
        <SessionList sessions={allSessions} activeId={active.id} onSelect={setActiveId} onImport={onImport} />
      </aside>

      {/* 中：对话框 */}
      <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg-soft)]">
        {/* 顶部：小糖人缩略头像，点击进个人介绍 */}
        <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
          {active.characterIds.length > 0 ? (
            active.characterIds.map((cid) => {
              const c = characters.find((x) => x.id === cid)
              if (!c) return null
              return (
                <button
                  key={cid}
                  onClick={() => onOpenProfile(cid)}
                  className="group flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-1 pr-3 transition hover:border-[var(--pink)]"
                  title={`查看 ${c.name} 的个人介绍`}
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[13px]">{c.emoji}</span>
                  <span className="text-[12px] text-[var(--text-2)] group-hover:text-[var(--pink-deep)]">{c.name}</span>
                </button>
              )
            })
          ) : (
            <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-1 pr-3 text-[12px] text-[var(--text-2)]">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[13px]">🎴</span>
              {active.name}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[12px] text-[var(--text-3)]">{active.subtitle}</span>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-1 text-[12px] text-[var(--text-2)] hover:border-[var(--pink)]"
            >
              ⚙ 模型设置
            </button>
          </span>
        </header>

        {showSettings && (
          <div className="border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
            <div className="eyebrow mb-1.5">模型来源（存入本地浏览器，不下发）</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <Field label="Base URL（OpenAI 兼容 /v1）">
                <input className="input" value={config.baseUrl} onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
              </Field>
              <Field label="API Key">
                <input className="input" type="password" value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} placeholder="sk-..." />
              </Field>
              <Field label="聊天模型（chat）">
                <input className="input" value={config.chatModel} onChange={(e) => setConfig({ ...config, chatModel: e.target.value })} placeholder="gpt-4o-mini" />
              </Field>
              <Field label="看图模型（vision）">
                <input className="input" value={config.visionModel} onChange={(e) => setConfig({ ...config, visionModel: e.target.value })} placeholder="gpt-4o-mini" />
              </Field>
            </div>
            <div className="mt-2 flex justify-end">
              <button
                onClick={() => {
                  saveConfig(config)
                  setShowSettings(false)
                }}
                className="btn sm mr-2"
              >
                保存并关闭
              </button>
            </div>
          </div>
        )}

        {/* 消息流 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--text-3)]">
              <div className="rounded-full bg-[var(--pink-soft)] px-3 py-1 text-[var(--pink-deep)]">
                {active.kind === 'group' ? '🏠' : active.characterIds[0] ? characters.find((c) => c.id === active.characterIds[0])?.emoji : '🎴'}
              </div>
              和 {active.kind === 'group' ? '大家' : active.name} 说点什么吧（先点 ⚙ 填好模型）
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[72%] rounded-2xl px-4 py-2 text-[15px] ${
                  m.role === 'user' ? 'bg-[var(--pink)] text-white' : 'bg-[var(--surface)] text-[var(--text)]'
                }`}
              >
                {m.image && <img src={m.image} alt="upload" className="mb-2 max-h-48 rounded-lg" />}
                <div className="whitespace-pre-wrap">{m.content || (streaming && i === messages.length - 1 ? '…' : '')}</div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {/* 推荐回复 + 输入区 */}
        <footer className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <div className="mb-2 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => setInput(s)}
                className="rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-1 text-[12px] text-[var(--text-2)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)]"
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={streaming}
              title="发送图片给小糖人看"
              className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-2)] hover:border-[var(--pink)] disabled:opacity-50"
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
              className="input flex-1 resize-none rounded-xl px-3 py-2 text-[15px] placeholder:text-[var(--text-3)]"
            />
            <button onClick={sendText} disabled={streaming} className="btn rounded-xl px-5 py-2 text-sm disabled:opacity-50">
              发送
            </button>
          </div>
        </footer>
      </section>

      {/* 右：状态栏 */}
      <aside className="w-[240px] shrink-0 border-l border-[var(--border)] bg-[var(--surface)]">
        <StatusSidebar session={active} characters={characters} />
      </aside>
    </div>
  )
}