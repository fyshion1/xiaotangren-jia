import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import type { ChatSession, ChatMessage } from '../data/chats'
import { buildSessions, suggestionsFor } from '../data/chats'
import { activeFormId, listForms } from '../lib/forms'
import SessionList from './SessionList'
import StatusSidebar from './StatusSidebar'
import MemoryPanel from './MemoryPanel'
import GalleryPanel from './GalleryPanel'
import Avatar from './Avatar'
import { useSpeechToText } from '../hooks/useSpeechToText'
import {
  attachmentStats,
  clearOriginals,
  deleteMessages,
  loadMessages,
  previewDeleteMessages,
  saveMessage,
  toChatMessage,
  uploadAttachment,
  type AttachmentStats,
} from '../api/storage'
import { extractMemories, rememberMemory } from '../api/memory'
import { starImage } from '../api/gallery'
import { fetchImageEngines, generateImages, selectImageEngine, type GeneratedImage, type ImageEngine } from '../api/imagegen'
import { buildAppearancePrompt, formKey } from '../lib/comfyPrompt'
import { ownerOf } from '../lib/owner'

// 模型通道（§7）：常规 = 商业 API；无审查 = 另配的中转 / 本地无审查模型。
export type Channel = 'normal' | 'uncensored'

export type ModelConfig = {
  baseUrl: string
  apiKey: string
  chatModel: string
  visionModel: string
  imageModel: string
  imageBaseUrl: string
  maxTokens: number // 单条回复 token 上限，0 = 不限制
  // —— 无审查通道（各自留空 = 沿用上面常规通道的值）——
  channel: Channel
  uncensoredBaseUrl: string
  uncensoredApiKey: string
  uncensoredChatModel: string
  uncensoredVisionModel: string
}

const DEFAULT_CONFIG: ModelConfig = {
  baseUrl: 'https://vsllm.cc/v1',
  apiKey: '',
  chatModel: 'gemini-3.8-flash',
  visionModel: 'gemini-3.8-flash',
  imageModel: '',
  imageBaseUrl: '',
  maxTokens: 800,
  channel: 'normal',
  uncensoredBaseUrl: '',
  uncensoredApiKey: '',
  uncensoredChatModel: '',
  uncensoredVisionModel: '',
}

// 按当前通道解析出实际要打的上游（留空字段回退常规通道）。
export function resolveRoute(c: ModelConfig) {
  const on = c.channel === 'uncensored'
  return {
    chat: {
      baseUrl: (on && c.uncensoredBaseUrl) || c.baseUrl,
      apiKey: (on && c.uncensoredApiKey) || c.apiKey,
      model: (on && c.uncensoredChatModel) || c.chatModel,
    },
    vision: {
      baseUrl: (on && c.uncensoredBaseUrl) || c.baseUrl,
      apiKey: (on && c.uncensoredApiKey) || c.apiKey,
      model: (on && c.uncensoredVisionModel) || c.visionModel,
    },
  }
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
      // 旧中转（moyuu）已废弃：本地若还存着旧来源/旧模型，只把「命中陈旧」的那条通道
      // 清回默认，保留另一条通道已配好的值（否则一刀切回默认会把无审查通道一起吞掉）。
      const staleUrl = (u?: string) => !!u && u.includes('moyuu')
      const staleModel = (m?: string) => m === 'gemini-3.6-flash' || m === 'gemini-3.1-flash-image'
      const cleaned = { ...DEFAULT_CONFIG, ...prev } as ModelConfig
      if (staleUrl(prev.baseUrl) || staleModel(prev.chatModel) || staleModel(prev.visionModel)) {
        // 常规通道命中陈旧 → 清回默认，但保留无审查通道与通道选择
        cleaned.baseUrl = DEFAULT_CONFIG.baseUrl
        cleaned.chatModel = DEFAULT_CONFIG.chatModel
        cleaned.visionModel = DEFAULT_CONFIG.visionModel
        cleaned.imageBaseUrl = ''
        cleaned.imageModel = ''
      }
      if (staleUrl(prev.uncensoredBaseUrl) || staleModel(prev.uncensoredChatModel) || staleModel(prev.uncensoredVisionModel)) {
        cleaned.uncensoredBaseUrl = ''
        cleaned.uncensoredChatModel = ''
        cleaned.uncensoredVisionModel = ''
      }
      return cleaned
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
  /** 切换某角色的形态（§17）：写回后端，全局生效。 */
  onSwitchForm: (charId: string, formId: string) => void
}

type VoiceOption = { id: string; name: string }
type EngineOption = { id: string; name: string; desc?: string; available: boolean }

// 手机端底部 Tab（桌面端不用）
type MobileTab = 'sessions' | 'chat' | 'status'

export default function ChatView({ characters, initialSessionId, onOpenProfile, onSwitchForm }: Props) {
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
  // 当前通道解析出的实际上游（留空字段回退常规通道）——渲染期算一次，各处复用
  const route = resolveRoute(config)
  const [showSettings, setShowSettings] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [showUncensoredKey, setShowUncensoredKey] = useState(false)
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
  const [genImages, setGenImages] = useState<GeneratedImage[]>([])
  // 生图参数：尺寸 / 张数 / 负向 / 步数 / CFG / seed。留空 = 交给工作流自带的值。
  // 张数上限 4 —— ComfyUI 对同一 seed+prompt 返回同一张图，批量得逐个改 seed 重跑（见 services/comfyui.py）。
  const [genSize, setGenSize] = useState('512x768')
  const [genN, setGenN] = useState(1)
  const [genNegative, setGenNegative] = useState('')
  const [genSteps, setGenSteps] = useState('')
  const [genCfg, setGenCfg] = useState('')
  const [genSeed, setGenSeed] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 外观提示词拼装（§7）：从当前形态取外貌词条自动填进提示词框。
  // dirtyKeyRef 是脏跟踪键 `${charId}:${formId}` —— 换角色/换形态才重拼，
  // 否则用户手改的内容会被覆盖（§16.10：兜底要按字段做）。
  const [autoAppend, setAutoAppend] = useState(true)
  const [appearForm, setAppearForm] = useState('')
  const dirtyKeyRef = useRef('')
  const lastAutoRef = useRef('')
  // 生图方式切换器（§7）：四个插槽。默认 local；具体哪个可用由后端探测决定（ready）。
  const [enginesList, setEnginesList] = useState<ImageEngine[]>([])
  const [genEngine, setGenEngine] = useState('local')

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

  // 真删 / QQ 式右键多选（§15.2）：右键菜单 + 多选模式 + 顶部操作条。
  // 只对 user 角色开放（用户原话「删除自己的对话」）；助手回复不提供删除入口。
  const [menu, setMenu] = useState<{ x: number; y: number; seq: number; dbId: string } | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedSeqs, setSelectedSeqs] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)

  // 切会话 / 关掉菜单时的清理
  useEffect(() => {
    setMenu(null)
  }, [activeId])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])
  // 离开多选模式就清空已选（切会话也清）
  useEffect(() => {
    if (!selectMode) setSelectedSeqs(new Set())
  }, [selectMode])
  useEffect(() => {
    setSelectMode(false)
    setSelectedSeqs(new Set())
  }, [activeId])

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

  // 生图浮层打开时，按「在场的第一位角色 + 她的当前形态」拼装外观提示词。
  // 群聊取第一位：真要画别人，改提示词框里的名字比换角色更省事。
  useEffect(() => {
    if (!genOpen || !autoAppend || !active) return
    const char = characters.find((c) => c.id === active.characterIds[0])
    if (!char) {
      setAppearForm('')
      return
    }
    const key = formKey(char.id, activeFormId(char))
    setAppearForm(listForms(char).find((f) => f.id === activeFormId(char))?.name ?? '')
    if (dirtyKeyRef.current === key) return // 键没变 → 用户手改的内容一个字都不动
    const appearance = buildAppearancePrompt(char)
    if (appearance) {
      // 换角色/换形态要重拼，但只在「框里还是上一次自动拼的内容（或空的）」时才覆盖，
      // 用户自己写的东西留着 —— 想回到自动拼的版本可以点「↺ 重置」。
      setGenPrompt((prev) => (prev.trim() && prev !== lastAutoRef.current ? prev : appearance))
      lastAutoRef.current = appearance
    }
    dirtyKeyRef.current = key
  }, [genOpen, autoAppend, active, characters])

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
    if (!active) return
    const sid = active.id
    if (loadedRef.current.has(sid)) return
    loadedRef.current.add(sid)
    // ⚠ 不要在这里用 cancelled 标志丢弃结果：dev 下 React StrictMode 会
    // 「setup→cleanup→setup」，cleanup 会把第一次的 fetch 结果丢掉，而第二次因
    // loadedRef 命中直接 return，导致刷新后历史永远载不出来（§16.9）。
    loadMessages(sid, undefined, PAGE_SIZE).then((page) => {
      const loaded = page.items.map(toChatMessage)
      setHistory((prev) => {
        // 载入期间本地新发、尚未落库的消息（无 seq）保留，别被历史覆盖掉
        const localOnly = (prev[sid] ?? []).filter((m) => m.seq == null)
        return { ...prev, [sid]: [...loaded, ...localOnly] }
      })
      setPaging((prev) => ({ ...prev, [sid]: { cursor: page.next_cursor, hasMore: page.has_more } }))
    })
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
        const route = resolveRoute(config)
        const res = await extractMemories({
          messages: turns,
          character_ids: active.characterIds,
          session_kind: active.kind === 'single' ? 'single' : 'group',
          // 后台提炼跟随当前通道，但不带越狱标志（工具调用，不需要越狱）
          base_url: route.chat.baseUrl,
          api_key: route.chat.apiKey,
          model: route.chat.model,
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
    const route = resolveRoute(config)
    const q = createSmartStream((t) => {
      acc.value += t
      appendAssistantToken(id)(t)
    })
    await streamSSE(
      '/api/chat',
      {
        messages: next.map((m) => ({ role: m.role, content: m.content })),
        character_ids: active.characterIds,
        base_url: route.chat.baseUrl,
        api_key: route.chat.apiKey,
        model: route.chat.model,
        max_tokens: config.maxTokens || null,
        uncensored: config.channel === 'uncensored',
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
      const route = resolveRoute(config)
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
          base_url: route.vision.baseUrl,
          api_key: route.vision.apiKey,
          model: route.vision.model,
          uncensored: config.channel === 'uncensored',
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
    // 数字框留空就别传，让工作流自带的步数/CFG/随机 seed 生效
    const num = (v: string) => (v.trim() ? Number(v) : null)
    try {
      const imgs = await generateImages({
        prompt,
        session_id: active?.id ?? 'single-default', // 落在当前会话的附件目录里
        size: genSize,
        n: genN,
        seed: num(genSeed),
        negative: genNegative.trim(),
        steps: num(genSteps),
        cfg: num(genCfg),
        // thirdparty 才用得上：走「模型设置」里的生图覆盖；其余引擎后端不看这三个字段
        base_url: config.imageBaseUrl || (config.imageModel ? config.baseUrl : ''),
        api_key: config.apiKey,
        model: config.imageModel,
      })
      if (!imgs.length) throw new Error('生图接口返回为空')
      setGenImages(imgs)
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e))
    } finally {
      setGenBusy(false)
    }
  }, [genPrompt, genBusy, active, config, genSize, genN, genSeed, genNegative, genSteps, genCfg])

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
  // 归属：私聊自动归属该角色（ownerOf），群聊 / 导入会话算「家 · 共用」；画廊里可手改。
  // message_id 必须传落库行 id（m.dbId），不能传 seq —— 库里 messages.id 是 'm-<hex>'，
  // 传 seq 会让「删消息 → 级联画廊」这条链断掉（老数据仍按 orig 兜底匹配）。
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
          message_id: m.dbId ?? '',
          owner: ownerOf(active),
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

  // 生图结果「⭐ 存入画廊」：图已经在附件库里了（§7 生图直接落盘），
  // 这里只是把它登记进画廊 / 照片记忆，和聊天图片走的是同一个 starImage。
  const starGenerated = useCallback(
    async (g: GeneratedImage) => {
      if (!active) return
      setErrorText('')
      try {
        await starImage({
          orig: g.orig,
          session_id: active.id,
          message_id: '',
          owner: ownerOf(active),
          in_memory: true,
        })
        setGalleryOpen(true) // 顺手打开画廊，提示补一句描述
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e))
      }
    },
    [active],
  )

  // 真删（§15.2）：先向后台预演一次「会连带走多少」，如实写进确认框，再真删。
  // 只有落库消息（dbId）删得了库；还没落库的临时消息直接本地剔除即可。
  // 图片文件是否真删由后端做「幸存引用」判断，前端只如实告知数量。
  const doDelete = useCallback(
    async (keys: number[]) => {
      if (!active || keys.length === 0) return
      const rows = keys.map((k) => ({ key: k, m: messages[k] })).filter((r) => r.m)
      const ids = rows.map((r) => r.m.dbId).filter((v): v is string => Boolean(v))
      const preview = ids.length ? await previewDeleteMessages(ids) : null
      const extra =
        preview && (preview.images > 0 || preview.gallery > 0)
          ? `\n连带删除：图片 ${preview.images} 张、画廊收藏 ${preview.gallery} 张（含它们的照片记忆）。`
          : ''
      const ok = window.confirm(
        `确认删除这 ${rows.length} 条消息？这是真删，删掉找不回来。${extra}\n（图片若仍被别的消息引用，文件会保留。）`,
      )
      if (!ok) return

      setDeleting(true)
      setErrorText('')
      try {
        if (ids.length) {
          const r = await deleteMessages(ids)
          if (!r) throw new Error('删除失败：后端没响应')
        }
        const dead = new Set(rows.map((r) => r.key))
        setHistory((prev) => ({
          ...prev,
          [active.id]: (prev[active.id] ?? []).filter((_, i) => !dead.has(i)),
        }))
        // ⭐ 是按「会话:下标」记的，删完下标整体前移，整段清掉最稳
        setStarred((prev) => {
          const next: Record<string, true> = {}
          for (const [k, v] of Object.entries(prev)) {
            if (!k.startsWith(`${active.id}:`)) next[k] = v
          }
          return next
        })
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e))
      } finally {
        setDeleting(false)
        setSelectMode(false)
        setSelectedSeqs(new Set())
        setMenu(null)
      }
    },
    [active, messages],
  )

  // 导入的角色卡（阶段 2 才解析）；先挂在会话列表尾部，让 UI 走通
  const [sessionsExtra, setSessionsExtra] = useState<ChatSession[]>([])
  const allSessions = [...sessions, ...sessionsExtra]

  // 手机端当前显示哪一栏（桌面端不生效）
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat')

  const suggestions = active ? suggestionsFor(active) : []

  if (!active) return null

  // 手机端（<768px）三栏放不下 → 底部 Tab 一次只显示一栏；桌面端 md: 依旧三栏并排。
  // 非当前 Tab 的栏用 max-md:hidden 藏起来，桌面端不受影响。
  const tabCls = (tab: MobileTab) => (mobileTab === tab ? '' : 'max-md:hidden')

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* 左：最近聊天 / 会话列表 */}
      <aside
        className={`min-h-0 min-w-0 flex-1 overflow-hidden border-[var(--border)] bg-[var(--surface)] max-md:flex max-md:flex-col md:w-[230px] md:flex-none md:border-r ${tabCls('sessions')}`}
      >
        <SessionList
          sessions={allSessions}
          characters={characters}
          activeId={active.id}
          onSelect={(id) => {
            setActiveId(id)
            setMobileTab('chat') // 手机上选完会话直接跳到聊天
          }}
          onImport={onImport}
        />
      </aside>

      {/* 中：对话框 */}
      <section className={`flex min-w-0 flex-1 flex-col bg-[var(--bg-soft)] ${tabCls('chat')}`}>
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
                  <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={24} className="bg-white" />
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
          {/* 形态切换（§17）：私聊时可直接在聊天头部换她的形态，切换即写回后端、全局生效 */}
          {active.characterIds.length === 1 &&
            (() => {
              const c = characters.find((x) => x.id === active.characterIds[0])
              if (!c) return null
              const forms = listForms(c)
              if (forms.length < 2) return null
              const curId = activeFormId(c)
              return (
                <span className="flex flex-wrap items-center gap-1">
                  {forms.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => onSwitchForm(c.id, f.id)}
                      className={`form-chip ${f.id === curId ? 'on' : ''}`}
                      title={`切换到 ${f.name}`}
                    >
                      {f.id === curId ? `🎀 ${f.name}` : f.name}
                    </button>
                  ))}
                </span>
              )
            })()}
          <span className="ml-auto hidden items-center gap-1.5 md:flex">
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
              onClick={() => setSelectMode((v) => !v)}
              disabled={streaming || !messages.some((m) => m.role === 'user')}
              className={`rounded-lg border px-2.5 py-1 text-[12px] transition disabled:opacity-40 ${
                selectMode
                  ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                  : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-2)] hover:border-[var(--pink)]'
              }`}
              title="多选删除：勾选自己发过的消息，真删（连带图片文件 / 画廊收藏 / 照片记忆）"
            >
              🗑 删除
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
            {/* 通道切换（§7）：常规 = 商业 API；无审查 = 另配的无审查中转/本地模型 */}
            <span className="flex items-center gap-1 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] p-0.5">
              {(['normal', 'uncensored'] as Channel[]).map((ch) => (
                <button
                  key={ch}
                  onClick={() => saveConfig({ ...config, channel: ch })}
                  title={ch === 'normal' ? '常规通道（商业 API）' : '无审查通道（中转 / 本地无审查模型）'}
                  className={
                    'rounded-md px-2 py-0.5 text-[12px] ' +
                    (config.channel === ch
                      ? 'bg-[var(--pink)] text-white'
                      : 'text-[var(--text-2)] hover:bg-[var(--surface)]')
                  }
                >
                  {ch === 'normal' ? '常规' : '🔓 无审查'}
                </button>
              ))}
            </span>
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

            {/* 无审查通道（§7）：与常规通道各自独立；留空字段自动沿用常规通道 */}
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="eyebrow">🔓 无审查通道</span>
                <span className="text-[11px] text-[var(--text-3)]">留空 = 沿用上面常规通道的值</span>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <Field label="Base URL（无审查 · 留空 = 同常规）">
                  <input
                    className="input"
                    value={config.uncensoredBaseUrl}
                    onChange={(e) => setConfig({ ...config, uncensoredBaseUrl: e.target.value })}
                    placeholder="https://xxx/v1（中转 / 本地 Ollama）"
                  />
                </Field>
                <Field label="API Key（无审查 · 留空 = 同常规）">
                  <div className="flex items-center gap-1">
                    <input
                      className="input"
                      type={showUncensoredKey ? 'text' : 'password'}
                      value={config.uncensoredApiKey}
                      onChange={(e) => setConfig({ ...config, uncensoredApiKey: e.target.value })}
                      placeholder="留空 = 用常规通道的 key"
                    />
                    <button
                      type="button"
                      onClick={() => setShowUncensoredKey((v) => !v)}
                      title={showUncensoredKey ? '隐藏' : '显示明文'}
                      className="shrink-0 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-2 py-1.5 text-[13px] text-[var(--text-2)] hover:border-[var(--pink)]"
                    >
                      {showUncensoredKey ? '🙈' : '👁'}
                    </button>
                  </div>
                </Field>
                <Field label="聊天模型（无审查 · 留空 = 同常规）">
                  <input
                    className="input"
                    value={config.uncensoredChatModel}
                    onChange={(e) => setConfig({ ...config, uncensoredChatModel: e.target.value })}
                    placeholder="如 grok-4.7 / 本地 abliterated 模型"
                  />
                </Field>
                <Field label="看图模型（无审查 · 留空 = 同常规）">
                  <input
                    className="input"
                    value={config.uncensoredVisionModel}
                    onChange={(e) => setConfig({ ...config, uncensoredVisionModel: e.target.value })}
                    placeholder="留空 = 同上"
                  />
                </Field>
                <div className="text-[11px] leading-snug text-[var(--text-3)] md:col-span-2">
                  顶部「常规 / 🔓 无审查」切换当前生效的通道。无审查通道可另配第三方无审查中转或本地模型；
                  越狱提示词在右栏「越狱规则」里，无审查通道会额外追加专属预设。
                </div>
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

        {/* 多选删除操作条（§15.2）：勾够了几条就删；取消 / 退出多选都清空已选 */}
        {(selectMode || selectedSeqs.size > 0) && (
          <div className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--pink)] bg-[var(--pink-soft)] px-3 py-1.5 text-[12px] text-[var(--pink-deep)]">
            <span className="font-semibold">
              {selectMode ? `已选 ${selectedSeqs.size} 条` : ''}
            </span>
            <span className="text-[11px] opacity-80">
              在消息上右键可以「删除这条」或进入多选；只有你自己发的消息能删。
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                className="btn sm"
                disabled={selectedSeqs.size === 0 || deleting}
                onClick={() => void doDelete([...selectedSeqs])}
              >
                {deleting ? '删除中…' : '删除'}
              </button>
              <button
                className="btn ghost sm"
                onClick={() => {
                  setSelectMode(false)
                  setSelectedSeqs(new Set())
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* 消息流 */}
        <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5" onScroll={onScrollMessages}>
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
            // 真删只针对用户自己发的、且已落库的消息（§15.2）；助手回复不给入口
            const deletable = m.role === 'user' && Boolean(m.dbId)
            const checked = selectedSeqs.has(i)
            return (
              <div
                key={i}
                onContextMenu={(e) => {
                  if (!deletable || streaming || deleting) return
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, seq: i, dbId: m.dbId ?? '' })
                }}
                className={`mb-3 flex items-end gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'} ${
                  selectMode && checked ? 'rounded-xl bg-[var(--pink-soft)]/60 ring-1 ring-[var(--pink)]' : ''
                }`}
              >
                {selectMode && deletable && (
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setSelectedSeqs((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(i)
                        else next.delete(i)
                        return next
                      })
                    }
                    className="mb-2 shrink-0"
                    title="勾选这条（也可以直接在这条上右键）"
                  />
                )}
                <div className={`flex min-w-0 flex-1 flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                {segs ? (
                  segs.map((s, si) => {
                    const segKey = `${active.id}:${i}:${si}`
                    const segText = s.speaker ? `${s.speaker}：${s.text}` : s.text
                    return (
                      <div
                        key={si}
                        className="mb-2 max-w-[85%] rounded-2xl bg-[var(--surface)] px-4 py-2 text-[15px] text-[var(--text)] sm:max-w-[72%]"
                      >
                        {s.speaker && (
                          <div className="mb-1 flex items-center gap-1.5">
                            {/* 群聊分段说话人：像 QQ 一样「头像 + 名字」。分段只给了名字串，
                                按名字反查角色拿头像；查不到就退回首字圆片（Avatar 自带兜底）。 */}
                            {(() => {
                              const sp = characters.find((c) => c.name === s.speaker)
                              return <Avatar name={s.speaker} avatar={sp?.avatar} emoji={sp?.emoji} size={20} />
                            })()}
                            <span className="text-[12px] font-semibold text-[var(--pink-deep)]">{s.speaker}</span>
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
                  <>
                    {/* QQ 式「头像 + 名字」：私聊的回复标明是谁在说。
                        群聊的非分段回复是「大家一起」，不署名。 */}
                    {m.role === 'assistant' && active.kind === 'single' && (
                      (() => {
                        const c = characters.find((x) => x.id === active.characterIds[0])
                        if (!c) return null
                        return (
                          <div className="mb-1 flex items-center gap-1.5">
                            <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={20} />
                            <span className="text-[12px] font-semibold text-[var(--pink-deep)]">{c.name}</span>
                          </div>
                        )
                      })()
                    )}
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2 text-[15px] sm:max-w-[72%] ${
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
                  </>
                )}
                {m.role === 'assistant' && isLast && err && (
                  <div className="mt-1.5 max-w-[85%] rounded-lg bg-[var(--pink-deep)]/10 px-2.5 py-1.5 text-[12px] leading-snug text-[var(--pink-deep)] sm:max-w-[72%]">
                    ⚠ {err}
                  </div>
                )}
                </div>
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
      <aside
        className={`min-h-0 min-w-0 flex-1 overflow-hidden border-[var(--border)] bg-[var(--surface)] max-md:flex max-md:flex-col md:w-[240px] md:flex-none md:border-l ${tabCls('status')}`}
      >
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

            {/* 生图方式切换器（§7）：本地 ComfyUI / 云端 ComfyUI / 第三方 API / NovelAI（插槽） */}
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
              <div className="flex items-start gap-2">
                <textarea
                  className="textarea flex-1"
                  rows={3}
                  value={genPrompt}
                  onChange={(e) => setGenPrompt(e.target.value)}
                  placeholder="如：大诗音穿着围裙在烘焙坊微笑着递上一块蛋糕…"
                />
                <button
                  type="button"
                  className="btn ghost sm shrink-0"
                  title="按当前角色的形态重设为外貌提示词"
                  disabled={!appearForm || !active}
                  onClick={() => {
                    const char = characters.find((c) => c.id === active?.characterIds[0])
                    if (!char) return
                    const appearance = buildAppearancePrompt(char)
                    if (!appearance) return
                    setGenPrompt(appearance)
                    lastAutoRef.current = appearance
                  }}
                >
                  ↺ 重置
                </button>
              </div>
            </Field>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-2)]">
                <input
                  type="checkbox"
                  checked={autoAppend}
                  onChange={(e) => setAutoAppend(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--pink)]"
                />
                自动拼装外貌
              </label>
              <span className="text-[11px] text-[var(--text-3)]">
                {appearForm ? `按「${appearForm}」的外观` : '当前会话没有可用的角色'}
              </span>
            </div>

            {/* 参数区：尺寸 / 张数常显；负向提示词、步数、CFG、seed 收在「更多」里 */}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-3)]">尺寸</span>
                <select className="input w-auto py-1 text-[12px]" value={genSize} onChange={(e) => setGenSize(e.target.value)}>
                  <option value="512x768">512×768（SD1.5 竖）</option>
                  <option value="768x512">768×512（SD1.5 横）</option>
                  <option value="512x512">512×512（SD1.5 方）</option>
                  <option value="832x1216">832×1216（SDXL 竖）</option>
                  <option value="1216x832">1216×832（SDXL 横）</option>
                  <option value="1024x1024">1024×1024（SDXL 方）</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-3)]">张数</span>
                <input
                  type="number"
                  min={1}
                  max={4}
                  className="input w-[70px] py-1 text-[12px]"
                  value={genN}
                  onChange={(e) => setGenN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                />
              </label>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setShowAdvanced((v) => !v)}
                title="负向提示词 / 步数 / CFG / seed"
              >
                {showAdvanced ? '收起参数 ▴' : '更多参数 ▾'}
              </button>
            </div>

            {showAdvanced && (
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1 sm:col-span-3">
                  <span className="text-[11px] text-[var(--text-3)]">负向提示词（不想出现的）</span>
                  <input
                    className="input py-1 text-[12px]"
                    value={genNegative}
                    onChange={(e) => setGenNegative(e.target.value)}
                    placeholder="如：lowres, bad anatomy, extra fingers"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-[var(--text-3)]">步数（留空=工作流默认）</span>
                  <input
                    type="number"
                    min={1}
                    max={150}
                    className="input py-1 text-[12px]"
                    value={genSteps}
                    onChange={(e) => setGenSteps(e.target.value)}
                    placeholder="25"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-[var(--text-3)]">CFG（留空=工作流默认）</span>
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    className="input py-1 text-[12px]"
                    value={genCfg}
                    onChange={(e) => setGenCfg(e.target.value)}
                    placeholder="7.0"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] text-[var(--text-3)]">seed（留空=随机）</span>
                  <input
                    type="number"
                    className="input py-1 text-[12px]"
                    value={genSeed}
                    onChange={(e) => setGenSeed(e.target.value)}
                    placeholder="随机"
                  />
                </label>
              </div>
            )}

            {genEngine === 'thirdparty' && !config.imageModel && (
              <p className="mt-2 rounded-lg bg-[var(--pink-soft)] px-3 py-2 text-[12px] leading-snug text-[var(--pink-deep)]">
                ⚠ 第三方通道还没配生图模型。请点 ⚙ 模型设置填一个支持 /images/generations
                的中转地址 + 模型名（vsllm 无生图通道）。
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
                {genImages.map((g, i) => {
                  const src = g.orig || g.thumb
                  return (
                    <figure key={g.id || i} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
                      <img
                        src={src}
                        alt={`生成结果 ${i + 1}`}
                        className="w-full cursor-zoom-in"
                        onClick={() => setLightbox(src)}
                      />
                      <figcaption className="flex items-center justify-between gap-2 px-2 py-1.5">
                        <span className="text-[11px] text-[var(--text-3)]">结果 {i + 1}</span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="btn ghost sm"
                            title="下载原图"
                            onClick={() => {
                              const a = document.createElement('a')
                              a.href = src
                              a.download = `xiaotangren-${i + 1}.png`
                              a.click()
                            }}
                          >
                            ⤓
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            title="存入画廊（相册 + 照片记忆）"
                            onClick={() => void starGenerated(g)}
                          >
                            ⭐
                          </button>
                        </div>
                      </figcaption>
                    </figure>
                  )
                })}
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

      {/* 右键菜单（§15.2）：QQ 那样在消息上右键 —— 删除这条 / 进入多选。
          绝对定位在鼠标处，点空白或滚动即关（见上方那对 window 监听）。 */}
      {menu && (
        <div
          className="fixed z-[70] min-w-[132px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full px-3 py-1.5 text-left text-[13px] text-[var(--text)] hover:bg-[var(--pink-soft)] hover:text-[var(--pink-deep)]"
            onClick={() => void doDelete([menu.seq])}
          >
            删除这条
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left text-[13px] text-[var(--text)] hover:bg-[var(--pink-soft)] hover:text-[var(--pink-deep)]"
            onClick={() => {
              setSelectMode(true)
              setSelectedSeqs(new Set([menu.seq]))
              setMenu(null)
            }}
          >
            多选…
          </button>
        </div>
      )}

      {/* 画廊浮层（§9.4）：收藏的图片 + 描述；描述按 A 方案进记忆 */}
      {galleryOpen && (
        <GalleryPanel
          baseUrl={route.vision.baseUrl}
          apiKey={route.vision.apiKey}
          visionModel={route.vision.model}
          uncensored={config.channel === 'uncensored'}
          characters={characters.map((c) => ({ id: c.id, name: c.name }))}
          defaultOwner={ownerOf(active)}
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

      {/* 手机端底部 Tab：一次只显示一栏（会话 / 聊天 / 状态）；桌面端隐藏 */}
      <nav className="flex shrink-0 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden">
        {(
          [
            ['sessions', '💬', '会话'],
            ['chat', '🐾', '聊天'],
            ['status', '📊', '状态'],
          ] as const
        ).map(([tab, icon, label]) => (
          <button
            key={tab}
            onClick={() => setMobileTab(tab)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition ${
              mobileTab === tab ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'
            }`}
          >
            <span className="text-[18px] leading-none">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}