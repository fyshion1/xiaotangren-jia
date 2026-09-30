import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import type { ChatSession, ChatMessage } from '../data/chats'
import { buildSessions, suggestionsFor } from '../data/chats'
import SessionList from './SessionList'
import StatusSidebar from './StatusSidebar'
import MemoryPanel from './MemoryPanel'
import GalleryPanel from './GalleryPanel'
import { useSpeechToText } from '../hooks/useSpeechToText'
import {
  attachmentStats,
  clearOriginals,
  loadMessages,
  saveMessage,
  toChatMessage,
  uploadAttachment,
  type AttachmentStats,
} from '../api/storage'
import { extractMemories, rememberMemory } from '../api/memory'
import { starImage } from '../api/gallery'
import { fetchImageEngines, selectImageEngine, type ImageEngine } from '../api/imagegen'

export type ModelConfig = {
  baseUrl: string
  apiKey: string
  chatModel: string
  visionModel: string
  imageModel: string
  imageBaseUrl: string
  maxTokens: number // 单条回复 token 上限，0 = 不限制
}

const DEFAULT_CONFIG: ModelConfig = {
  baseUrl: 'https://vsllm.cc/v1',
  apiKey: '',
  chatModel: 'gemini-3.8-flash',
  visionModel: 'gemini-3.8-flash',
  imageModel: '',
  imageBaseUrl: '',
  maxTokens: 800,
}

// 群聊回复里常见的人名带 * 或【】的段落标志
const NAME_MARKER = /^\s*(\*\*([^*\n]+?)\*\*|【([^】\n]+?)】)\s*[:：]?/

const STORAGE_KEY = 'xiaotangren.config'

// 每页条数（§15.2：启动预载最近 30 条，向上滚再按游标拉）
const PAGE_SIZE = 30

function loadConfig(): ModelConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const prev = JSON.parse(raw)
      // 旧中转（moyuu）已废弃：本地若还存着旧来源/旧模型，整体作废回默认，
      // apiKey 留空 = 走服务端 .env 里的 key，避免旧 key / 旧模型让识图一直失败。
      const stale =
        (prev.baseUrl && prev.baseUrl.includes('moyuu')) ||
        prev.chatModel === 'gemini-3.6-flash' ||
        prev.visionModel === 'gemini-3.1-flash-image'
      if (stale) return DEFAULT_CONFIG
      return { ...DEFAULT_CONFIG, ...prev }
    }
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
        let payload: { text?: string; message?: string }
        try {
          payload = JSON.parse(dataLine.slice(5).trim())
        } catch {
          continue
        }
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

// ---- 平滑流式：把后端按「块」吐字缓存下来，再按固定节拍逐字/双字渲染，做出「流水」打字机 ----
function createSmartStream(onChunk: (t: string) => void, emitEveryMs = 24) {
  const chars: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const pump = () => {
    timer = null
    if (!chars.length) return
    // 积压多时每拍吐 2 字、少时 1 字，节奏稳定又不拖尾太多
    const n = chars.length >= 6 ? 2 : 1
    const piece = chars.splice(0, n).join('')
    onChunk(piece)
    if (chars.length) timer = setTimeout(pump, emitEveryMs)
  }
  return {
    push(t: string) {
      for (const c of Array.from(t)) chars.push(c)
      if (!timer) timer = setTimeout(pump, 0)
    },
    finish() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (chars.length) onChunk(chars.splice(0).join(''))
    },
    dispose() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      chars.length = 0
    },
  }
}

// 消息旁的「记住这条」：点了写进长期记忆（§9.3），成功后标灰。
function RememberButton({ done, onClick }: { done: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={done}
      title={done ? '已经记住了' : '把这条存进长期记忆'}
      className={`text-[11px] transition ${
        done ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)] hover:text-[var(--pink-deep)]'
      }`}
    >
      {done ? '🧠 已记住' : '🧠 记住'}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-0.5 block">{label}</span>
      {children}
    </label>
  )
}

// 群聊回复「一人分饰多角」：按 **角色名** /【角色名】拆成多段，各自分卡片播报。
function segmentGroupReply(full: string): { segments: { speaker: string; text: string }[]; plain: string } {
  const lines = full.split('\n')
  const segments: { speaker: string; text: string }[] = []
  let cur: { speaker: string; text: string } | null = null
  const preamble: string[] = []
  let started = false
  for (const line of lines) {
    const m = line.match(NAME_MARKER)
    if (m) {
      const name = (m[2] || m[3] || '').trim()
      if (name) {
        if (cur && cur.text.trim()) segments.push(cur)
        cur = { speaker: name, text: line.slice(m[0].length) }
        started = true
        continue
      }
    }
    if (!started) preamble.push(line)
    else if (cur) cur.text += (cur.text ? '\n' : '') + line
  }
  if (cur && cur.text.trim()) segments.push(cur)
  // 没拆出多段（私聊/未按格式）→ 整段原文，speaker 空
  if (segments.length === 0) {
    const t = full.trim()
    return { segments: t ? [{ speaker: '', text: t }] : [], plain: t }
  }
  const plainParts = segments.map((s) => (s.speaker ? `${s.speaker}：${s.text}` : s.text))
  const plain = preamble.join('\n') + (preamble.length ? '\n' : '') + plainParts.join('\n')
  return { segments, plain }
}

type Props = {
  characters: CharacterProfile[]
  initialSessionId?: string
  onOpenProfile: (charId: string) => void
}

type VoiceOption = { id: string; name: string }
type EngineOption = { id: string; name: string; desc?: string; available: boolean }
type GenImage = { url?: string; b64?: string }

export default function ChatView({ characters, initialSessionId, onOpenProfile }: Props) {
  const sessions = useMemo(() => buildSessions(characters), [characters])
  const [activeId, setActiveId] = useState<string>(initialSessionId ?? sessions[0]?.id ?? 'group')
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]

  const [history, setHistory] = useState<Record<string, ChatMessage[]>>({})
  // 每条消息的错误态（流被掐断 / 上游报错），单独展示而不是塞进正文
  const [msgError, setMsgError] = useState<Record<string, string>>({})
  const messages = active ? history[active.id] ?? [] : []

  // ---- 持久化（§15）：文本落库 + 附件落盘；启动只载最近 30 条，向上滚再按游标拉 ----
  const loadedRef = useRef<Set<string>>(new Set())
  const [paging, setPaging] = useState<Record<string, { cursor: number | null; hasMore: boolean }>>({})
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [stats, setStats] = useState<AttachmentStats | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [config, setConfig] = useState<ModelConfig>(loadConfig)
  const [showSettings, setShowSettings] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [errorText, setErrorText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 语音识别（ASR）：浏览器 Web Speech API 占位，识到的字实时/最终写入输入框
  const asr = useSpeechToText()
  const [interim, setInterim] = useState('')
  useEffect(() => {
    if (asr.listening) setInput((v) => (v ? `${v} ${interim}` : interim))
    // 只在 interim 变化时同步，避免把用户正在打的字吞掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interim])

  // 语音：先选引擎、后选音色；单一音频控制器 + 令牌防竞态 + 显式停止
  const [engines, setEngines] = useState<EngineOption[]>([])
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [voicesOpen, setVoicesOpen] = useState(false)
  const [speakEngine, setSpeakEngine] = useState('edge')
  const [speakVoice, setSpeakVoice] = useState('zh-CN-XiaoxiaoNeural')
  const [autoSpeak, setAutoSpeak] = useState(false)
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playTokenRef = useRef(0)

  // 生图
  const [genOpen, setGenOpen] = useState(false)
  const [genPrompt, setGenPrompt] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genImages, setGenImages] = useState<GenImage[]>([])
  // 生图方式切换器（§7）：默认腾讯云占位；仅第三方 API 现在就接得通
  const [enginesList, setEnginesList] = useState<ImageEngine[]>([])
  const [genEngine, setGenEngine] = useState('tencent')

  // 记忆（§9.2/§9.3）：管理浮层 + 消息旁的「记住这条」快捷按钮
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [remembered, setRemembered] = useState<Record<string, true>>({})
  const [rememberMsg, setRememberMsg] = useState('')
  // 自动记忆（§9.3）：一条回复结束后规则预筛 + LLM 提炼；提炼到的条数做轻提示
  const [autoMemory, setAutoMemory] = useState(true)
  const [autoMsg, setAutoMsg] = useState('')
  // 画廊 + 照片记忆（§9.4）：图片气泡的「⭐ 存入画廊」与管理浮层
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [starred, setStarred] = useState<Record<string, true>>({})
  const [starring, setStarring] = useState('')

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 打开生图浮层时刷新一次本地存储统计（原图/缩略图各占多少）
  useEffect(() => {
    if (!genOpen) return
    void attachmentStats().then(setStats)
  }, [genOpen])

  // 打开生图浮层时拉一次生图方式列表（§7）；后端没起来就用内置表兜底
  useEffect(() => {
    if (!genOpen) return
    void fetchImageEngines().then(({ engines, selected }) => {
      setEnginesList(engines)
      setGenEngine(selected)
    })
  }, [genOpen])

  // 看原图浮层：Esc 关闭
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  // 切换会话时首次载入最近 30 条（已载过则不重复拉，避免覆盖正在播的流）
  useEffect(() => {
    if (!active || loadedRef.current.has(active.id)) return
    loadedRef.current.add(active.id)
    let cancelled = false
    loadMessages(active.id, undefined, PAGE_SIZE).then((page) => {
      if (cancelled) return
      setHistory((prev) => ({ ...prev, [active.id]: page.items.map(toChatMessage) }))
      setPaging((prev) => ({ ...prev, [active.id]: { cursor: page.next_cursor, hasMore: page.has_more } }))
    })
    return () => {
      cancelled = true
    }
  }, [active])

  // 向上滚到顶 → 按游标拉更早的一页，插到最前面（不跳视口）
  const onScrollMessages = useCallback(
    async (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      if (el.scrollTop > 40 || loadingOlder) return
      const page = active ? paging[active.id] : undefined
      if (!active || !page?.hasMore || !page.cursor) return
      setLoadingOlder(true)
      const prevHeight = el.scrollHeight
      const older = await loadMessages(active.id, page.cursor, PAGE_SIZE)
      setHistory((prev) => ({ ...prev, [active.id]: [...older.items.map(toChatMessage), ...(prev[active.id] ?? [])] }))
      setPaging((prev) => ({ ...prev, [active.id]: { cursor: older.next_cursor, hasMore: older.has_more } }))
      setLoadingOlder(false)
      // 保持视口位置不跳：滚回「原高度 - 新内容补上的高度」
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    },
    [active, paging, loadingOlder],
  )

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

  // 流结束后收尾：把群聊「一人分饰多角」的整段回复按 **名字** 拆成多张卡片，
// content 存拼接后的正文（供朗读），返回收尾后的消息（供落库）。私聊/未拆多段则原样。
  const finalizeAssistant = useCallback((id: string, full: string, isGroup: boolean): ChatMessage => {
    const { segments, plain } = segmentGroupReply(full)
    const multi = isGroup && segments.length > 1
    const finalized: ChatMessage = {
      role: 'assistant',
      content: plain,
      kind: multi ? 'groups' : 'text',
      segments: multi ? segments : undefined,
    }
    setHistory((prev) => {
      const list = prev[id] ?? []
      if (!list.length) return { ...prev, [id]: [finalized] }
      const copy = [...list]
      const last = copy[copy.length - 1]
      copy[copy.length - 1] = { ...finalized, content: plain || last.content }
      return { ...prev, [id]: copy }
    })
    return finalized
  }, [])

  // 收尾后落库（§15）：一条 assistant 消息 = 一条记录，分段以 JSON 存 kind/segments
  const persistLast = useCallback((id: string, msg: ChatMessage) => {
    if (!msg.content.trim() && !msg.segments?.length) return
    void saveMessage(id, msg)
  }, [])

  const appendAssistantError = useCallback(
    (id: string) => (msg: string) => {
      setHistory((prev) => {
        const list = prev[id] ?? []
        const copy = [...list]
        const last = copy[copy.length - 1]
        copy[copy.length - 1] = { ...last, content: last.content || '[模型没有返回内容]' }
        return { ...prev, [id]: copy }
      })
      setMsgError((prev) => ({ ...prev, [id]: msg }))
    },
    [],
  )

  const fetchVoices = useCallback(async (engine: string): Promise<VoiceOption[]> => {
    try {
      const resp = await fetch(`/api/voice/voices?engine=${encodeURIComponent(engine)}`)
      if (resp.ok) return (await resp.json()) as VoiceOption[]
    } catch {
      /* 网络异常返回空 */
    }
    return []
  }, [])

  const loadEngines = useCallback(async () => {
    try {
      const resp = await fetch('/api/voice/engines')
      if (resp.ok) setEngines((await resp.json()) as EngineOption[])
    } catch {
      /* ignore */
    }
  }, [])

  const pickEngine = useCallback(
    async (eid: string) => {
      setSpeakEngine(eid)
      const list = await fetchVoices(eid)
      setVoices(list)
      const def = eid === 'edge' ? 'zh-CN-XiaoxiaoNeural' : eid === 'piper' ? 'zh_CN-huayan-medium' : ''
      setSpeakVoice(list.some((v) => v.id === def) ? def : list[0]?.id ?? '')
    },
    [fetchVoices],
  )

  const openVoicePicker = useCallback(async () => {
    setVoicesOpen(true)
    loadEngines()
    const list = await fetchVoices(speakEngine)
    setVoices(list)
  }, [loadEngines, fetchVoices, speakEngine])

  const stopSpeak = useCallback(() => {
    playTokenRef.current += 1 // 作废所有在途请求
    const a = audioRef.current
    if (a) {
      a.pause()
      a.currentTime = 0
      a.onended = null
      a.onerror = null
      audioRef.current = null
      try {
        a.src = ''
      } catch {
        /* ignore */
      }
    }
    setPlayingKey(null)
  }, [])

  const speakText = useCallback(
    async (text: string, key: string) => {
      const t = (text || '').trim()
      if (!t) return
      // 点的是正在播的同一条 → 视为「停止」
      if (playingKey === key) {
        stopSpeak()
        return
      }
      stopSpeak() // 停掉上一条 + 作废在途请求
      const token = ++playTokenRef.current
      setPlayingKey(key)
      try {
        const resp = await fetch('/api/voice/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: t, engine: speakEngine, voice: speakVoice }),
        })
        if (token !== playTokenRef.current) return // 已被更新的请求作废
        if (!resp.ok) {
          const d = await resp.json().catch(() => null)
          setErrorText(d?.detail ?? `TTS HTTP ${resp.status}`)
          setPlayingKey(null)
          return
        }
        const blob = await resp.blob()
        if (token !== playTokenRef.current) return
        const url = URL.createObjectURL(blob)
        const a = new Audio(url)
        const cleanup = () => {
          URL.revokeObjectURL(url)
          audioRef.current = null
          setPlayingKey(null)
        }
        a.onended = cleanup
        a.onerror = cleanup
        audioRef.current = a
        await a.play().catch((e) => {
          setErrorText(`播放失败：${e?.message ?? String(e)}`)
          cleanup()
        })
      } catch (e) {
        if (token === playTokenRef.current) {
          setErrorText(e instanceof Error ? e.message : String(e))
          setPlayingKey(null)
        }
      }
    },
    [playingKey, speakEngine, speakVoice, stopSpeak],
  )

  // 自动记忆提炼（§9.3）：一条回复收尾后调一次。后端先做规则预筛（没命中触发词
  // 就不叫 LLM），所以这里的开销大多数时候只是一次本地判断。
  const autoExtract = useCallback(
    async (list: ChatMessage[]) => {
      if (!active) return
      const turns = list.slice(-12).map((m) => ({
        role: m.role,
        content: m.content,
        // 群聊分段时 character_id 留空，后端靠「**名字**：」前缀辨认发言人
        character_id: '',
      }))
      try {
        const res = await extractMemories({
          messages: turns,
          character_ids: active.characterIds,
          session_kind: active.kind === 'single' ? 'single' : 'group',
          base_url: config.baseUrl,
          api_key: config.apiKey,
          model: config.chatModel,
        })
        const saved = res.saved ?? []
        if (saved.length) {
          const names = saved
            .map((s) => (s.bucket === 'home' ? '家记忆' : characters.find((c) => c.id === s.char_id)?.name ?? '个人'))
            .join('、')
          setAutoMsg(`🧠 自动记住了 ${saved.length} 条（${names}）`)
          setTimeout(() => setAutoMsg(''), 6000)
        }
      } catch (e) {
        // 提炼失败不打扰聊天，只在控制台留痕
        console.warn('自动记忆提炼失败：', e)
      }
    },
    [active, characters, config],
  )

  const lastAssistantText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content.trim()) return messages[i].content
    }
    return ''
  }, [messages])

  const sendText = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming || !active) return
    const id = active.id
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setHistory((prev) => ({ ...prev, [id]: next }))
    setMsgError((prev) => ({ ...prev, [id]: '' }))
    setInput('')
    setStreaming(true)
    push(id, { role: 'assistant', content: '' })
    void saveMessage(id, { role: 'user', content: text })

    const acc = { value: '' }
    const q = createSmartStream((t) => {
      acc.value += t
      appendAssistantToken(id)(t)
    })
    await streamSSE(
      '/api/chat',
      {
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        character_ids: active.characterIds,
        base_url: config.baseUrl,
        api_key: config.apiKey,
        model: config.chatModel,
        max_tokens: config.maxTokens || null,
      },
      (t) => q.push(t),
      () => {
        q.finish()
        setStreaming(false)
        const plain = finalizeAssistant(id, acc.value, active.kind === 'group')
        persistLast(id, plain)
        if (autoSpeak && plain.content.trim()) speakText(plain.content, `${id}:auto`)
        if (autoMemory) void autoExtract([...next, plain])
      },
      (msg) => {
        q.dispose()
        appendAssistantError(id)(msg)
        setErrorText(msg)
        setStreaming(false)
      },
    )
  }, [
    input,
    messages,
    streaming,
    active,
    push,
    config,
    autoSpeak,
    autoMemory,
    autoExtract,
    appendAssistantToken,
    appendAssistantError,
    speakText,
    finalizeAssistant,
    persistLast,
  ])

  const onPickImage = useCallback(
    async (file: File) => {
      if (streaming || !active) return
      const id = active.id
      const dataUrl = await fileToDataUrl(file)
      const base64 = dataUrl.split(',')[1]
      const mime = file.type || 'image/png'
      const prompt = '（这是一张发给你的图片）请看图回答。'
      // 先落盘拿引用（§15.1），失败才降级用 dataURL 直接显示
      const att = await uploadAttachment(id, dataUrl, 'upload')
      const userMsg: ChatMessage = {
        role: 'user',
        content: prompt,
        image: att?.thumb ?? dataUrl,
        imageOrig: att?.orig ?? dataUrl,
        imageSource: 'upload',
      }
      const next = [...messages, userMsg]
      setHistory((prev) => ({ ...prev, [id]: next }))
      setMsgError((prev) => ({ ...prev, [id]: '' }))
      setStreaming(true)
      push(id, { role: 'assistant', content: '' })
      void saveMessage(id, userMsg)

      const acc = { value: '' }
      const q = createSmartStream((t) => {
        acc.value += t
        appendAssistantToken(id)(t)
      })
      await streamSSE(
        '/api/images/chat',
        {
          image_base64: base64,
          mime,
          prompt,
          character_ids: active.characterIds,
          base_url: config.baseUrl,
          api_key: config.apiKey,
          model: config.visionModel,
        },
        (t) => q.push(t),
        () => {
          q.finish()
          setStreaming(false)
          const plain = finalizeAssistant(id, acc.value, active.kind === 'group')
          persistLast(id, plain)
          if (autoSpeak && plain.content.trim()) speakText(plain.content, `${id}:auto`)
          if (autoMemory) void autoExtract([...next, plain])
        },
        (msg) => {
          q.dispose()
          appendAssistantError(id)(msg)
          setErrorText(msg)
          setStreaming(false)
        },
      )
    },
    [messages, streaming, active, push, config, autoSpeak, autoMemory, autoExtract, appendAssistantToken, appendAssistantError, speakText, finalizeAssistant, persistLast],
  )

  const onImport = useCallback((name: string) => {
    const imported: ChatSession = {
      id: `imported-${Date.now()}`,
      kind: 'imported',
      name,
      emoji: '🎴',
      subtitle: '导入角色卡（解析待阶段 2）',
      characterIds: [],
    }
    setSessionsExtra((prev) => [...prev, imported])
    setActiveId(imported.id)
  }, [])

  const doGenerate = useCallback(async () => {
    const prompt = genPrompt.trim()
    if (!prompt || genBusy) return
    setGenBusy(true)
    setGenImages([])
    setErrorText('')
    try {
      const resp = await fetch('/api/images/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          base_url: config.imageBaseUrl || (config.imageModel ? config.baseUrl : ''),
          api_key: config.apiKey,
          model: config.imageModel,
        }),
      })
      const data = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(data?.detail ?? `生图 HTTP ${resp.status}`)
      const imgs = (data?.images ?? []) as GenImage[]
      if (!imgs.length) throw new Error('生图接口返回为空')
      setGenImages(imgs)
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e))
    } finally {
      setGenBusy(false)
    }
  }, [genPrompt, genBusy, config])

  // 「记住这条」（§9.3 手动记忆）：桶由会话类型决定 —— 私聊进 TA 的个人记忆，群聊进家记忆。
  const rememberThis = useCallback(
    async (key: string, content: string) => {
      const text = (content || '').trim()
      if (!text || !active) return
      setRememberMsg('')
      try {
        await rememberMemory({
          text,
          session_kind: active.kind === 'single' ? 'single' : 'group',
          character_ids: active.characterIds,
        })
        setRemembered((prev) => ({ ...prev, [key]: true }))
      } catch (e) {
        // 409 = 已经记过同样的内容；后端去重是按「同一桶 + 同一内容」，这里也照此标灰
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('重复') || msg.includes('已存在')) {
          setRemembered((prev) => ({ ...prev, [key]: true }))
        } else {
          setRememberMsg(msg)
        }
      }
    },
    [active],
  )

  // 「⭐ 存入画廊」（§9.4）：把图片收进画廊；描述留空，等用户或 vision 模型补，
  // 补好描述后才会作为照片记忆进 §9.2 的检索。
  const starThis = useCallback(
    async (key: string, m: ChatMessage) => {
      const orig = m.imageOrig || m.image
      if (!orig || !active) return
      setStarring(key)
      setErrorText('')
      try {
        await starImage({
          orig,
          session_id: active.id,
          message_id: String(m.seq ?? ''),
          in_memory: true,
        })
        setStarred((prev) => ({ ...prev, [key]: true }))
        setGalleryOpen(true) // 顺手打开画廊，提示补一句描述
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e))
      } finally {
        setStarring('')
      }
    },
    [active],
  )

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
          <span className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setAutoMemory((v) => !v)}
              className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                autoMemory
                  ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                  : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-3)]'
              }`}
              title="自动记忆：聊到「记得/以后/约定」这类长期信息时自动提炼进记忆"
            >
              {autoMemory ? '🪄 自动记忆' : '🪄 自动记忆 关'}
            </button>
            <button
              onClick={() => setGalleryOpen(true)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--text-2)] hover:border-[var(--pink)]"
              title="画廊：你主动收藏的重要图片（§9.4）"
            >
              🖼 画廊
            </button>
            <button
              onClick={() => setMemoryOpen(true)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--text-2)] hover:border-[var(--pink)]"
              title="记忆：家记忆 / 各人的个人记忆"
            >
              🧠 记忆
            </button>
            <button
              onClick={() => setGenOpen(true)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--text-2)] hover:border-[var(--pink)]"
              title="生成照片"
            >
              🎨 生成
            </button>
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
              <Field label="API Key（点右侧眼睛看明文）">
                <div className="flex items-center gap-1">
                  <input
                    className="input"
                    type={showKey ? 'text' : 'password'}
                    value={config.apiKey}
                    onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                    placeholder="留空 = 用服务端 .env 里的 key"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    title={showKey ? '隐藏' : '显示明文'}
                    className="shrink-0 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-2 py-1.5 text-[13px] text-[var(--text-2)] hover:border-[var(--pink)]"
                  >
                    {showKey ? '🙈' : '👁'}
                  </button>
                </div>
              </Field>
              <Field label="聊天模型（chat）">
                <input className="input" value={config.chatModel} onChange={(e) => setConfig({ ...config, chatModel: e.target.value })} placeholder="gpt-4o-mini" />
              </Field>
              <Field label="看图模型（vision）">
                <input className="input" value={config.visionModel} onChange={(e) => setConfig({ ...config, visionModel: e.target.value })} placeholder="gpt-4o-mini" />
              </Field>
              <Field label="生图模型（image，留空 = 未配置）">
                <input className="input" value={config.imageModel} onChange={(e) => setConfig({ ...config, imageModel: e.target.value })} placeholder="如 flux / dall-e-3" />
              </Field>
              <Field label="生图地址（留空 = 同 Base URL）">
                <input className="input" value={config.imageBaseUrl} onChange={(e) => setConfig({ ...config, imageBaseUrl: e.target.value })} placeholder="https://xxx/v1" />
              </Field>
              <Field label="单条回复最高 token（0 = 不限制）">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={64}
                  value={config.maxTokens}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    setConfig({ ...config, maxTokens: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0 })
                  }}
                  placeholder="800"
                />
              </Field>
              <div className="text-[11px] leading-snug text-[var(--text-3)] md:col-span-2">
                限制模型单次最多回复多少 token，可让群聊各位都别一回一大段；0 = 不设上限。
              </div>
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

        {/* 错误横幅：模型没反应 / 上游报错时，直接显示原因，方便排查 */}
        {errorText && (
          <div className="mx-4 mt-2 flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--pink)_45%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
            <span className="mt-0.5">⚠</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{errorText}</span>
            <button onClick={() => setErrorText('')} className="shrink-0 opacity-70 hover:opacity-100" title="关闭">
              ✕
            </button>
          </div>
        )}

        {/* 记记忆失败时的轻提示（成功不用打扰） */}
        {rememberMsg && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[12px] text-[var(--text-2)]">
            <span>⚠ 记不住这条：{rememberMsg}</span>
            <button onClick={() => setRememberMsg('')} className="ml-auto opacity-70 hover:opacity-100">
              ✕
            </button>
          </div>
        )}

        {/* 自动记忆提炼的轻提示（§9.3）：成功不打扰，只在提炼到东西时冒一下 */}
        {autoMsg && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-1.5 text-[12px] text-[var(--pink-deep)]">
            <span className="min-w-0 flex-1 truncate">{autoMsg}</span>
            <button onClick={() => setAutoMsg('')} className="shrink-0 opacity-70 hover:opacity-100">
              ✕
            </button>
          </div>
        )}

        {/* 消息流 */}
        <div className="flex-1 overflow-y-auto px-5 py-4" onScroll={onScrollMessages}>
          {loadingOlder && <div className="mb-2 text-center text-[12px] text-[var(--text-3)]">加载更早的消息…</div>}
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--text-3)]">
              <div className="rounded-full bg-[var(--pink-soft)] px-3 py-1 text-[var(--pink-deep)]">
                {active.kind === 'group' ? '🏠' : active.characterIds[0] ? characters.find((c) => c.id === active.characterIds[0])?.emoji : '🎴'}
              </div>
              和 {active.kind === 'group' ? '大家' : active.name} 说点什么吧（先点 ⚙ 填好模型）
            </div>
          )}
          {messages.map((m, i) => {
            const err = msgError[active.id]
            const isLast = i === messages.length - 1
            const segs = m.kind === 'groups' && m.segments?.length ? m.segments : null
            return (
              <div key={i} className={`mb-3 flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                {segs ? (
                  segs.map((s, si) => {
                    const segKey = `${active.id}:${i}:${si}`
                    const segText = s.speaker ? `${s.speaker}：${s.text}` : s.text
                    return (
                      <div
                        key={si}
                        className="mb-2 max-w-[72%] rounded-2xl bg-[var(--surface)] px-4 py-2 text-[15px] text-[var(--text)]"
                      >
                        {s.speaker && (
                          <div className="mb-1 flex items-center gap-1.5">
                            <span
                              className="rounded-full px-2 py-0.5 text-[11px] text-white"
                              style={{ background: 'var(--pink-deep)' }}
                            >
                              {s.speaker}
                            </span>
                          </div>
                        )}
                        <div className="whitespace-pre-wrap">{s.text}</div>
                        {m.role === 'assistant' && s.text.trim() && (
                          <div className="mt-1 flex items-center gap-2">
                            <button
                              onClick={() => speakText(segText, segKey)}
                              className={`text-[11px] transition hover:text-[var(--pink-deep)] ${
                                playingKey === segKey ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'
                              }`}
                              title="朗读 / 停止这一段"
                            >
                              {playingKey === segKey ? '⏹ 停止' : '🔈 朗读'}
                            </button>
                            <RememberButton
                              done={Boolean(remembered[segKey])}
                              onClick={() => void rememberThis(segKey, segText)}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div
                    className={`max-w-[72%] rounded-2xl px-4 py-2 text-[15px] ${
                      m.role === 'user' ? 'bg-[var(--pink)] text-white' : 'bg-[var(--surface)] text-[var(--text)]'
                    }`}
                  >
                    {m.image && (
                      <div className="relative mb-2 block w-max">
                        <button
                          type="button"
                          onClick={() => m.imageOrig && setLightbox(m.imageOrig)}
                          title={m.imageOrig ? '点开看原图' : '原图已清理，仅存缩略图'}
                        >
                          <img src={m.image} alt="图片" className="max-h-48 rounded-lg" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void starThis(`${active.id}:${i}`, m)}
                          disabled={starred[`${active.id}:${i}`] || starring === `${active.id}:${i}`}
                          title="存入画廊"
                          className={`absolute right-1 top-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]/85 px-1 py-0.5 text-[10px] leading-tight shadow backdrop-blur transition ${
                            starred[`${active.id}:${i}`]
                              ? 'border-[var(--pink)] text-[var(--pink-deep)]'
                              : 'text-[var(--text-3)] hover:border-[var(--pink)] hover:text-[var(--pink-deep)]'
                          }`}
                        >
                          ⭐
                        </button>
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{m.content || (streaming && isLast ? '…' : '')}</div>
                    {m.role === 'assistant' && m.content.trim() && (
                      <div className="mt-1 flex items-center gap-2">
                        <button
                          onClick={() => speakText(m.content, `${active.id}:${i}`)}
                          className={`text-[11px] transition hover:text-[var(--pink-deep)] ${
                            playingKey === `${active.id}:${i}` ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'
                          }`}
                          title="朗读 / 停止这条回复"
                        >
                          {playingKey === `${active.id}:${i}` ? '⏹ 停止' : '🔈 朗读'}
                        </button>
                        <RememberButton
                          done={Boolean(remembered[`${active.id}:${i}`])}
                          onClick={() => void rememberThis(`${active.id}:${i}`, m.content)}
                        />
                      </div>
                    )}
                  </div>
                )}
                {m.role === 'assistant' && isLast && err && (
                  <div className="mt-1.5 max-w-[72%] rounded-lg bg-[var(--pink-deep)]/10 px-2.5 py-1.5 text-[12px] leading-snug text-[var(--pink-deep)]">
                    ⚠ {err}
                  </div>
                )}
              </div>
            )
          })}
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
            <button
              onClick={() => setAutoSpeak((v) => !v)}
              title="开启后：每条回复自动朗读（用右栏 🔊 切换音色）"
              className={`rounded-xl border px-3 py-2 text-sm transition disabled:opacity-50 ${
                autoSpeak ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]' : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-2)] hover:border-[var(--pink)]'
              }`}
            >
              🎙
            </button>
            {asr.available && (
              <button
                onClick={() => {
                  if (asr.listening) asr.stop()
                  else {
                    setInterim('')
                    asr.start((t) => setInterim(t), (t) => setInput((v) => (v ? `${v}${t}` : t)), (m) => setErrorText(m))
                  }
                }}
                title="按住说的话：语音转文字（浏览器 Web Speech）"
                className={`rounded-xl border px-3 py-2 text-sm transition ${
                  asr.listening ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]' : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-2)] hover:border-[var(--pink)]'
                }`}
              >
                {asr.listening ? '● 停止听' : '🎤'}
              </button>
            )}
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
        <StatusSidebar
          session={active}
          characters={characters}
          autoSpeak={autoSpeak}
          voiceName={engines.find((e) => e.id === speakEngine)?.name ?? '晓晓'}
          speaking={playingKey !== null}
          onToggleAutoSpeak={() => setAutoSpeak((v) => !v)}
          onSpeak={() => {
            if (lastAssistantText) speakText(lastAssistantText, `${active.id}:last`)
            else setErrorText('还没有可朗读的回复')
          }}
          onStop={() => stopSpeak()}
          onPickVoice={openVoicePicker}
          onGeneratePhoto={() => setGenOpen(true)}
        />
      </aside>

      {/* 音色选择浮层：先选引擎，后选音色 */}
      {voicesOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6 backdrop-blur-sm" onClick={() => setVoicesOpen(false)}>
          <div
            className="mt-16 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[14px] font-bold">语音引擎</span>
              <button onClick={() => setVoicesOpen(false)} className="text-[var(--text-3)] hover:text-[var(--text)]">✕</button>
            </div>

            <div className="mb-3 space-y-1">
              {engines.length === 0 && <p className="py-2 text-[12px] text-[var(--text-3)]">加载引擎中…</p>}
              {engines.map((e) => (
                <button
                  key={e.id}
                  disabled={!e.available}
                  onClick={() => pickEngine(e.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] transition disabled:opacity-40 ${
                    e.id === speakEngine ? 'bg-[var(--pink-soft)] text-[var(--pink-deep)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <span>
                    {e.name}
                    {!e.available && <span className="ml-1.5 text-[11px] text-[var(--text-3)]">（未安装）</span>}
                  </span>
                  {e.id === speakEngine && <span>✓</span>}
                </button>
              ))}
            </div>

            <div className="eyebrow mb-1.5">音色</div>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {voices.length === 0 && (
                <p className="py-2 text-[12px] text-[var(--text-3)]">
                  {speakEngine === 'sovits' ? '尚未安装 GPT-SoVITS，敬请期待' : '该引擎暂无可用音色'}
                </p>
              )}
              {voices.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    setSpeakVoice(v.id)
                    setVoicesOpen(false)
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[13px] transition ${
                    v.id === speakVoice ? 'bg-[var(--pink-soft)] text-[var(--pink-deep)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <span>{v.name}</span>
                  {v.id === speakVoice && <span>✓</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 生图浮层 */}
      {genOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm" onClick={() => !genBusy && setGenOpen(false)}>
          <div
            className="my-6 w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[16px] font-bold">🎨 生成照片</h3>
              <button onClick={() => !genBusy && setGenOpen(false)} className="text-[var(--text-3)] hover:text-[var(--text)]">✕</button>
            </div>

            {/* 生图方式切换器（§7）：腾讯云（默认占位）/ 本地 ComfyUI-SD（占位）/ 第三方 API */}
            <div className="mb-3">
              <span className="eyebrow mb-1.5 block">选生图方式</span>
              <div className="flex flex-wrap gap-1.5">
                {enginesList.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => {
                      setGenEngine(e.id)
                      void selectImageEngine(e.id).catch((err) =>
                        setErrorText(err instanceof Error ? err.message : String(err)),
                      )
                    }}
                    title={e.desc}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                      genEngine === e.id
                        ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                        : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-2)] hover:border-[var(--pink)]'
                    }`}
                  >
                    {e.name}
                    {!e.ready && <span className="ml-1 text-[10px] text-[var(--text-3)]">未接入</span>}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-3)]">
                {enginesList.find((e) => e.id === genEngine)?.desc ?? '生图方式加载中…'}
              </p>
            </div>

            <Field label="画面描述（提示词）">
              <textarea
                className="textarea"
                rows={3}
                value={genPrompt}
                onChange={(e) => setGenPrompt(e.target.value)}
                placeholder="如：大诗音穿着围裙在烘焙坊微笑着递上一块蛋糕…"
              />
            </Field>
            {!config.imageModel && (
              <p className="mt-2 rounded-lg bg-[var(--pink-soft)] px-3 py-2 text-[12px] leading-snug text-[var(--pink-deep)]">
                ⚠ 还没配置生图模型。当前 vsllm 中转没有生图通道 —— 请点 ⚙ 模型设置填一个支持
                /images/generations 的中转地址 + 模型名。
              </p>
            )}
            <div className="mt-3 flex items-center justify-between gap-2.5">
              <span className="text-[11px] leading-snug text-[var(--text-3)]">
                {stats
                  ? `本地：原图 ${(stats.orig_bytes / 1024 / 1024).toFixed(1)} MB · 缩略图 ${(stats.thumb_bytes / 1024).toFixed(0)} KB`
                  : '存储统计加载中…'}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  className="btn ghost sm"
                  disabled={!stats?.orig_bytes}
                  title="清掉本地原图，只留缩略图（省空间；想看高清再重新生成/发送）"
                  onClick={() => void clearOriginals().then(() => attachmentStats().then(setStats))}
                >
                  清理原图
                </button>
                <button className="btn ghost sm" onClick={() => !genBusy && setGenOpen(false)}>取消</button>
                <button className="btn sm" onClick={doGenerate} disabled={genBusy || !genPrompt.trim()}>
                  {genBusy ? '生成中…' : '生成'}
                </button>
              </div>
            </div>
            {genImages.length > 0 && (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {genImages.map((g, i) => (
                  <img
                    key={i}
                    src={g.url ?? (g.b64 ? `data:image/png;base64,${g.b64}` : '')}
                    alt={`生成结果 ${i + 1}`}
                    className="w-full rounded-xl border border-[var(--border)]"
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 记忆浮层（§9.2/§9.3）：家记忆 + 各人的个人记忆，可增可删可重建索引 */}
      {memoryOpen && (
        <MemoryPanel
          characters={characters}
          sessionKind={active.kind === 'single' ? 'single' : 'group'}
          characterIds={active.characterIds}
          onClose={() => setMemoryOpen(false)}
        />
      )}

      {/* 画廊浮层（§9.4）：收藏的图片 + 描述；描述按 A 方案进记忆 */}
      {galleryOpen && (
        <GalleryPanel
          baseUrl={config.baseUrl}
          apiKey={config.apiKey}
          visionModel={config.visionModel}
          onClose={() => setGalleryOpen(false)}
        />
      )}

      {/* 看原图浮层：点击任意处 / Esc 关闭 */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="原图" className="max-h-[88vh] max-w-[88vw] rounded-xl shadow-2xl" />
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-5 top-5 rounded-full bg-white/15 px-3 py-1.5 text-[13px] text-white hover:bg-white/25"
          >
            ✕ 关闭
          </button>
        </div>
      )}
    </div>
  )
}