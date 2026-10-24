import { useExpertMode } from '../lib/expertMode'
import NetworkAccess from './NetworkAccess'
import { useTavernMode } from '../lib/tavernMode'
import KnowledgeText from './KnowledgeText'
import {useDesignChoice} from '../visual/designChoices'
import {useDismissableDetails} from '../visual/useDismissableDetails'
import UiIcon from '../visual/UiIcon'
import {available as geminiInstalled} from '#gemini-sync/availability'
import {integrationSessions} from '#gemini-sync/sessions'
import {useOptionalPlugin} from '../plugins/useOptionalPlugin'
import {useComponents} from '../hooks/useComponents'
﻿import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import type { ChatMessage } from '../data/chats'
import { buildSessions, personaSessionId, personasAsCast, MAIN_PERSONA_ID, SELF_CHARACTER_ID } from '../data/chats'
import { activeFormId, listForms } from '../lib/forms'
import SessionList from './SessionList'
import ChatAttachmentImage from './ChatAttachmentImage'
import CardImportDialog from './CardImportDialog'
import CardChatMessage from './CardChatMessage'
import StatusSidebar from './StatusSidebar'
import PortraitCarousel from './PortraitCarousel'
import ImageGenOverlay from './ImageGenOverlay'
import MemoryPanel from './MemoryPanel'
import GalleryPanel from './GalleryPanel'
import GroupRosterPanel from './GroupRosterPanel'
import PromptInspector from './PromptInspector'
import Avatar from './Avatar'
import { useSpeechToText } from '../hooks/useSpeechToText'
import { useResizable } from '../hooks/useResizable'
import {
  analyzeVideo,
  deleteMessages,
  loadMessages,
  previewDeleteMessages,
  saveMessage,
  toChatMessage,
  uploadAttachmentsBatch,
  type StoredMessage,
} from '../api/storage'
import { extractMemories } from '../api/memory'
import { proposeMemory } from '../api/memoryWorkflow'
import { mergeStoredMessages } from '../lib/messageMerge'
import { streamSSE } from '../api/stream'
import { starImage } from '../api/gallery'
import { fetchSettings, saveSettings, fetchNestBrainDefault } from '../api/client'
import { ownerOf } from '../lib/owner'
import VoiceCallPanel from './VoiceCallPanel'
import ToolCenter, { ToolActivity, ToolDialog, ToolEntry } from './ToolCenter'
import type { AgentEvent } from '../api/tools'

// 提示词通道：模型来源始终使用小窝大脑。
export type Channel = 'normal' | 'uncensored'

export type ModelConfig = {
  baseUrl: string
  apiKey: string
  chatModel: string
  visionModel: string
  visionBaseUrl?: string
  visionApiKey?: string
  imageModel: string
  imageBaseUrl: string
  maxTokens: number // 单条回复 token 上限，0 = 不限制
  replyLengthVersion?: number
  // 随请求发给模型的最近消息条数（§27）：0 = 不限制（把已载入的全发过去）。
  // 只截断「发出去的副本」，界面上的聊天记录一条不少。
  historyLimit: number
  // 发图时附在图片前的提示词（§16.11）：留空 = 用 DEFAULT_VISION_PROMPT。
  // 整体存 localStorage（STORAGE_KEY），所以自动持久化。
  visionPrompt?: string
  // —— 无审查通道（各自留空 = 沿用上面常规通道的值）——
  channel: Channel
  uncensoredBaseUrl: string
  uncensoredApiKey: string
  uncensoredChatModel: string
  uncensoredVisionModel: string
}

/** 发图时的默认提示词 —— 也是历史写死的那句，保持兼容。 */
export const DEFAULT_VISION_PROMPT = '（这是一张发给你的图片）请看图回答。'

const DEFAULT_CONFIG: ModelConfig = {
  baseUrl: '',
  apiKey: '',
  chatModel: '',
  visionModel: '',
  imageModel: '',
  imageBaseUrl: '',
  maxTokens: 6000,
  historyLimit: 20,
  visionPrompt: DEFAULT_VISION_PROMPT,
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
      baseUrl: c.visionBaseUrl || c.baseUrl,
      apiKey: c.visionApiKey || c.apiKey,
      model: c.visionModel,
    },
  }
}

// 群聊回复里常见的人名带 * 或【】的段落标志
const NAME_MARKER = /^\s*(\*\*([^*\n]+?)\*\*|【([^】\n]+?)】)\s*[:：]?/

const STORAGE_KEY = 'xiaotangren.config'
// 每页条数（§15.2：启动预载最近 30 条，向上滚再按游标拉）
const PAGE_SIZE = 30

function loadConfig(): ModelConfig {
  // Ignore retired browser API profiles, URLs, keys and model names.
  try {
    const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { ...DEFAULT_CONFIG, channel: previous.channel === 'uncensored' ? 'uncensored' : 'normal' }
  } catch { return { ...DEFAULT_CONFIG } }
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
      title={done ? '已加入待审核' : '补充一条记忆到 03 待审核（聊天会自动归档整理）'}
      className={`text-[11px] transition ${
        done ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)] hover:text-[var(--pink-deep)]'
      }`}
    >
      {done ? '🧠 待审核' : '🧠 收入候选'}
    </button>
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

/**
 * 群聊历史发给模型时的排版（§27）。
 *
 * 库里 `content` 是「大诗音：…」这种**纯名字**加冒号，而提示词要求模型按
 * 「**角色名**：」输出、后端 `_strip_absent_speakers` 也只认这个签名（校验过：
 * 纯名字形式它洗不掉）。所以外发前统一重排成带星号的那种，两头口径一致 ——
 * 模型更容易维持「一人一段」，缺席者的段落后端也真能删掉。
 *
 * 私聊、以及没拆出分段的普通消息，原样发。
 */
function outboundText(m: ChatMessage): string {
  const segs = m.kind === 'groups' && m.segments?.length ? m.segments : null
  if (!segs) return m.content
  return segs.map((s) => (s.speaker ? `**${s.speaker}**：${s.text}` : s.text)).join('\n\n')
}

/** 外发历史只带最近 N 条（§27）。0 / 负数 = 不限制，把已载入的全发过去。 */
function limitHistory(list: ChatMessage[], limit: number): ChatMessage[] {
  if (!limit || limit <= 0) return list
  return list.length > limit ? list.slice(-limit) : list
}

/**
 * 「不在场」的人，她在群聊里的旧发言不渲染（§27）。
 *
 * 跟后端那份清洗是两码事：后端洗的是**发出去的副本**，这里挡的是**屏幕上**。
 * 库里一条没删，阵容改回来发言原样回来。
 *
 * 只认「能对上在场角色表的名字」；认不出的署名（导入卡、临时客人）不动它 ——
 * 宁可多显示一段，也别把别人的话凭空藏了。返回 `null` = 这条整条都是缺席者的话，
 * 连气泡一起不显示。
 */
function hideAbsentSegments(
  m: ChatMessage,
  memberIds: string[],
  cast: CharacterProfile[],
): ChatMessage | null {
  const segs = m.kind === 'groups' && m.segments?.length ? m.segments : null
  if (!segs) return m
  const kept = segs.filter((s) => {
    if (!s.speaker) return true
    const c = cast.find((x) => x.name === s.speaker)
    if (!c) return true
    return memberIds.includes(c.id)
  })
  if (kept.length === segs.length) return m
  if (kept.length === 0) return null
  return { ...m, segments: kept }
}

// 等待回复时轮换的提示语（§27）：光三个点看不出是在忙还是卡了。
const WAITING_LINES = [
  '正在想怎么回你…',
  '正在打字…',
  '还在斟酌用词…',
  '马上就来…',
]

/**
 * 等待回复的占位气泡（§27）：跳动的三点 + 一行轮换的提示语。
 *
 * 群聊时上面叠一行在场者的头像（最多 3 颗），一眼看出是「她们在回」；
 * 私聊已经有署名行了，就不再重复挂头像。计时器开在组件自己身上，
 * 免得每 2.6 秒把整个聊天页重渲一遍。
 */
function WaitingBubble({ cast }: { cast: CharacterProfile[] }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((v) => v + 1), 2600)
    return () => window.clearInterval(timer)
  }, [])
  const who = cast.length > 1 ? '她们' : cast[0]?.name || '角色'
  return (
    <div className="flex flex-col gap-1.5">
      {cast.length > 1 && (
        <div className="flex -space-x-2">
          {cast.slice(0, 3).map((c) => (
            <span key={c.id} className="rounded-full ring-2 ring-[var(--surface)]">
              <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={24} />
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="waiting-dots flex items-end gap-1">
          {[0, 1, 2].map((d) => (
            <span
              key={d}
              className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--pink)]"
              style={{ animationDelay: `${d * 0.16}s` }}
            />
          ))}
        </span>
        <span className="text-[12px] text-[var(--text-3)]">{who}{WAITING_LINES[tick % WAITING_LINES.length]}</span>
      </div>
    </div>
  )
}

type Props = {
  characters: CharacterProfile[]
  /** 你自己的身份档案（§22）。除了「当前身份」，档案上开关打开的那些会作为可聊角色现身。 */
  personas?: CharacterProfile[]
  /** 当前正在用的身份（§22）：决定「在跟谁说话」以及聊天记录挂在哪条线上。 */
  activePersona?: CharacterProfile
  initialSessionId?: string
  /**
   * 手机端挂载时先显示哪一栏（§28）。底部导航的「消息 / 聊天 / 设置」都是先切 view 再派发
   * window 事件 —— 从介绍页 / 小窝 / 私人空间点进来时 ChatView 还没挂载，事件早于 React
   * 提交视图变化，监听器收不到。所以由 App 把这一栏作为挂载初值传进来，事件只负责
   * ChatView 已挂载时的切换。桌面端忽略这个值。
   */
  initialMobileTab?: MobileTab
  onTitleChange?: (title: string) => void
  onOpenProfile: (charId: string) => void
  /** 点自己那侧的署名人 → 进私人空间（§21）。 */
  onOpenSelf: () => void
  /** 「🧠 记忆」：跳到私人空间里这个身份的「记忆」段（§22.4），不在聊天里直接开关 */
  onOpenMemoryPicks: () => void
  /** 「消息」栏里的入口 → 糖人小窝（§9.6 / §28）。 */
  onOpenNest: () => void
  /** 切换某角色的形态（§17）：写回后端，全局生效。 */
  onSwitchForm: (charId: string, formId: string) => void
  /** 重新拉一次角色列表（导入 / 删除角色卡之后）。返回落库后的完整列表。 */
  onRefreshCharacters?: () => Promise<CharacterProfile[]>
  /** 删掉一张导入的角色卡（含她的会话 / 记忆 / 立绘）—— 由 App 统一做，与介绍页走同一条路。 */
  onDeleteImportedCard?: (c: CharacterProfile) => Promise<void>
}

type VoiceOption = { id: string; name: string }
type EngineOption = { id: string; name: string; desc?: string; available: boolean }

// 手机端底部 Tab（桌面端不用）。§28 起「设置」也是一栏 —— 电脑端聊天顶栏右边那一排
// 功能（成员 / 提示词 / 通话 / 自动记忆 / 画廊 / 删除 / 记忆 / 生成 / 通道）
// 全部搬进这一栏，手机顶栏不再单独开抽屉。
type MobileTab = 'sessions' | 'chat' | 'settings' | 'status'

// 手机端底部聊天栏的内联图标（§19.25）。
// 参照图里 QQ 那排是细线图标；emoji 直接渲染在不同系统上胖瘦差太多、
// 跟旁边的线性图标不是一套。所以表情这颗手写 SVG，其余继续用 emoji（本来就是彩色的）。
export default function ChatView({ characters, personas = [], activePersona, initialSessionId, initialMobileTab, onOpenProfile, onOpenSelf, onOpenNest, onSwitchForm, onTitleChange, onRefreshCharacters, onDeleteImportedCard }: Props) {
  const expert = useExpertMode()
  const [tavernMode] = useTavernMode()
  const [cardDisplayMode, setCardDisplayMode] = useState<'chat' | 'html'>(() => localStorage.getItem('xtr.card-display-mode') === 'html' ? 'html' : 'chat')
  const changeCardDisplayMode = (mode: 'chat' | 'html') => {
    setCardDisplayMode(mode)
    localStorage.setItem('xtr.card-display-mode', mode)
  }
  const headerChoice=useDesignChoice('header')
  const toolsChoice=useDesignChoice('tools')
  const chatToolsRef=useDismissableDetails()
  const activePersonaId = activePersona?.id ?? MAIN_PERSONA_ID
  // 当前视角下能出场的全部角色（§22）：小糖人 + 「别的身份」（汐子视角下的大老大）。
  // 后者不进屋里的成员表，只在这个视角下临时现身，会话 id 照旧，隔离交给 personaSessionId。
  const extraCast = useMemo(() => personasAsCast(personas, activePersonaId), [personas, activePersonaId])
  const visibleCharacters = useMemo(() => [...characters, ...extraCast], [characters, extraCast])
  // 群聊阵容（§25）：存在后端 settings 的 `group_roster`（角色 id 的 JSON 数组）。
  // 空 / 没设置 = 全员在场（老行为）。只影响群聊的成员，私聊一条不少。
  const [roster, setRoster] = useState<string[]>([])
  const [rosterOpen, setRosterOpen] = useState(false)
  // 挂载时读一次。解析失败（没设置过 / 后端没起）静默当「全员在场」—— 这只是个偏好，不值得弹错。
  useEffect(() => {
    let cancelled = false
    fetchSettings()
      .then((s) => {
        if (cancelled) return
        const raw = s.group_roster
        if (!raw) return
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) setRoster(parsed.filter((x): x is string => typeof x === 'string'))
        } catch {
          /* 坏值当没设置 */
        }
      })
      .catch(() => {
        /* 后端没起时静默 */
      })
    return () => {
      cancelled = true
    }
  }, [])
  const [lifeSessions, setLifeSessions] = useState<import('../data/chats').ChatSession[]>([])
  useEffect(() => {
    let cancelled = false
    setLifeSessions([])
    if (!expert.enabled || !expert.autonomy_installed) return
    const refresh = () => { void fetch('/api/exploration-projects/conversations?persona=' + encodeURIComponent(activePersonaId))
      .then(r => r.ok ? r.json() : Promise.reject()).then(v => { if (!cancelled) setLifeSessions(v.items) }).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [activePersonaId, expert.enabled, expert.autonomy_installed])
  const geminiEnabled=useOptionalPlugin('gemini_sync',geminiInstalled)
  const sessions = useMemo(() => [...buildSessions(visibleCharacters, [], roster,geminiEnabled?integrationSessions(visibleCharacters.map(character=>character.id)):[]).filter(s => tavernMode || !visibleCharacters.find(c => s.kind === 'single' && c.id === s.characterIds[0])?.imported), ...lifeSessions], [visibleCharacters, roster, lifeSessions, tavernMode,geminiEnabled])
  const [activeId, setActiveId] = useState<string>(initialSessionId ?? sessions[0]?.id ?? 'group')
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  // 本会话在场的角色（群聊 = 全部成员，私聊 = 一位）—— 立绘轮播与状态栏共用
  const activeCharacters = active ? active.characterIds.map((cid) => visibleCharacters.find((c) => c.id === cid)).filter((c): c is CharacterProfile => Boolean(c)) : []
  // 自己那侧的署名行（§19.22 / §22）：跟着私人空间里「成为」的那个身份走。
  const selfProfile = activePersona ?? characters.find((c) => c.id === SELF_CHARACTER_ID)
  // 这一条聊天线的真实会话键（§22：「每个身份各自一条」，默认身份不加前缀，老历史一条不丢）。
  const sessionKey = active ? personaSessionId(activePersonaId, active.id) : ''

  const pendingWrites = useRef<Record<string, number>>({})
  const lifeAttempt = useRef<{ fingerprint: string; id: string } | null>(null)
  const savedUserRecords = useRef(new WeakMap<ChatMessage, StoredMessage>())
  const saveTracked = useCallback(async (sid: string, msg: ChatMessage) => {
    pendingWrites.current[sid] = (pendingWrites.current[sid] || 0) + 1
    try {
      const saved = await saveMessage(sid, msg)
      if (saved) savedUserRecords.current.set(msg, saved)
      return saved
    } finally { pendingWrites.current[sid]-- }
  }, [])
  const [history, setHistory] = useState<Record<string, ChatMessage[]>>({})
  // 每条消息的错误态（流被掐断 / 上游报错），单独展示而不是塞进正文
  const [msgError, setMsgError] = useState<Record<string, string>>({})
  const messages = active ? history[sessionKey] ?? [] : []

  // ---- 持久化（§15）：文本落库 + 附件落盘；启动只载最近 30 条，向上滚再按游标拉 ----
  const loadedRef = useRef<Set<string>>(new Set())
  const [paging, setPaging] = useState<Record<string, { cursor: number | null; hasMore: boolean }>>({})
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [toolCenterOpen, setToolCenterOpen] = useState(false)
  const [toolEvents, setToolEvents] = useState<Record<string, AgentEvent[]>>({})
  const streamController = useRef<AbortController | null>(null)
  useEffect(() => () => { streamController.current?.abort() }, [sessionKey])
  const [voiceCallOpen, setVoiceCallOpen] = useState(false)
  const {voice:voiceComponents}=useComponents()
  const [config, setConfig] = useState<ModelConfig>(loadConfig)
  useEffect(() => {
    let live = true
    void fetchNestBrainDefault().then(({ config: brain }) => {
      if (!brain || typeof brain !== 'object') throw new Error('小窝大脑配置响应无效')
      if (live) setConfig(current => ({ ...current, baseUrl: brain.base_url || '', apiKey: brain.api_key || '',
        chatModel: brain.model || '', visionModel: brain.vision_model || '',
        visionBaseUrl: brain.vision_base_url || brain.base_url || '',
        visionApiKey: brain.vision_api_key || brain.api_key || '' }))
    }).catch(() => { if (live) setErrorText('无法读取小窝大脑配置，请检查后端连接。') })
    return () => { live = false }
  }, [])
  // 所有上游来自小窝大脑；通道开关只控制提示词，不切换另一份模型来源。
  const route = resolveRoute(config)

  /**
   * 组装外发历史（§27）：先按「注入条数」截断，再把群聊分段重排成「**角色名**：」。
   *
   * 两步都只作用于「发出去的副本」，界面上的聊天记录与库里一条不动。
   * 重排是为了对齐后端 `_strip_absent_speakers` 的签名 —— 库里存的「名字：」那种
   * 它认不出，不在场者的段落就洗不掉。
   */
  const buildOutbound = useCallback(
    (list: ChatMessage[]): { role: string; content: string; images: string[] }[] => {
      let remaining = 10
      return limitHistory(list, config.historyLimit).map(m => ({ role: m.role, content: outboundText(m), images: m.role === 'user' ? (m.frames?.length ? m.frames : m.imageOrig || m.image ? [m.imageOrig || m.image!] : []) : [] })).reverse().map(m => {
        const images = remaining ? m.images.slice(-remaining) : []
        remaining -= images.length
        return { ...m, images, content: m.content + (images.length < m.images.length ? '\n[较早附件未重复发送；需要查看细节请重新上传]' : '') }
      }).reverse()
    },
    [config.historyLimit],
  )
  const [errorText, setErrorText] = useState('')
  const [waitNotice, setWaitNotice] = useState('')
  // 轻提示（占位功能如实说明「规划中」，不弹假功能）
  const [notice, setNotice] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  /** 消息滚动容器（§19.14）：载入 / 新消息时直接定位到这里的最下面。 */
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLInputElement>(null)

  // 侧边栏拖宽（§19.11）：宽度写进 CSS 变量 --sb-w，两侧 aside 只认它，拖动只改这一个数。
  const navResize = useResizable('xtr.w.nav', 230, 160, 420, 1) // 左栏：把手在右，往右拖变宽
  const sideResize = useResizable('xtr.w.side', 240, 200, 460, -1) // 右栏：把手在左，往左拖变宽

  // 语音识别（ASR）：浏览器 Web Speech API。识别结果直接往输入框追加，
  // 说完先停在输入框里让用户过一眼，按发送才真的发出去（§19.19 —— 和选图一样，「先预览再发」）。
  const asr = useSpeechToText()
  const [interim, setInterim] = useState('')
  const asrBaseRef = useRef('') // 开始听的那一刻输入框里已有的字
  useEffect(() => {
    if (!asr.listening) return
    setInput(asrBaseRef.current ? `${asrBaseRef.current}${interim}` : interim)
    // 只在 interim 变化时同步，避免把用户正在打的字吞掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interim])

  /** 开始听：记住「起点」，识别期间输入框 = 起点 + 实时识别结果（见上面的 effect）。 */
  const startAsr = useCallback(() => {
    const base = input.trim() ? `${input.replace(/\s+$/, '')}` : ''
    asrBaseRef.current = base
    setInterim('')
    asr.start(
      (t) => setInterim(t),
      // 一句说完了：并回输入框（这里不能靠 effect —— 识别结束后 listening 变 false，
      // 那种情况下最终文本还得落地），并清掉起点，免得下一轮又拼一遍。
      (t) => {
        asrBaseRef.current = ''
        setInterim('')
        setInput((v) => (v ? `${v}${t}` : t))
      },
      (m) => setErrorText(m),
    )
  }, [asr, input])

  // 麦克风能不能用（§19.25 / §16.17）：手机上「按住说话」是核心入口，但 Web Speech 要求
  // 安全上下文，`http://192.168.x.x` 下浏览器会直接拒绝。别让按钮点下去只报一句错 ——
  // 直接换成提示，把「走 https 隧道才能用麦克风」这件事讲清楚。
  const micAvailable =
    voiceComponents.installed && asr.available &&
    (typeof window === 'undefined' ||
      window.isSecureContext ||
      ['localhost', '127.0.0.1'].includes(window.location.hostname))

  // 语音：先选引擎、后选音色；单一音频控制器 + 令牌防竞态 + 显式停止
  const [engines, setEngines] = useState<EngineOption[]>([])
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [voicesOpen, setVoicesOpen] = useState(false)
  // 引擎 / 音色（§19.18）：以前是裸 useState，切会话、刷新、切页面回来都会弹回默认值，
  // 用户以为「选完了又变回去了」—— 这就是那个音色选择的 bug。改成从 localStorage 读初值，
  // 并在下面的 effect 里回写。
  const [speakEngine, setSpeakEngine] = useState(() => localStorage.getItem('xtr.speakEngine') || 'edge')
  const [speakVoice, setSpeakVoice] = useState(
    () => localStorage.getItem('xtr.speakVoice') || 'zh-CN-XiaoxiaoNeural',
  )
  const [autoSpeak] = useState(false)
  const [suggestionsEnabled, setSuggestionsEnabled] = useState(() => {try {return localStorage.getItem('xtr.visual.suggestions-enabled') !== 'false'} catch {return true}})
  const [replySuggestions, setReplySuggestions] = useState<Record<string, string[]>>({})
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playTokenRef = useRef(0)

  // 生图浮层（§7）：抽到 ImageGenOverlay，这里只保留打开/关闭的开关。
  const [genOpen, setGenOpen] = useState(false)

  // 记忆（§9.2/§9.3）：管理浮层 + 消息旁的「记住这条」快捷按钮
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [sentContexts, setSentContexts] = useState<Record<string, { model: string; messages: { role: string; text: string; image_count: number }[] }>>({})
  const [remembered, setRemembered] = useState<Record<string, true>>({})
  const [rememberMsg, setRememberMsg] = useState('')
  // 自动记忆（§9.3）：一条回复结束后规则预筛 + LLM 提炼；提炼到的条数做轻提示
  const [autoMemory, setAutoMemory] = useState(true)
  const [autoMsg, setAutoMsg] = useState('')
  // 画廊 + 照片记忆（§9.4）：图片气泡的「⭐ 存入画廊」与管理浮层
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [starred, setStarred] = useState<Record<string, true>>({})
  const [starring, setStarring] = useState('')
  // 看提示词（§24）：把「此刻会发给模型的东西」摊开看 —— 改完档案不生效时用它核对。
  const [promptOpen, setPromptOpen] = useState(false)

  // 看图轮（§15.5）：这条助手回复前一句是带图/带视频帧的消息 —— 原图 base64 没落库、
  // 帧只在内存里，所以重新生成 / 编辑重发都不支持。
  const isImageTurn = (i: number) =>
    Boolean(messages[i - 1] && messages[i - 1].role === 'user' && (messages[i - 1].image || messages[i - 1].frames?.length))

  // 时间戳显示（§19）：库里 created_at 是 SQLite 的 datetime('now')，UTC，形如
  // '2026-10-02 05:39:12'。先按 UTC 解析再交给本地时区，别让浏览器当成本地时间。
  // 没带时区后缀时不加 'Z' 的话，东八区会整体差 8 小时。
  const parseTs = (raw: string): Date | null => {
    const s = raw.trim()
    if (!s) return null
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const hhmm = (raw: string) => {
    const d = parseTs(raw)
    if (!d) return ''
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  const fullTime = (raw: string) => {
    const d = parseTs(raw)
    if (!d) return ''
    return d.toLocaleString('zh-CN', { hour12: false })
  }
  /** 时间分隔里的日期前缀：今天 / 昨天 / 10月2日（§19.6）。 */
  const dayLabel = (raw: string) => {
    const d = parseTs(raw)
    if (!d) return ''
    const today = new Date()
    const ymd = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
    if (ymd(d) === ymd(today)) return hhmm(raw)
    const y = new Date(today)
    y.setDate(y.getDate() - 1)
    if (ymd(d) === ymd(y)) return `昨天 ${hhmm(raw)}`
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(raw)}`
  }
  // 时间分隔（§19.6）：只在「这条和上一条隔了 5 分钟以上」时插，避免每条都刷时间。
  // 第一条总是插 —— 打开会话就知道这段聊天是什么时候的。
  const TIME_GAP_MS = 5 * 60 * 1000
  const shouldMarkTime = (list: ChatMessage[], i: number) => {
    if (!list[i]?.createdAt) return false
    if (i === 0) return true
    const cur = parseTs(list[i].createdAt)
    const prev = parseTs(list[i - 1]?.createdAt ?? '')
    if (!cur) return false
    // 前一条没有时间（刚发、还没落库）→ 别插，等它有 createdAt 再说
    if (!prev) return false
    return cur.getTime() - prev.getTime() >= TIME_GAP_MS
  }

  // 真删 / QQ 式右键多选（§15.2）：右键菜单 + 多选模式 + 顶部操作条。
  // 用户消息与小糖人的回复都能删（后端 cleanup 与 role 无关，§15.2）。
  const [menu, setMenu] = useState<{ x: number; y: number; seq: number; dbId: string } | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedSeqs, setSelectedSeqs] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)

  // 编辑并重发（§15.5）：被编辑的那条用户消息下标 + 草稿
  const [editingSeq, setEditingSeq] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  // 切会话 / 关掉菜单时的清理
  useEffect(() => {
    setMenu(null)
    setEditingSeq(null)
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

  // 打开会话 / 来新消息 → 直接停在最下面（§19.14）。
  //
  // 以前用 `scrollIntoView({behavior:'smooth'})`，两个毛病：
  // ① 刚进聊天页时会「从上往下滚一段」的动画，很烦；
  // ② 图片是后到的 —— 滚动那一刻它们高度还是 0，滚完了图撑开，人就被留在半空。
  //    图片高度只能等它自己 load 完，没法预算，所以这里监听 load 事件再补一次。
  // 用 `scrollTop` 直接赋值而不是 smooth，就没有过渡动画。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    const imgs = [...el.querySelectorAll('img')]
    const pending = imgs.filter((im) => !im.complete)
    if (!pending.length) return
    const pin = () => {
      el.scrollTop = el.scrollHeight
    }
    // 每张图 load 完都补一次；只要用户没自己往上翻，就一直是贴底的状态。
    pending.forEach((im) => im.addEventListener('load', pin))
    const t = window.setTimeout(pin, 300) // 兜底：图挂了 / 缓存没触发 load
    return () => {
      pending.forEach((im) => im.removeEventListener('load', pin))
      window.clearTimeout(t)
    }
  }, [messages])

  // 记住语音引擎 / 音色（§19.18）：选完就落盘，下次开页面还是上次那个。
  useEffect(() => {
    localStorage.setItem('xtr.speakEngine', speakEngine)
  }, [speakEngine])
  useEffect(() => {
    if (speakVoice) localStorage.setItem('xtr.speakVoice', speakVoice)
  }, [speakVoice])

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
    const sid = sessionKey
    if (!sid || loadedRef.current.has(sid)) return
    loadedRef.current.add(sid)
    // ⚠ 不要在这里用 cancelled 标志丢弃结果：dev 下 React StrictMode 会
    // 「setup→cleanup→setup」，cleanup 会把第一次的 fetch 结果丢掉，而第二次因
    // loadedRef 命中直接 return，导致刷新后历史永远载不出来（§16.9）。
    loadMessages(sid, undefined, PAGE_SIZE).then((page) => {
      const loaded = page.items.map(toChatMessage)
      setHistory((prev) => {
        // 载入期间本地新发、尚未落库的消息（无 seq）保留，别被历史覆盖掉
        if (pendingWrites.current[sid]) return prev
        return { ...prev, [sid]: mergeStoredMessages(prev[sid] ?? [], loaded) }
      })
      setPaging((prev) => ({ ...prev, [sid]: { cursor: page.next_cursor, hasMore: page.has_more } }))
    })
  }, [active, sessionKey])

  // 桌宠等本机呈现端写入同一会话；生成期间暂停合并，保留较早历史和未落库消息。
  useEffect(() => {
    if (!active || !sessionKey || streaming) return
    let cancelled = false
    let pending = false
    const refresh = async () => {
      if (pending || pendingWrites.current[sessionKey]) return
      pending = true
      try {
        const page = await loadMessages(sessionKey, undefined, 200)
        if (cancelled || pendingWrites.current[sessionKey]) return
        setHistory(prev => {
          const previous = prev[sessionKey] || []
          const next = mergeStoredMessages(previous, page.items.map(toChatMessage))
          return JSON.stringify(next) === JSON.stringify(prev[sessionKey] || []) ? prev : { ...prev, [sessionKey]: next }
        })
      } catch { /* 临时离线保留当前画面，下一轮再同步。 */ }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active?.id, sessionKey, streaming])

  // 向上滚到顶 → 按游标拉更早的一页，插到最前面（不跳视口）
  const onScrollMessages = useCallback(
    async (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      if (el.scrollTop > 40 || loadingOlder) return
      const sid = sessionKey
      const page = sid ? paging[sid] : undefined
      if (!sid || !page?.hasMore || !page.cursor) return
      setLoadingOlder(true)
      const prevHeight = el.scrollHeight
      const older = await loadMessages(sid, page.cursor, PAGE_SIZE)
      setHistory((prev) => ({ ...prev, [sid]: [...older.items.map(toChatMessage), ...(prev[sid] ?? [])] }))
      setPaging((prev) => ({ ...prev, [sid]: { cursor: older.next_cursor, hasMore: older.has_more } }))
      setLoadingOlder(false)
      // 保持视口位置不跳：滚回「原高度 - 新内容补上的高度」
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    },
    [sessionKey, paging, loadingOlder],
  )

  const saveConfig = useCallback((c: ModelConfig) => {
    setConfig(c)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ channel: c.channel }))
  }, [])

  const push = useCallback((id: string, msg: ChatMessage) => {
    setHistory((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), msg] }))
  }, [])

  // §0 前置：刚发出去的消息在内存里也要拿到 dbId / seq —— 单条真删（§15.2）与
  // 重新生成（§15.5）都要靠它定位到库里那一行。saveMessage 是异步的，回填时那条
  // 可能已经被删/被替换，定位不到就放弃（刷新后由历史载入补上）。
  const stampDb = useCallback((sid: string, target: ChatMessage, stored: StoredMessage | null) => {
    if (!stored) return
    setHistory((prev) => {
      const list = prev[sid] ?? []
      const idx = list.findIndex((m) => m === target)
      if (idx < 0 || list[idx].dbId === stored.id) return prev
      const copy = [...list]
      copy[idx] = { ...copy[idx], dbId: stored.id, seq: stored.seq, createdAt: stored.created_at, frames: stored.frames?.length ? stored.frames : copy[idx].frames }
      return { ...prev, [sid]: copy }
    })
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
// content 存拼接后的正文（供朗读），返回**写进 history 的那条**（供落库 / 回填 dbId）。
// ⚠ 返回值必须是 history 里的对象引用，否则 stampDb 的 === 定位会落空（§0）。
  const finalizeAssistant = useCallback((id: string, full: string, isGroup: boolean): ChatMessage => {
    const { segments, plain } = segmentGroupReply(full)
    const multi = isGroup && segments.length > 1
    const finalized: ChatMessage = {
      role: 'assistant',
      content: plain,
      clientId: crypto.randomUUID(),
      kind: multi ? 'groups' : 'text',
      segments: multi ? segments : undefined,
    }
    // 「落库用的内容」与「写进 history 的那条」是**同一个对象**（content 已按兜底算好），
    // 所以调用方拿返回值落库、回填 dbId 时 === 一定能命中。
    setHistory((prev) => {
      const list = prev[id] ?? []
      return { ...prev, [id]: list.length ? [...list.slice(0, -1), finalized] : [finalized] }
    })
    return finalized
  }, [])

  // 收尾后落库（§15）：一条 assistant 消息 = 一条记录，分段以 JSON 存 kind/segments。
  // 落库成功后回填 dbId —— 之后这条就能被单条删除 / 重新生成定位（§0）。
  // 落库成功后回填 dbId —— 之后这条就能被单条删除 / 重新生成定位（§0）。
  //
  // ⚠ 回填必须**追加历史**，不能只改对象引用（§19.12 / issue：小糖人新回复选不中）：
  //    `finalizeAssistant` 是流结束回调里调的，而 `streamAssistant` 的 `next` 闭包来自
  //    发起那一次渲染 —— 用户消息的 `dbId` 是它之后才由 `stampDb` 回填进去的，不在
  //    这个闭包里。如果只把「助手这条」写进 history，就会把用户消息上刚补好的 dbId
  //    连同其它并发更新一起抹掉，表现为「新生成的回复只有自己那条能选」。
  //    所以这里按 idx 定位后只覆盖那一条，其余原样保留。
  const persistLast = useCallback(
    (id: string, msg: ChatMessage) => {
      if (!msg.content.trim() && !msg.segments?.length) return
      return saveTracked(id, msg).then((stored) => {
        if (!stored) return
        setHistory((prev) => {
          const list = prev[id] ?? []
          const idx = list.findIndex((m) => m === msg || Boolean(msg.clientId && m.clientId === msg.clientId))
          if (idx < 0) return prev
          const copy = [...list]
          copy[idx] = { ...copy[idx], dbId: stored.id, seq: stored.seq, createdAt: stored.created_at, frames: stored.frames?.length ? stored.frames : copy[idx].frames }
          return { ...prev, [id]: copy }
        })
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
      if (resp.ok) {
        const list=(await resp.json()) as EngineOption[]
        setEngines(list)
        return list
      }
    } catch {
      /* ignore */
    }
    return [] as EngineOption[]
  }, [])

  const pickEngine = useCallback(
    async (eid: string) => {
      setSpeakEngine(eid)
      const list = await fetchVoices(eid)
      setVoices(list)
      // 换了引擎要挑一个「属于这个引擎」的默认音色；但**别覆盖用户已经选好的那个音色** ——
      // 只要它还在这个引擎的音色表里就留着（§19.18：以前无条件重置，一开浮层就跳回默认）。
      const fallback = eid === 'edge' ? 'zh-CN-XiaoxiaoNeural' : 'zh_CN-huayan-medium'
      setSpeakVoice((cur) => {
        if (list.some((v) => v.id === cur)) return cur
        return list.find((v) => v.id === fallback)?.id ?? list[0]?.id ?? ''
      })
    },
    [fetchVoices],
  )

  const openVoicePicker = useCallback(async () => {
    setVoicesOpen(true)
    loadEngines()
    const list = await fetchVoices(speakEngine)
    setVoices(list)
  }, [loadEngines, fetchVoices, speakEngine])

  useEffect(()=>{
    if(!voiceComponents.tts_available)return
    let live=true
    void loadEngines().then(list=>{
      if(!live || list.some(engine=>engine.id===speakEngine && engine.available))return
      const next=list.find(engine=>engine.available)
      if(next)void pickEngine(next.id)
    })
    return ()=>{live=false}
  },[voiceComponents.tts_available,speakEngine,loadEngines,pickEngine])

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

  // 兼容入口：回复收尾后整理新增原文，会调用模型；统一入口在服务端短时间合批。
  const autoExtract = useCallback(
    async (list: ChatMessage[], force = false) => {
      if (!active || active.memoryDisabled) return
      const turns = list.map((m) => ({
        id: m.dbId, created_at: m.createdAt, image: m.imageOrig || m.image, frames: m.frames,
        role: m.role,
        content: m.content,
        // 群聊分段时 character_id 留空，后端靠「**名字**：」前缀辨认发言人
        character_id: '',
      }))
      try {
        const route = resolveRoute(config)
        const res = await extractMemories({
          messages: turns,
          force,
          persona_id: activePersonaId,
          session_id: sessionKey,
          character_ids: active.characterIds,
          session_kind: active.kind === 'single' ? 'single' : 'group',
          // 后台提炼跟随当前通道，但不带越狱标志（工具调用，不需要越狱）
          base_url: route.vision.baseUrl,
          api_key: route.vision.apiKey,
          model: localStorage.getItem('xtr.memoryModel') || route.vision.model,
        })
        if (res.status === 'blocked' || res.status === 'unconfigured') {
          setAutoMsg(res.detail || '原文已保存，记忆整理等待处理')
          return
        }
        const saved = res.candidates ?? []
        if (saved.length || res.fact_candidates?.length) {
          setAutoMsg(`🧠 今日事件已自动整理，${saved.length} 条记忆等待在 03 审核`)
          setTimeout(() => setAutoMsg(''), 6000)
        }
      } catch (e) {
        // 提炼失败不打扰聊天，只在控制台留痕
        console.warn('自动记忆提炼失败：', e)
        if (force) throw e
      }
    },
    [active, visibleCharacters, config, activePersonaId, sessionKey],
  )

  // 流式请求一段回复（§15.5）：sendText / onPickImage / onPickVideo / 重新生成 / 编辑重发 共用。
  const pendingTurnIds = useRef<Record<string,string>>({})
  // 调用方负责**先把 history 准备好**（用户消息已在数组里），这里只负责：
  // 占位 → 打字机 → 收尾 → 落库（回填 dbId）→ 自动朗读 / 自动记忆。
  const streamAssistant = useCallback(
    async (sid: string, next: ChatMessage[], endpoint: '/api/chat' | '/api/images/chat' | '/api/media/video/chat', body: Record<string, unknown>, isGroup: boolean) => {
      const controller = new AbortController()
      streamController.current = controller
      setToolEvents(prev => ({ ...prev, [sid]: [] }))
      setStreaming(true)
      setWaitNotice('')
      setReplySuggestions(prev => ({ ...prev, [sid]: [] }))
      push(sid, { role: 'assistant', content: '' })
      const acc = { value: '' }
      const q = createSmartStream((t) => {
        acc.value += t
        appendAssistantToken(sid)(t)
      })
      const lastUser = [...next].reverse().find(m => m.role === 'user')
      const savedUserId = lastUser?.dbId || (lastUser && savedUserRecords.current.get(lastUser)?.id)
      const unified = !active?.memoryDisabled && Boolean(savedUserId)
      const turnKey = `${sid}:${savedUserId}`
      if (unified && !pendingTurnIds.current[turnKey]) pendingTurnIds.current[turnKey] = `web-${crypto.randomUUID()}`
      const requestBody = unified ? {
        feature_id: 'core', character_id: active?.characterIds[0], mode: isGroup ? 'group' : 'single',
        session_id: sid, persona_id: body.persona_id, text: lastUser!.content,
        saved_user_id: savedUserId, request_id: pendingTurnIds.current[turnKey],
        base_url: body.base_url, api_key: body.api_key, model: body.model,
        uncensored: body.uncensored, max_tokens: body.max_tokens, auto_memory: autoMemory,
        card_display_mode: tavernMode ? cardDisplayMode : undefined,
        reply_suggestions: suggestionsEnabled,
        memory_model: localStorage.getItem('xtr.memoryModel') || '',
        history_end_id: body.history_end_id || '',
      } : { ...body, card_display_mode: tavernMode ? cardDisplayMode : undefined, reply_suggestions: suggestionsEnabled }
      await streamSSE(
        unified ? '/api/chat/session/web-stream' : endpoint,
        requestBody,
        (t) => q.push(t),
        (_reason, stored) => {
          delete pendingTurnIds.current[turnKey]
          q.finish()
          setStreaming(false)
          const plain = finalizeAssistant(sid, acc.value, isGroup)
          const persisted = stored ? Promise.resolve(stored) : persistLast(sid, plain)
          if (stored) setHistory(prev => ({ ...prev, [sid]: [...(prev[sid] || []).slice(0, -1), toChatMessage(stored)] }))
          if (autoSpeak && plain.content.trim()) speakText(plain.content, `${sid}:auto`)
          if (autoMemory && !unified) void persisted?.then(() => autoExtract([...next, plain]))
        },
        (msg) => {
          q.finish()
          setToolEvents(prev => ({ ...prev, [sid]: prev[sid]?.length ? [...prev[sid], { type: 'agent_end', status: controller.signal.aborted ? 'cancelled' : 'failed' }] : [] }))
          appendAssistantError(sid)(msg)
          setErrorText(msg)
          setStreaming(false)
        },
        (context) => setSentContexts((prev) => ({ ...prev, [sid]: context })),
        { signal: controller.signal, onEvent: (type, payload) => {
          if (type === 'done') {
            const choices = Array.isArray(payload.reply_suggestions) ? payload.reply_suggestions
              .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
              .map(value => value.trim().slice(0, 60)) : []
            setReplySuggestions(prev => ({ ...prev, [sid]: [...new Set(choices)].slice(0, 3) }))
          }
          if (type === 'status' && typeof payload.text === 'string') setWaitNotice(payload.text)
          if (type === 'token') setWaitNotice('正在接收回复…')
          if (type.startsWith('tool_') || type.startsWith('agent_')) {
            setToolEvents(prev => ({ ...prev, [sid]: [...(prev[sid] || []), { ...payload, type } as AgentEvent].slice(-64) }))
          }
        } },
      )
      if (streamController.current === controller) streamController.current = null
    },
    [push, appendAssistantToken, appendAssistantError, finalizeAssistant, persistLast, autoSpeak, autoMemory, autoExtract, speakText, active, tavernMode, cardDisplayMode, suggestionsEnabled],
  )

  type PendingMedia = { file: File; url: string; frames: string[]; analyzing: boolean; error?: string }
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([])
  const mediaRef = useRef<PendingMedia[]>([])
  const sendingMedia = useRef(false)
  const updateMedia = useCallback((items: PendingMedia[]) => {
    mediaRef.current = items
    setPendingMedia(items)
  }, [])
  const clearAtt = useCallback(() => {
    mediaRef.current.forEach(item => URL.revokeObjectURL(item.url))
    updateMedia([])
  }, [updateMedia])
  const attachFiles = useCallback(async (files: File[]) => {
    if (active?.sandbox) { setNotice('沙盒生活目前接收文字；图片与语音请继续使用普通聊天。'); return }
    if (sendingMedia.current || streaming) return
    const valid = files.filter(f => /^(image|video)\//.test(f.type))
    const current = mediaRef.current
    if ([...current.map(x => x.file), ...valid].filter(f => f.type.startsWith('video/')).length > 1) {
      setErrorText('每次最多上传 1 个视频，视频仅在本地抽帧后发送')
      return
    }
    if (current.filter(x => x.file.type.startsWith('image/')).length + valid.filter(f => f.type.startsWith('image/')).length > 10 || current.length + valid.length > 10) {
      setErrorText('每次最多选择 10 个附件，其中图片最多 10 张')
      return
    }
    if (valid.some(f => f.size > (f.type.startsWith('video/') ? 50 : 20) * 1024 * 1024)) {
      setErrorText('图片不能超过 20 MB，视频不能超过 50 MB（15 秒）')
      return
    }
    const added = valid.map(file => ({ file, url: URL.createObjectURL(file), frames: [] as string[], analyzing: file.type.startsWith('video/') }))
    updateMedia([...current, ...added])
    setErrorText('')
    for (const item of added) {
      if (!item.analyzing) continue
      try {
        const result = await analyzeVideo(item.file)
        if (!result.frames.length) throw new Error('没有抽出视频帧')
        if (mediaRef.current.includes(item)) updateMedia(mediaRef.current.map(x => x === item ? { ...x, frames: result.frames, analyzing: false } : x))
      } catch (e) {
        if (mediaRef.current.includes(item)) updateMedia(mediaRef.current.map(x => x === item ? { ...x, analyzing: false, error: String(e) } : x))
      }
    }
  }, [updateMedia, streaming])
  useEffect(() => () => clearAtt(), [sessionKey, clearAtt])

  const sendText = useCallback(async () => {
    if (active?.readOnly) return
    const text = input.trim()
    if (!text || streaming || !active) return
    if (active.sandbox) {
      setStreaming(true); setErrorText('')
      const fingerprint = JSON.stringify([activePersonaId, active.characterIds[0], text])
      if (lifeAttempt.current?.fingerprint !== fingerprint) lifeAttempt.current = { fingerprint, id: crypto.randomUUID() }
      try {
        const response = await fetch('/api/exploration-projects/conversations/message', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Exploration-Dashboard': '1' },
          body: JSON.stringify({ persona: activePersonaId, speaker: active.characterIds[0], text, request_id: lifeAttempt.current.id }) })
        const value = await response.json()
        if (!response.ok) throw new Error(value.detail || '消息未能送到沙盒')
        lifeAttempt.current = null; setInput(''); setNotice(value.message)
        const page = await loadMessages(sessionKey, undefined, 200)
        setHistory(prev => ({ ...prev, [sessionKey]: mergeStoredMessages(prev[sessionKey] || [], page.items.map(toChatMessage)) }))
      } catch (e) { setErrorText(e instanceof Error ? e.message : String(e)) }
      finally { setStreaming(false) }
      return
    }
    setStreaming(true)
    const id = sessionKey
    const userMsg: ChatMessage = { role: 'user', content: text }
    const next: ChatMessage[] = [...messages, userMsg]
    setHistory((prev) => ({ ...prev, [id]: next }))
    setMsgError((prev) => ({ ...prev, [id]: '' }))
    setInput('')
    const saved = await saveTracked(id, userMsg)
    if (!saved) { setErrorText('消息保存失败，请重试'); setStreaming(false); return }
    stampDb(id, userMsg, saved)

    const r = resolveRoute(config)
    await streamAssistant(
      id,
      next,
      '/api/chat',
      {
        messages: buildOutbound(next),
        character_ids: active.characterIds,
        persona_id: activePersonaId,
        base_url: buildOutbound(next).some((m) => m.images.length) ? r.vision.baseUrl : r.chat.baseUrl,
        api_key: buildOutbound(next).some((m) => m.images.length) ? r.vision.apiKey : r.chat.apiKey,
        model: buildOutbound(next).some((m) => m.images.length) ? r.vision.model : r.chat.model,
        max_tokens: config.maxTokens || null,
        uncensored: config.channel === 'uncensored',
      },
      active.kind === 'group',
    )
  }, [input, messages, streaming, active, sessionKey, activePersonaId, config, stampDb, streamAssistant, buildOutbound])

  const sendMedia = useCallback(async () => {
    if (active?.sandbox || active?.readOnly || streaming || !active || sendingMedia.current) return
    const pending = mediaRef.current
    if (!pending.length || pending.some(x => x.analyzing || x.error)) return
    sendingMedia.current = true
    setStreaming(true)
    setErrorText('')
    try {
      const id = sessionKey
      const caption = input.trim() || config.visionPrompt?.trim() || DEFAULT_VISION_PROMPT
      const batch: ChatMessage[] = []
      const videoCount = pending.filter(x => x.frames.length).length
      const framesPerVideo = videoCount ? Math.max(1, Math.floor((10 - pending.length + videoCount) / videoCount)) : 0
      for (const item of pending) {
        const uploaded = await uploadAttachmentsBatch(id, [item.file])
        if (!uploaded.saved.length) throw new Error(uploaded.errors[0]?.error || '附件上传失败')
        const att = uploaded.saved[0]
        const frames = item.frames.filter((_, i) => i === 0 || Math.floor(i * framesPerVideo / item.frames.length) !== Math.floor((i - 1) * framesPerVideo / item.frames.length)).slice(0, framesPerVideo)
        const message: ChatMessage = {
          role: 'user', content: batch.length ? `附件：${item.file.name}` : caption,
          image: frames[0] || att.thumb, imageOrig: att.orig,
          imageSource: frames.length ? 'video' : 'upload', frames,
        }
        const saved = await saveTracked(id, message)
        if (!saved) throw new Error('附件消息保存失败')
        batch.push(toChatMessage(saved))
        setHistory(prev => ({ ...prev, [id]: [...messages, ...batch] }))
        URL.revokeObjectURL(item.url)
        updateMedia(mediaRef.current.filter(x => x !== item))
      }
      setInput('')
      const next = [...messages, ...batch]
      const outbound = [...buildOutbound(messages), ...batch.map(m => ({ role: m.role, content: outboundText(m), images: m.frames?.length ? m.frames : [m.imageOrig!] }))]
      const r = resolveRoute(config)
      await streamAssistant(id, next, '/api/chat', {
        messages: outbound, character_ids: active.characterIds, persona_id: activePersonaId,
        base_url: r.vision.baseUrl, api_key: r.vision.apiKey, model: r.vision.model,
        max_tokens: config.maxTokens || null, uncensored: config.channel === 'uncensored',
      }, active.kind === 'group')
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e))
    } finally {
      sendingMedia.current = false
      setStreaming(false)
    }
  }, [active, streaming, sessionKey, input, config, messages, stampDb, updateMedia, buildOutbound, streamAssistant, activePersonaId])

  // 「记住这条」（§9.3 手动记忆）：桶由会话类型决定 —— 私聊进 TA 的个人记忆，群聊进家记忆。
  const rememberThis = useCallback(
    async (key: string, content: string) => {
      if (active?.memoryDisabled) { setNotice('test 群聊不写入长期记忆'); return }
      const text = (content || '').trim()
      if (!text || !active) return
      setRememberMsg('')
      try {
        await proposeMemory({
          text, persona_id: activePersonaId, session_id: sessionKey,
          scope: active.kind === 'single' ? 'personal' : 'shared',
          character_ids: active.characterIds,
          category: 'experience', messages: [{ role: 'assistant', content: text }],
        })
        setRememberMsg('已补充到 03 待审核，批准后才允许注入')
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
    [active, activePersonaId, sessionKey],
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
          session_id: sessionKey,
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
    [active, sessionKey],
  )

  // ⭐ / 🧠 是按「会话:下标」记的。下标一变（删消息 / 重新生成 / 编辑重发），
  // 整段清掉本会话前缀最稳 —— 两个 map 的清理逻辑完全一样，抽出来避免复制粘贴。
  const clearSessionMarks = useCallback((sid: string) => {
    const strip = <T,>(prev: Record<string, T>) => {
      const next: Record<string, T> = {}
      for (const [k, v] of Object.entries(prev)) if (!k.startsWith(`${sid}:`)) next[k] = v
      return next
    }
    setStarred(strip)
    setRemembered(strip)
  }, [])

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
          [sessionKey]: (prev[sessionKey] ?? []).filter((_, i) => !dead.has(i)),
        }))
        clearSessionMarks(sessionKey)
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e))
      } finally {
        setDeleting(false)
        setSelectMode(false)
        setSelectedSeqs(new Set())
        setMenu(null)
      }
    },
    [active, sessionKey, messages, clearSessionMarks],
  )

  // 重新生成（§15.5）：无谱系列 —— 删掉库里那条旧回复，用**截断到它之前**的历史重新 POST。
  // 用当前 config / 通道（消息里不存当轮参数），所以换过模型再重生成，结果可能不同（§16.12）。
  // 看图那一轮不支持：base64 没落库，重发不了（§15.5）。
  const regenerate = useCallback(
    async (i: number) => {
      if (active?.sandbox || active?.readOnly) return
      if (!active || streaming || deleting) return
      const id = sessionKey
      const target = messages[i]
      if (!target || target.role !== 'assistant') return
      const prev = messages[i - 1]
      const isImageTurn = Boolean(prev?.role === 'user' && (prev.image || prev.frames?.length))
      if (isImageTurn) {
        setErrorText('看图那一轮暂不支持重新生成（原图 base64 没有落库）')
        return
      }
      setDeleting(true)
      setErrorText('')
      try {
        if (target.dbId) {
          const r = await deleteMessages([target.dbId])
          if (!r) throw new Error('旧回复删除失败：后端没响应')
        }
        const truncated = messages.slice(0, i)
        setHistory((prevHist) => ({ ...prevHist, [id]: truncated }))
        clearSessionMarks(id)
        setDeleting(false)
        const r = resolveRoute(config)
        await streamAssistant(
          id,
          truncated,
          '/api/chat',
          {
            messages: buildOutbound(truncated),
            history_end_id: truncated[truncated.length - 1]?.dbId,
            character_ids: active.characterIds,
            persona_id: activePersonaId,
            base_url: buildOutbound(truncated).some((m) => m.images.length) ? r.vision.baseUrl : r.chat.baseUrl,
            api_key: buildOutbound(truncated).some((m) => m.images.length) ? r.vision.apiKey : r.chat.apiKey,
            model: buildOutbound(truncated).some((m) => m.images.length) ? r.vision.model : r.chat.model,
            max_tokens: config.maxTokens || null,
            uncensored: config.channel === 'uncensored',
          },
          active.kind === 'group',
        )
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e))
        setDeleting(false)
      }
    },
    [active, sessionKey, messages, streaming, deleting, activePersonaId, config, clearSessionMarks, streamAssistant, buildOutbound],
  )

  // 编辑并重发（§15.5，Gemini 式）：改这条 + 删掉它后面所有，再重新生成。
  const editResend = useCallback(async () => {
    if (active?.sandbox || active?.readOnly) return
    if (!active || streaming || deleting || editingSeq === null) return
    const text = editDraft.trim()
    if (!text) return
    const id = sessionKey
    const i = editingSeq
    const head = messages.slice(0, i)
    const dropped = messages.slice(i)
    setDeleting(true)
    setErrorText('')
    try {
      const ids = dropped.map((m) => m.dbId).filter((v): v is string => Boolean(v))
      if (ids.length) {
        const r = await deleteMessages(ids)
        if (!r) throw new Error('旧消息删除失败：后端没响应')
      }
      const userMsg: ChatMessage = { role: 'user', content: text }
      const next: ChatMessage[] = [...head, userMsg]
      setHistory((prev) => ({ ...prev, [id]: next }))
      setEditingSeq(null)
      setEditDraft('')
      clearSessionMarks(id)
      const saved = await saveTracked(id, userMsg)
      if (!saved) { setErrorText('消息保存失败，请重试'); setDeleting(false); return }
      stampDb(id, userMsg, saved)
      setDeleting(false)
      const r = resolveRoute(config)
      await streamAssistant(
        id,
        next,
        '/api/chat',
        {
          messages: buildOutbound(next),
          character_ids: active.characterIds,
          persona_id: activePersonaId,
          base_url: buildOutbound(next).some((m) => m.images.length) ? r.vision.baseUrl : r.chat.baseUrl,
          api_key: buildOutbound(next).some((m) => m.images.length) ? r.vision.apiKey : r.chat.apiKey,
          model: buildOutbound(next).some((m) => m.images.length) ? r.vision.model : r.chat.model,
          max_tokens: config.maxTokens || null,
          uncensored: config.channel === 'uncensored',
        },
        active.kind === 'group',
      )
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e))
      setDeleting(false)
    }
  }, [active, sessionKey, messages, streaming, deleting, editingSeq, editDraft, activePersonaId, config, clearSessionMarks, streamAssistant, stampDb, buildOutbound])

  // 手机端当前显示哪一栏（桌面端不生效）。挂载初值优先取 App 递进来的 initialMobileTab（§28）——
  // 从别的视图切过来时事件早于挂载，收不到；只有已经在聊天页时事件才管用。
  const [mobileTab, setMobileTab] = useState<MobileTab>(
    () => (window.matchMedia('(max-width: 767px)').matches ? (initialMobileTab ?? 'sessions') : 'chat'),
  )
  useEffect(() => {
    setMobileTab((cur) => (initialMobileTab && cur !== initialMobileTab ? initialMobileTab : cur))
  }, [initialMobileTab])
  useEffect(() => {
    const showSessions = () => setMobileTab('sessions')
    const showChat = () => setMobileTab('chat')
    const showSettings = () => setMobileTab('settings')
    window.addEventListener('xtr-mobile-sessions', showSessions)
    window.addEventListener('xtr-mobile-chat', showChat)
    window.addEventListener('xtr-mobile-settings', showSettings)
    return () => {
      window.removeEventListener('xtr-mobile-sessions', showSessions)
      window.removeEventListener('xtr-mobile-chat', showChat)
      window.removeEventListener('xtr-mobile-settings', showSettings)
    }
  }, [])
  // 手机端底部聊天栏（§19.25）：跟 QQ 一样，输入框下面再挂一行小图标。
  // trio = 右半边那三颗；recording = 是否已经点了麦克风、露出「按住说话」。


  // 导入角色卡（酒馆）：选出文件后**不马上建角色** —— 先开浮层读卡、立绘落盘、抽词条，
  // 用户在预览里确认（改不改名字都行）才落库。建完刷新角色列表并跳到她的私聊。
  const [importFile, setImportFile] = useState<File | null>(null)
  const onImport = useCallback((file: File) => setImportFile(file), [])

  /** 预览里抽词条走聊天这一份上游 —— 抽取是整理原文，不该逼用户再配一份 key。 */
  const importRoute = { baseUrl: route.chat.baseUrl, apiKey: route.chat.apiKey, model: route.chat.model }

  const onImported = useCallback(
    async (char: CharacterProfile) => {
      setImportFile(null)
      await onRefreshCharacters?.()
      setActiveId(`single-${char.id}`)
      setMobileTab('chat')
    },
    [onRefreshCharacters],
  )

  /** 会话列表里的 🗑：删完刷新列表，当前会话若正是她那条就落回群聊（那条已经没了）。 */
  const onDeleteImported = useCallback(
    async (char: CharacterProfile) => {
      if (!onDeleteImportedCard) return
      await onDeleteImportedCard(char)
      if (activeId === `single-${char.id}`) setActiveId('group')
    },
    [onDeleteImportedCard, activeId],
  )

  const suggestions = active ? replySuggestions[sessionKey] || [] : []
  useEffect(() => { onTitleChange?.(active?.name || '信息') }, [active?.name, onTitleChange])

  if (!active) return null

  // 手机端（<768px）三栏放不下 → 底部 Tab 一次只显示一栏；桌面端 md: 依旧三栏并排。
  // 非当前 Tab 的栏用 max-md:hidden 藏起来，桌面端不受影响。
  const tabCls = (tab: MobileTab) => (mobileTab === tab ? '' : 'max-md:hidden')

  const openVoiceCall = () => {
    if (streaming) { setNotice('请等当前回复结束再拨打。'); return }
    if (!active || active.sandbox || active.readOnly || active.kind !== 'single') { setNotice('请先打开一位角色的私聊，再开始通话。'); return }
    stopSpeak(); asr.stop(); setVoiceCallOpen(true)
  }

  return (
    // h-full 而不是 h-[100dvh]（§19.23）：ChatView 是 App 内容区里唯一需要「自带滚动」的视图，
    // 自己撑满这一层就好。写成 dvh 等于把顶栏那一截又算进来，整栏比可用高度高出 ~54px，
    // 多出来的部分溢到内容区滚动区里 —— 手机上看着就是输入栏被压扁、按钮挤成一团。
    <div className="flex h-full flex-col md:flex-row">
      {/* 左：最近聊天 / 会话列表。右缘那条把手可以把这一栏拖宽（§19.11），宽度记在 localStorage。 */}
      <aside
        style={navResize.style}
        className={`relative min-h-0 min-w-0 flex-1 overflow-hidden border-[var(--border)] bg-[var(--surface)] max-md:flex max-md:flex-col md:w-[var(--sb-w)] md:flex-none md:border-r ${tabCls('sessions')}`}
      >
        <SessionList
          sessions={sessions}
          characters={visibleCharacters}
          activeId={active.id}
          onSelect={(id) => {
            setActiveId(id)
            setMobileTab('chat') // 手机上选完会话直接跳到聊天
          }}
          onImport={onImport}
          onOpenNest={onOpenNest}
          onDeleteImported={onDeleteImportedCard ? onDeleteImported : undefined}
          cardDisplayMode={cardDisplayMode}
          onCardDisplayModeChange={changeCardDisplayMode}
        />
        {/* 拖动把手：窄窄一条贴在右缘，鼠标划过去放大到 4px 高亮。手机端（<md）藏掉 */}
        <div
          {...navResize.handleProps}
          title="拖我改宽窄（双击恢复默认）"
          className="absolute right-0 top-0 z-20 hidden h-full w-2 translate-x-1/2 cursor-col-resize select-none md:block"
        >
          <span className="pointer-events-none absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 bg-transparent transition-colors hover:bg-[var(--pink)]" />
        </div>
      </aside>

      {/* 中：对话框。min-h-0（§19.21）：列式 flex 子项默认 min-height:auto，
          里面的消息列表是 overflow-y-auto，缺了它会把这一节撑破外层、连输入栏一起滚出屏幕。 */}
      <section className={`flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-soft)] visual-chat-reading ${tabCls('chat')}`}>
        {/* 顶部：形态切换 + 右侧功能排（§28）。
            以前这里还有一排「点进角色介绍」的缩略头像 —— 群聊里几位并排、私聊里一位，
            占掉半行宽度。其实消息区里每位的头像/署名都能点进介绍，功能重复，去掉。 */}
        <header data-header={headerChoice} className="visual-chat-header hidden items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 md:flex">
          {active.characterIds.length === 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-1 pr-3 text-[12px] text-[var(--text-2)]">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[13px]"><UiIcon name="card"/></span>
              {active.name}
            </span>
          )}
          {/* 形态切换（§17）：私聊时可直接在聊天头部换她的形态，切换即写回后端、全局生效 */}
          {active.characterIds.length === 1 &&
            (() => {
              const c = visibleCharacters.find((x) => x.id === active.characterIds[0])
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
          {/* 群聊阵容（§25）：只改默认群聊的成员，存后端设置，刷新保持 */}
          <span className="visual-chat-title">{active.name}</span>
          {voiceComponents.installed && active.kind === 'single' && !active.sandbox && !active.readOnly && <button type="button" aria-label="语音通话" title="语音通话设置" disabled={streaming} onClick={openVoiceCall} className="shrink-0 rounded-full p-2 text-[var(--pink-deep)] disabled:opacity-40"><UiIcon name="phone" size={20}/></button>}
          <div className="chat-primary-actions" aria-label="常用聊天功能">
            <button type="button" title={active.kind==='group' ? '改群聊成员' : '查看当前成员'} aria-label="成员" onClick={() => active.kind==='group' ? setRosterOpen(true) : setNotice('当前成员：'+activeCharacters.map(c=>c.name).join('、'))}><UiIcon name="characters" size={17}/><span>成员</span>{active.kind==='group'&&<small>{active.characterIds.length}</small>}</button>
            <button type="button" aria-label="提示词" disabled={active.sandbox} title="查看当前提示词，不消耗 token" onClick={() => setPromptOpen(true)}><UiIcon name="search" size={17}/><span>提示词</span></button>
            {tavernMode && <button type="button" aria-label="无审查" disabled={active.sandbox} title={config.channel==='uncensored'?'无审查通道已启用；点击切回常规':'点击切换到无审查通道'} aria-pressed={config.channel==='uncensored'} onClick={() => saveConfig({...config,channel:config.channel==='uncensored'?'normal':'uncensored'})}><UiIcon name={config.channel==='uncensored'?'unlock':'lock'} size={17}/><span>无审查</span></button>}
          </div>
          <details ref={chatToolsRef} className="visual-chat-tools" data-tools={toolsChoice}><summary aria-label="工具与设置"><UiIcon name="tools" size={17}/><span>{toolsChoice==='t2'?'更多':'工具与设置'}</span><i aria-hidden="true">{toolsChoice==='t3'?'···':'⌄'}</i></summary><div className="visual-tools-content">
            <button
              onClick={() => setAutoMemory((v) => !v)}
              disabled={active?.sandbox || active?.memoryDisabled}
              className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                autoMemory
                  ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                  : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-3)]'
              }`}
              title="自动整理：按天整理事件到 03 待审核，原文与附件始终全量保存在本地"
            >
              {active?.memoryDisabled ? '🪄 测试会话不进记忆' : autoMemory ? '🪄 自动整理今日事件' : '🪄 自动整理 关'}
            </button>
            <button
              onClick={() => setGalleryOpen(true)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--text-2)] hover:border-[var(--pink)]"
              title="画廊：你主动收藏的重要图片（§9.4）"
            >
              <UiIcon name="gallery"/> 画廊
            </button>
            <button
              onClick={() => setSelectMode((v) => !v)}
              disabled={streaming || messages.length === 0}
              className={`rounded-lg border px-2.5 py-1 text-[12px] transition disabled:opacity-40 ${
                selectMode
                  ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                  : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-2)] hover:border-[var(--pink)]'
              }`}
              title="多选删除：勾选要删的消息（你自己的和角色的都行），真删（连带图片文件 / 画廊收藏 / 照片记忆）"
            >
              <UiIcon name="delete"/> 删除
            </button>
            <button
              onClick={() => setMemoryOpen(true)}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--text-2)] hover:border-[var(--pink)]"
              title="短期记忆：核对当前文字、图片上下文及实际发送记录"
            >
              <UiIcon name="memory"/> 记忆
            </button>

          </div></details>
        </header>

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

        {/* 占位 / 说明类轻提示（如 📞 通话规划中） */}
        {notice && (
          <div className="mx-4 mt-2 flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[12px] text-[var(--text-2)]">
            <span className="min-w-0 flex-1">{notice}</span>
            <button onClick={() => setNotice('')} className="shrink-0 opacity-70 hover:opacity-100">
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
              在消息上右键可以「删除这条」或进入多选（多选时点整条消息即可勾选）；你的消息和角色的回复都能删。改自己的话用气泡下的「✎ 编辑」。
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
        <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-5" ref={scrollRef} onScroll={onScrollMessages}>
          {loadingOlder && <div className="mb-2 text-center text-[12px] text-[var(--text-3)]">加载更早的消息…</div>}
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--text-3)]">
              <div className="rounded-full bg-[var(--pink-soft)] px-3 py-1 text-[var(--pink-deep)]">
                {active.kind === 'group' ? '🏠' : active.characterIds[0] ? visibleCharacters.find((c) => c.id === active.characterIds[0])?.emoji : '🎴'}
              </div>
              和 {active.kind === 'group' ? '大家' : active.name} 说点什么吧（先点 <UiIcon name="settings" className="inline-block align-middle"/> 填好模型）
            </div>
          )}
          {messages.map((m, i) => {
            const err = msgError[sessionKey]
            const isLast = i === messages.length - 1
            // 不在场的人，她在群聊里的旧发言不渲染（§27）。后端那份清洗管的是发出去的
            // 副本，这里管的是屏幕 —— 库里一条没删，阵容调回来发言原样回来。
            const shown = hideAbsentSegments(m, active.characterIds, visibleCharacters)
            // 时间分隔（§19.6）：不逐条显示时间，只在和上一条隔得久（>5 分钟）时插一行居中的时间。
            // 第一条也显示 —— 进会话就知道这段聊天是什么时候的。
            const showTime = shouldMarkTime(messages, i)
            // 整条都是不在场者的话 → 一个字都不渲染，但别留一片空白让人以为卡了：
            // 给一行浅提示 + 重新生成入口，用户能立刻重来一轮。
            if (!shown) {
              return (
                <div key={i} className="mb-3 flex flex-col">
                  {showTime && m.createdAt && (
                    <div className="mb-3 flex items-center justify-center">
                      <span className="text-[11px] text-[var(--text-3)]" title={fullTime(m.createdAt)}>
                        {dayLabel(m.createdAt)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 rounded-2xl border border-dashed border-[var(--border-strong)] px-4 py-2 text-[12px] text-[var(--text-3)]">
                    <span>这一轮只有不在场的角色在说，已隐去</span>
                    <button
                      onClick={() => void regenerate(i)}
                      disabled={streaming || deleting}
                      className="text-[11px] text-[var(--text-3)] transition hover:text-[var(--pink-deep)] disabled:cursor-not-allowed disabled:opacity-40"
                      title="按当前在场的阵容重新生成一次"
                    >
                      <UiIcon name="refresh"/> 重新生成
                    </button>
                  </div>
                </div>
              )
            }
            const segs = shown.kind === 'groups' && shown.segments?.length ? shown.segments : null
            // 真删：用户消息与小糖人的回复都能删（§15.2），前提是已落库 —— dbId 由 §0 的回填补上
            const deletable = Boolean(m.dbId)
            const checked = selectedSeqs.has(i)
            return (
              <div
                key={i}
                onClick={
                  // 多选模式（§19.16）：点这条消息的**任意位置**都能勾上/取消，不用非得去点那个小方框。
                  // checkbox 自己也带 onClick，所以得排除掉，否则一次点击翻两次 = 看上去没反应。
                  selectMode && deletable
                    ? (e) => {
                        if ((e.target as HTMLElement).closest('input,button,a,textarea')) return
                        setSelectedSeqs((prev) => {
                          const next = new Set(prev)
                          if (next.has(i)) next.delete(i)
                          else next.add(i)
                          return next
                        })
                      }
                    : undefined
                }
                className={`mb-3 flex flex-col ${
                  selectMode && deletable ? 'cursor-pointer' : ''
                } ${selectMode && checked ? 'rounded-xl bg-[var(--pink-soft)]/60 ring-1 ring-[var(--pink)]' : ''}`}
              >
                {showTime && m.createdAt && (
                  <div className="mb-3 flex items-center justify-center">
                    <span className="text-[11px] text-[var(--text-3)]" title={fullTime(m.createdAt)}>
                      {dayLabel(m.createdAt)}
                    </span>
                  </div>
                )}
                {/* 署名行（§8.1）：头像 + 名字 + 时间戳属于「这一条消息」，所以放在气泡列外面。
                    群聊非分段回复是「大家一起说」，不署名。点头像 / 名字进这位的介绍页（§19）。 */}
                {!segs && m.role === 'assistant' && active.kind === 'single' && (
                  (() => {
                    const c = visibleCharacters.find((x) => x.id === active.characterIds[0])
                    if (!c) return null
                    return (
                      <div className={`mb-1.5 flex items-center gap-2.5 ${selectMode && deletable ? 'pl-7' : ''}`}>
                        <button
                          type="button"
                          onClick={() => onOpenProfile(c.id)}
                          title={`看 ${c.name} 的介绍页`}
                          className="flex items-center gap-2.5 transition hover:opacity-85"
                        >
                          <Avatar name={c.name} avatar={c.avatar} emoji={c.emoji} size={40} />
                          <span className="text-[15px] font-semibold text-[var(--pink-deep)]">{c.name}</span>
                        </button>
                        {m.createdAt && (
                          <span className="text-[11px] text-[var(--text-3)]" title={fullTime(m.createdAt)}>
                            {hhmm(m.createdAt)}
                          </span>
                        )}
                      </div>
                    )
                  })()
                )}
                {/* 自己那侧的署名行（§19.22）：私聊、群聊都显示，右对齐、贴在气泡上方。
                    跟小糖人那侧同一套版式（40px 头像 + 15px 名字），只是换到右边、用主色。
                    群聊里「大家都署名、自己也署名」—— 用户明确要这个，不是 QQ 的省略做法。
                    点头像 / 名字进私人空间（那里才是「我」的档案页）。 */}
                {!segs && m.role === 'user' && selfProfile && !m.image && (
                  <div className={`mb-1.5 flex items-center justify-end gap-2.5 ${selectMode && deletable ? 'pr-7' : ''}`}>
                    {m.createdAt && (
                      <span className="text-[11px] text-[var(--text-3)]" title={fullTime(m.createdAt)}>
                        {hhmm(m.createdAt)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={onOpenSelf}
                      title="看我在私人空间的档案"
                      className="flex flex-row-reverse items-center gap-2.5 transition hover:opacity-85"
                    >
                      <Avatar name={selfProfile.name} avatar={selfProfile.avatar} emoji={selfProfile.emoji} size={40} />
                      <span className="text-[15px] font-semibold text-[var(--pink-deep)]">{selfProfile.name}</span>
                    </button>
                  </div>
                )}
                {/* 自己的消息：时间戳不再逐条显示（§19.6）——
                    改由下方「间隔超过 5 分钟」的居中分隔行统一承担。 */}
                <div className={`flex min-w-0 flex-1 items-end gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
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
                    const segKey = `${sessionKey}:${i}:${si}`
                    const segText = s.speaker ? `${s.speaker}：${s.text}` : s.text
                    return (
                      <div key={si} className="mb-2 flex min-w-0 flex-col items-start">
                        {/* 群聊分段说话人（§8.1 / §19.20）：像 QQ 一样「头像 + 名字」，
                            而且要跟私聊署名行同款 —— **放在气泡外面**、气泡属于署名行的下一层。
                            分段只给了名字串，按名字反查角色拿头像和 id；查不到就不套按钮（纯头像兜底）。 */}
                        {s.speaker &&
                          (() => {
                            const sp = visibleCharacters.find((c) => c.name === s.speaker)
                            const face = <Avatar name={s.speaker} avatar={sp?.avatar} emoji={sp?.emoji} size={40} />
                            return (
                              <div className={`mb-1.5 flex items-center gap-2.5 ${selectMode && deletable ? 'pl-7' : ''}`}>
                                {sp ? (
                                  <button
                                    type="button"
                                    onClick={() => onOpenProfile(sp.id)}
                                    title={`看 ${sp.name} 的介绍页`}
                                    className="flex items-center gap-2.5 transition hover:opacity-85"
                                  >
                                    {face}
                                    <span className="text-[15px] font-semibold text-[var(--pink-deep)]">
                                      {sp.name}
                                    </span>
                                  </button>
                                ) : (
                                  <div className="flex items-center gap-2.5">
                                    {face}
                                    <span className="text-[15px] font-semibold text-[var(--pink-deep)]">
                                      {s.speaker}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                        <div className="max-w-[85%] rounded-2xl bg-[var(--surface)] px-4 py-2 text-[15px] text-[var(--text)] sm:max-w-[72%]">
                          <div className="whitespace-pre-wrap"><KnowledgeText text={s.text} /></div>
                          {m.role === 'assistant' && s.text.trim() && (
                            <div className="mt-1 flex items-center gap-2">
                              {voiceComponents.tts_available && <button
                                onClick={() => speakText(segText, segKey)}
                                className={`text-[11px] transition hover:text-[var(--pink-deep)] ${
                                  playingKey === segKey ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'
                                }`}
                                title="朗读 / 停止这一段"
                              >
                                {playingKey === segKey ? '⏹ 停止' : '🔈 朗读'}
                              </button>}
                              {!active.memoryDisabled && <RememberButton
                                done={Boolean(remembered[segKey])}
                                onClick={() => void rememberThis(segKey, segText)}
                              />}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <>
                    {/* QQ 式「头像 + 名字」已上移到气泡列外面（§8.1） */}
                    {editingSeq === i ? (
                      // 编辑并重发（§15.5）：改这条 + 删掉后面所有再重新生成（Gemini 式）
                      <div className="w-full max-w-[85%] rounded-2xl border border-[var(--pink)] bg-[var(--surface)] p-2.5 sm:max-w-[72%]">
                        <textarea
                          className="textarea"
                          rows={3}
                          value={editDraft}
                          autoFocus
                          onChange={(e) => setEditDraft(e.target.value)}
                        />
                        <div className="mt-2 flex items-center gap-2">
                          <button className="btn sm" disabled={deleting || !editDraft.trim()} onClick={() => void editResend()}>
                            {deleting ? '处理中…' : '保存并重发'}
                          </button>
                          <button
                            className="btn ghost sm"
                            onClick={() => {
                              setEditingSeq(null)
                              setEditDraft('')
                            }}
                          >
                            取消
                          </button>
                          <span className="text-[11px] text-[var(--text-3)]">这条之后的对话会被删掉并重新生成</span>
                        </div>
                      </div>
                    ) : (
                    <div
                      onContextMenu={(e) => {
                        // 右键菜单只在正文气泡上出现（§19，像微信）—— 空白处的右键留给浏览器自己
                        if (!deletable || streaming || deleting) return
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, seq: i, dbId: m.dbId ?? '' })
                      }}
                      className={`${m.role === 'assistant' && tavernMode && cardDisplayMode === 'html' && activeCharacters[0]?.imported ? 'w-full' : ''} max-w-[85%] rounded-2xl px-4 py-2 text-[15px] sm:max-w-[72%] ${
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
                          <ChatAttachmentImage image={m.image} imageOrig={m.imageOrig} imageSource={m.imageSource} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void starThis(`${sessionKey}:${i}`, m)}
                          disabled={starred[`${sessionKey}:${i}`] || starring === `${sessionKey}:${i}`}
                          title={m.imageSource === 'video' ? '把视频首帧存入画廊' : '存入画廊'}
                          className={`absolute right-1 top-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]/85 px-1 py-0.5 text-[10px] leading-tight shadow backdrop-blur transition ${
                            starred[`${sessionKey}:${i}`]
                              ? 'border-[var(--pink)] text-[var(--pink-deep)]'
                              : 'text-[var(--text-3)] hover:border-[var(--pink)] hover:text-[var(--pink-deep)]'
                          }`}
                        >
                          ⭐
                        </button>
                        {/* 视频帧条（媒体-视频）：只在本次会话里显示 —— 帧不落库，刷新即回退成首帧一张。
                            点任意一帧看大图。 */}
                        {m.frames && m.frames.length > 1 && (
                          <div className="mt-1 flex max-w-[100%] gap-1 overflow-x-auto">
                            {m.frames.slice(1).map((fr, fi) => (
                              <button
                                key={`${sessionKey}:${i}:f${fi}`}
                                type="button"
                                onClick={() => setLightbox(fr)}
                                title={`第 ${fi + 2} 帧`}
                                className="shrink-0"
                              >
                                <img src={fr} alt={`第 ${fi + 2} 帧`} className="h-12 w-12 rounded object-cover" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {streaming && isLast && !m.content ? (
                      // 还没吐出第一个字 → 跳动的三点 + 一行轮换提示（§27）。
                      // 群聊时上面叠一行在场者头像，一看就知道是「她们在回」。
                      <WaitingBubble cast={activeCharacters} />
                    ) : (
                      <>
                        {tavernMode && m.role === 'assistant' && activeCharacters.length === 1 && activeCharacters[0].imported
                          ? <CardChatMessage text={m.content} character={activeCharacters[0]}
                              mode={tavernMode ? cardDisplayMode : 'chat'} depth={messages.length - 1 - i} streaming={streaming && isLast} />
                          : <div className="whitespace-pre-wrap"><KnowledgeText text={m.content} /></div>}
                      </>
                    )}
                    {/* 编辑并重发（§15.5 / §19.15）：以前只能靠右键，太隐蔽 ——
                        自己的纯文字消息给一个明显的小按钮（看图轮不给，原图没落库改不了）。 */}
                    {m.role === 'user' && !m.image && (
                      <div className="mt-1 flex justify-end">
                        <button
                          onClick={() => {
                            setEditingSeq(i)
                            setEditDraft(m.content)
                          }}
                          disabled={streaming || deleting || active.sandbox || active.readOnly}
                          className="text-[11px] text-white/75 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                          title={streaming ? '生成中，先等这一轮结束' : '改这句话，它之后的对话会被删掉并重新生成'}
                        >
                          ✎ 编辑
                        </button>
                      </div>
                    )}
                    {m.role === 'assistant' && m.content.trim() && (
                      <div className="mt-1 flex items-center gap-2">
                        {voiceComponents.tts_available && <button
                          onClick={() => speakText(m.content, `${sessionKey}:${i}`)}
                          className={`text-[11px] transition hover:text-[var(--pink-deep)] ${
                            playingKey === `${sessionKey}:${i}` ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'
                          }`}
                          title="朗读 / 停止这条回复"
                        >
                          {playingKey === `${sessionKey}:${i}` ? '⏹ 停止' : '🔈 朗读'}
                        </button>}
                        {!active.memoryDisabled && <RememberButton
                          done={Boolean(remembered[`${sessionKey}:${i}`])}
                          onClick={() => void rememberThis(`${sessionKey}:${i}`, m.content)}
                        />}
                        {/* 重新生成（§15.5）：删掉旧的这条真行，用截断的历史重新 POST。
                            看图轮没有原图 base64，不给入口。 */}
                        <button
                          onClick={() => void regenerate(i)}
                          disabled={streaming || deleting || isImageTurn(i) || active.sandbox || active.readOnly}
                          className="text-[11px] text-[var(--text-3)] transition hover:text-[var(--pink-deep)] disabled:cursor-not-allowed disabled:opacity-40"
                          title={isImageTurn(i) ? '看图那一轮暂不支持重新生成（原图没有落库）' : '重新生成这条回复（旧的会被替换掉）'}
                        >
                          <UiIcon name="refresh"/> 重新生成
                        </button>
                      </div>
                    )}
                    </div>
                    )}
                  </>
                )}
                </div>
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

        {/* 收起即停用候选；后续生成请求必须由 suggestionsEnabled 控制。 */}
        {!active?.sandbox && !active?.readOnly && !active?.memoryDisabled && <><NetworkAccess channel="core"/>{expert.enabled && <ToolEntry personaId={activePersonaId} onOpen={() => setToolCenterOpen(true)} />}</>}
        <ToolActivity events={toolEvents[sessionKey] || []} />
        {streaming && <div className="tool-entry-bar" role="status"><span>{waitNotice || '正在处理本轮消息…'}</span><button type="button" onClick={() => streamController.current?.abort()}>停止本轮</button></div>}
        {!active?.sandbox && !active?.readOnly && <section className="reply-suggestions composer-suggestions" aria-label="候选回复" data-enabled={suggestionsEnabled}>
          <div className="composer-media" aria-label="图片和视频附件">
            <button type="button" title="发送视频" aria-label="发送视频" disabled={streaming} onClick={() => videoRef.current?.click()}><UiIcon name="video" size={18}/></button>
            <button type="button" title="发送图片" aria-label="发送图片" disabled={streaming} onClick={() => fileRef.current?.click()}><UiIcon name="gallery" size={18}/></button>
          </div>
          <div className="composer-candidates"><div className="reply-suggestion-heading"><span>{suggestionsEnabled ? '候选回复' : '候选已停用'}</span></div>{suggestionsEnabled && <div id="visual-reply-candidates" className="reply-suggestion-chips">{suggestions.map(text => <button type="button" key={text} onClick={() => setInput(text)}>{text}</button>)}</div>}</div>
          <button className="composer-candidate-toggle" type="button" aria-expanded={suggestionsEnabled} aria-controls="visual-reply-candidates" onClick={() => {const enabled = !suggestionsEnabled;setSuggestionsEnabled(enabled);try {localStorage.setItem('xtr.visual.suggestions-enabled',String(enabled))} catch {}}}>{suggestionsEnabled ? '收起候选' : '启用候选'}</button>
        </section>}

        {active?.readOnly ? <footer className="border-t border-[var(--border)] px-4 py-3 text-sm text-[var(--text-2)]">{active.readOnlyHint||'只读会话，请在来源应用中继续对话。'}</footer> : <footer className="chat-composer-footer border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          {/* 待发出去的图（§19.17）：选图 / Ctrl+V 后先挂在这里，
              配文可以接着打，按发送（或回车）才真的发出去。 */}
          {pendingMedia.length > 0 && <div className="flex flex-wrap gap-2 p-2">
            {pendingMedia.map((item, index) => <div key={item.url} className="flex items-center gap-2 rounded-lg border border-[var(--border)] p-2">
              {item.file.type.startsWith('image/') ? <img src={item.url} alt={item.file.name} className="h-16 w-16 rounded object-cover" /> : <video src={item.url} className="h-16 w-16 rounded" muted />}
              <span className="max-w-40 truncate text-xs">{item.file.name}{item.analyzing ? ' · 抽帧中…' : item.error ? ` · ${item.error}` : item.frames.length ? ` · ${item.frames.length} 帧` : ''}</span>
              <button disabled={streaming} aria-label={`移除附件 ${index + 1}`} onClick={() => { URL.revokeObjectURL(item.url); updateMedia(mediaRef.current.filter(x => x !== item)) }}>✕</button>
            </div>)}
            <span className="text-xs">{pendingMedia.length}/10 个附件 · 本次最多发送 10 张图片/视频帧，图片最长边 1280px</span>
          </div>}
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => {void attachFiles(Array.from(e.target.files || []));e.target.value=''}}/>
          <input ref={videoRef} type="file" accept="video/*" className="hidden" onChange={e => {void attachFiles(Array.from(e.target.files || []));e.target.value=''}}/>
          <div className="composer-input-row">
            {voiceComponents.installed && <button type="button" className={'composer-hold '+(asr.listening ? 'is-listening' : '')} aria-label="按住说话" title="浏览器语音识别，可能使用浏览器厂商的在线服务；松手停止，结果填入输入框" disabled={streaming}
              onPointerDown={e => {e.preventDefault();if(!micAvailable){setNotice('当前浏览器暂不支持语音输入，请使用支持语音识别的浏览器并允许麦克风权限。');return}e.currentTarget.setPointerCapture(e.pointerId);if(!asr.listening)startAsr()}}
              onPointerUp={() => asr.stop()} onPointerCancel={() => asr.stop()} onLostPointerCapture={() => asr.stop()}
              onKeyDown={e => {if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();if(micAvailable)startAsr();else setNotice('当前浏览器暂不支持语音输入。')}}}
              onKeyUp={e => {if(e.key===' '||e.key==='Enter'){e.preventDefault();asr.stop()}}} onBlur={() => asr.stop()}>
              <UiIcon name="mic" size={21}/><span>{asr.listening ? '松手停止' : '按住说'}</span>
            </button>}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.innerWidth >= 768) {
                  e.preventDefault()
                  // 挂了图（§19.17）/ 挂了视频：回车 = 连帧带字一起发；纯文字还是走原来的 sendText
                  if (pendingMedia.some(x => x.analyzing || x.error)) return
                  if (pendingMedia.length) void sendMedia()
                  else void sendText()
                }
              }}
              rows={4}
              // Ctrl+V 粘图 / 粘视频（§16.11 / §19.17 / 媒体-视频）：先挂到待发区，可以接着写配文再发。
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter(f => /^(image|video)\//.test(f.type))
                if (files.length) { e.preventDefault(); void attachFiles(files) }
              }}
              placeholder={pendingMedia.length ? '给附件配句话，回车一起发送' : '输入消息…'}
              aria-label="聊天输入框" title="电脑端 Enter 发送，Shift+Enter 换行；支持粘贴图片与视频" className="input composer-textarea"
            />
            <button
              onClick={() => {
                if (pendingMedia.some(x => x.analyzing || x.error)) return
                if (pendingMedia.length) void sendMedia()
                else void sendText()
              }}
              disabled={streaming || pendingMedia.some(x => x.analyzing || x.error)}
              className="btn composer-send disabled:opacity-50"
            >
              发送
            </button>
          </div>
        </footer>}
      </section>

      {/* 手机端「设置」栏（§28）：电脑端聊天顶栏右边那一排功能（成员 / 提示词 / 通话 /
          自动记忆 / 画廊 / 删除 / 记忆 / 生成 / 通道）整块搬进来。
          只加 md:hidden —— 桌面端顶栏已有同样一套，不重复铺。 */}
      <section className={`flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-soft)] md:hidden ${tabCls('settings')}`}>
        <div className="mobile-settings overflow-y-auto px-4 py-4">
          <div className="mb-3 text-[12px] font-semibold tracking-wide text-[var(--text-3)]">设置</div>

          <div className="mobile-settings-card">
            <span className="eyebrow">功能</span>
            <div className="mobile-settings-grid">
              {voiceComponents.installed && active.kind === 'single' && !active.sandbox && !active.readOnly && <button className="status-action" onClick={openVoiceCall} disabled={streaming}><UiIcon name="phone"/>语音通话</button>}
              {active.kind === 'group' && (
                <button
                  className="status-action"
                  onClick={() => setRosterOpen(true)}
                  title="管理当前群聊成员"
                >
                  <span className="text-[16px]">👥</span>成员
                </button>
              )}
              <button
                className="status-action"
                onClick={() => setPromptOpen(true)}
                title="看提示词：此刻会发给模型的 system / 完整消息数组（不消耗 token）"
              >
                <span className="text-[16px]"><UiIcon name="search"/></span>提示词
              </button>

              <button
                className={`status-action disabled:opacity-40 ${autoMemory && !active?.memoryDisabled ? 'on' : ''}`}
                onClick={() => setAutoMemory((v) => !v)}
                disabled={active?.sandbox || active?.memoryDisabled}
                title="自动整理：按天整理事件到 03 待审核，原文与附件始终全量保存在本地"
              >
                <span className="text-[16px]"><UiIcon name="spark"/></span>
                {active?.memoryDisabled ? '测试会话不进记忆' : autoMemory ? '自动整理今日事件' : '自动整理 关'}
              </button>
              <button
                className="status-action"
                onClick={() => setGalleryOpen(true)}
                title="画廊：你主动收藏的重要图片（§9.4）"
              >
                <span className="text-[16px]"><UiIcon name="gallery"/></span>画廊
              </button>
              <button
                className={`status-action disabled:opacity-40 ${selectMode ? 'on' : ''}`}
                onClick={() => setSelectMode((v) => !v)}
                disabled={streaming || messages.length === 0}
                title="多选删除：勾选要删的消息（你自己的和角色的都行），真删（连带图片文件 / 画廊收藏 / 照片记忆）"
              >
                <span className="text-[16px]"><UiIcon name="delete"/></span>删除
              </button>
              <button
                className="status-action"
                onClick={() => setMemoryOpen(true)}
                title="短期记忆：核对当前文字、图片上下文及实际发送记录"
              >
                <span className="text-[16px]"><UiIcon name="memory"/></span>记忆
              </button>
            </div>
          </div>

          {/* 通道切换（§7）：仅切换提示词预设，模型来源统一使用小窝大脑 */}
          {tavernMode && <div className="mobile-settings-card mt-3">
            <span className="eyebrow">通道</span>
            <div className="flex gap-1.5">
              {(['normal', 'uncensored'] as Channel[]).map((ch) => (
                <button
                  key={ch}
                  onClick={() => saveConfig({ ...config, channel: ch })}
                  title={ch === 'normal' ? '常规提示词' : '无审查提示词（沿用小窝大脑）'}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[12px] transition ${
                    config.channel === ch
                      ? 'border-[var(--pink)] bg-[var(--pink)] text-white'
                      : 'border-[var(--border-strong)] text-[var(--text-2)] hover:border-[var(--pink)]'
                  }`}
                >
                  {ch === 'normal' ? '常规' : '🔓 无审查'}
                </button>
              ))}
            </div>
          </div>}
        </div>
      </section>

      {/* 右：状态栏。左缘同样有一条把手（§19.11）—— 这一栏靠右，所以往左拖才是变宽（dir=-1）。 */}
      <aside
        style={sideResize.style}
        className={`relative min-h-0 min-w-0 flex-1 overflow-hidden border-[var(--border)] bg-[var(--surface)] max-md:flex max-md:flex-col md:w-[var(--sb-w)] md:flex-none md:border-l ${tabCls('status')}`}
      >
        {/* 立绘轮播（§19）：给个自身上限，剩下的高度留给状态栏的 flex-1。
            手机端高度本来就紧，压到 34vh（桌面仍 46vh）——
            上面顶栏 + 底部 Tab 已经吃掉不少，46vh 会把状态栏挤没。 */}
        <div className="max-h-[34vh] shrink-0 overflow-y-auto md:max-h-[46vh]">
          <PortraitCarousel characters={activeCharacters} onOpenImage={setLightbox} />
        </div>
        <StatusSidebar
          session={active}
          characters={visibleCharacters}
          voiceName={engines.find((e) => e.id === speakEngine)?.name ?? '晓晓'}
          onVoiceCall={openVoiceCall}
          voiceInstalled={voiceComponents.installed}
          ttsAvailable={voiceComponents.tts_available}
          onPickVoice={openVoicePicker}
          onGeneratePhoto={() => setGenOpen(true)}
        />
        <div
          {...sideResize.handleProps}
          title="拖我改宽窄（双击恢复默认）"
          className="absolute left-0 top-0 z-20 hidden h-full w-2 -translate-x-1/2 cursor-col-resize select-none md:block"
        >
          <span className="pointer-events-none absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 bg-transparent transition-colors hover:bg-[var(--pink)]" />
        </div>
      </aside>

      {/* 音色选择浮层：先选引擎，后选音色 */}
      {expert.enabled && toolCenterOpen && <ToolDialog onClose={() => setToolCenterOpen(false)}><ToolCenter personaId={activePersonaId} sessionId={sessionKey} onExample={text => { setInput(text); setToolCenterOpen(false) }} /></ToolDialog>}
      {voiceCallOpen && active?.kind === 'single' && <VoiceCallPanel
        key={`${sessionKey}:voice`}
        name={activeCharacters[0]?.name || '角色'}
        setup={{ character_id: active.characterIds[0], persona_id: activePersonaId, session_id: sessionKey,
          base_url: route.chat.baseUrl, api_key: route.chat.apiKey, model: route.chat.model,
          max_tokens: config.maxTokens || null, uncensored: config.channel === 'uncensored', auto_memory: autoMemory && !active.memoryDisabled }}
        onClose={() => setVoiceCallOpen(false)}
        onHistory={() => {
          const sid = sessionKey
          void loadMessages(sid, undefined, 200).then(page => setHistory(previous => ({
            ...previous, [sid]: mergeStoredMessages(previous[sid] || [], page.items.map(toChatMessage)),
          }))).catch(() => {})
        }}
      />}
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
                  {speakEngine === 'piper'
                    ? 'piper 音色还没下载（跑 download_piper_voices.bat 后再回来）'
                    : '该引擎暂无可用音色'}
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

      {/* 生图浮层（§7）：已抽成独立组件 ImageGenOverlay，这里只管开关 */}
      <ImageGenOverlay
        open={genOpen}
        onClose={() => setGenOpen(false)}
        session={active}
        sessionKey={sessionKey}
        visibleCharacters={visibleCharacters}
        config={config}
        setLightbox={setLightbox}
        setErrorText={setErrorText}
        setGalleryOpen={setGalleryOpen}
      />

      {/* 短期上下文浮层：与私人空间的正式长期记忆分开 */}
      {memoryOpen && (
        <MemoryPanel
          lastSent={sentContexts[sessionKey]}
          context={buildOutbound(messages)}
          historyLimit={config.historyLimit}
          onInspect={() => { setMemoryOpen(false); setPromptOpen(true) }}
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
          {/* 编辑并重发（§15.5）已改为气泡里那个显眼的「✎ 编辑」按钮（§19.15），
              右键菜单里不再重复一份 —— 菜单保持「删除这条 / 多选…」两件事。 */}
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

      {/* 导入酒馆角色卡（🎴）：预览 → 确认才建角色。建完由 onImported 刷新列表并跳过去 */}
      {importFile && (
        <CardImportDialog file={importFile} route={importRoute} onClose={() => setImportFile(null)} onImported={onImported} />
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

      {/* 群聊阵容浮层（§25）：改谁在群里。存后端 settings，失败回滚并留在浮层里报错 */}
      <GroupRosterPanel
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        castable={visibleCharacters.filter((c) => c.id !== SELF_CHARACTER_ID)}
        roster={roster}
        onSave={async (ids) => {
          const prev = roster
          setRoster(ids) // 先乐观更新，界面立刻跟手
          try {
            await saveSettings({ group_roster: JSON.stringify(ids) })
          } catch (e) {
            setRoster(prev) // 写失败就回滚，别让界面显示一个没存下去的阵容
            throw e
          }
        }}
      />

      {/* 看提示词浮层（§24）：改完档案不生效时，用它核对此刻到底给模型发了什么 */}
      {promptOpen && active && (
        <PromptInspector
          open={promptOpen}
          onClose={() => setPromptOpen(false)}
          characterIds={active.characterIds}
          personaId={activePersonaId}
          // 走与外发同一条路（§27）：核对提示词时看到的条数与排版，
          // 就是真发出去的那份 —— 别让调试面板和实际请求差一截。
          model={buildOutbound(messages).some((m) => m.images.length) ? route.vision.model : route.chat.model}
          baseUrl={buildOutbound(messages).some((m) => m.images.length) ? route.vision.baseUrl : route.chat.baseUrl}
          maxTokens={config.maxTokens || null}
          cardDisplayMode={tavernMode ? cardDisplayMode : undefined}
          replySuggestions={suggestionsEnabled}
          messages={buildOutbound(messages)}
          uncensored={config.channel === 'uncensored'}
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
