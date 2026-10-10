// 会话（聊天）模型。对齐《项目要求》§8「群聊/私聊 = 一或多个在场角色」。
// 目前前端只做「会话组织 + 状态壳子」，人设 Prompt 组装在阶段 2 接入。

import type { CharacterProfile } from './characters'

export type SessionKind = 'group' | 'single' | 'imported'

export type ChatSession = {
  id: string
  kind: SessionKind
  name: string
  emoji: string
  subtitle: string
  characterIds: string[] // 在场角色（imported 为空，暂无人设）
  readOnly?: boolean
  memoryDisabled?: boolean
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  // 图片：image = 显示用缩略图 URL；imageOrig = 原图 URL（原图被清理后为空，自动降级用缩略图）
  image?: string
  imageOrig?: string
  imageSource?: 'upload' | 'generated' | 'video'
  // 视频帧：从上传视频抽出的帧 URL 列表（《项目要求》媒体-视频一节）；
  // 抽帧结果只保存在内存里，不落库 —— 刷新后回退为只显示 image（第一帧）。
  frames?: string[]
  // 群聊「一人分饰多角」回复：渲染用分段（按 **角色名** 拆分），content 为去掉角色名后的拼接正文（供朗读）
  kind?: 'text' | 'groups'
  segments?: { speaker: string; text: string }[]
  // 落库后的游标（seq = rowid），用于向上翻页；未落库的临时消息为空
  seq?: number
  // 落库后的行 id（'m-<hex>'）。单条真删、⭐ 存画廊的 message_id 级联都要它；
  // 未落库的临时消息为空 —— 那类消息只能从本地 state 剔除，删不了库。
  dbId?: string
  /** 落库时间（SQLite 的 `datetime('now')`，UTC，形如 '2026-10-02 05:39:12'）。
   *  未落库的临时消息为空 —— 界面上那几秒不显示时间戳，落库回填后补上（§19）。 */
  createdAt?: string
}

// 默认身份（大老大）的 id。同时也是「会话 id 不加后缀」的那个身份（§22）。
export const MAIN_PERSONA_ID = 'dalaoda'

// 兼容旧引用：大老大以前混在 characters 里，现在搬到「私人空间」的档案里（§22）。
export const SELF_CHARACTER_ID = MAIN_PERSONA_ID

/**
 * 用户身份的会话隔离（§22）：**每个身份各自一条聊天记录**（用户拍板）。
 *
 * 默认身份保持原样（`group` / `single-<charId>`），这样老库里已有的历史一条不丢；
 * 其余身份一律加 `"<身份>@"` 前缀（如 `xizi@group`）。
 * 记忆不受影响 —— 记忆以角色 id 为键，与用户视角无关。
 */
export function personaSessionId(personaId: string, sessionId: string): string {
  if (sessionId === 'gemini-test') return sessionId
  return !personaId || personaId === MAIN_PERSONA_ID ? sessionId : `${personaId}@${sessionId}`
}

/** 能作为「可聊角色」出场的身份档案：不是当前身份，且档案上的开关打开（§22）。 */
export function personasAsCast(profiles: CharacterProfile[], activePersonaId: string): CharacterProfile[] {
  return profiles.filter((p) => p.id !== activePersonaId && p.asCharacter)
}

// 由当前角色列表生成默认会话：一个群聊 + 每个小糖人的私聊。
//
// `extra` 是「别的身份」在当前视角下现身的样子（§22）：切到汐子时，大老大会作为一位
// 可聊角色加进来。会话 id 照旧 `group` / `single-dalaoda` —— 隔离靠 personaSessionId
// 加前缀，与阵容本身无关。
//
// `roster`（§25）＝ 群聊阵容：settings 里的 `group_roster`（角色 id 的 JSON 数组）。
// 传了非空数组就只留这些人在群里；不传 / 传空 / 传 null ＝ 全员在场（老行为不变）。
// 注意：阵容只影响群聊的 characterIds，私聊一条不少 —— 「不在场」是暂时不想让她插话，
// 不是把她从家里删掉。
export function buildSessions(
  chars: CharacterProfile[],
  extra: CharacterProfile[] = [],
  roster?: string[] | null,
): ChatSession[] {
  const everyone = chars.filter((c) => c.id !== SELF_CHARACTER_ID).map((c) => c.id)
  // 空数组当「没设置」处理：空阵容会让后端回退成全员在场，不如这里就认成全员。
  // 只保留仍然存在的角色 —— 阵容里可能留着已删角色的 id。
  const cast = roster && roster.length > 0 ? everyone.filter((id) => roster.includes(id)) : everyone
  const group: ChatSession = {
    id: 'group',
    kind: 'group',
    name: '小糖人的家（群聊）',
    emoji: '🏠',
    subtitle: `${cast.length} 位在场 · 可编辑`,
    characterIds: cast.length > 0 ? cast : everyone,
  }
  const singles: ChatSession[] = chars.map((c) => ({
    id: `single-${c.id}`,
    kind: 'single' as const,
    name: c.name,
    emoji: c.emoji,
    subtitle: c.alias,
    characterIds: [c.id],
  }))
  const extraSingles: ChatSession[] = extra.map((p) => ({
    id: `single-${p.id}`,
    kind: 'single' as const,
    name: p.name,
    emoji: p.emoji,
    subtitle: p.alias || '另一份身份档案',
    characterIds: [p.id],
  }))
  const geminiTest: ChatSession = {
    id: 'gemini-test', kind: 'group', name: 'test · Gemini', emoji: '🔄',
    subtitle: '网页同步 · 不进入记忆', characterIds: everyone,
    readOnly: true, memoryDisabled: true,
  }
  return [group, geminiTest, ...singles, ...extraSingles]
}

// ---- 右侧状态栏（壳子）----
export type CharacterStatus = {
  mood: string // 现在的心情
  location: string // 地点
  relation: string // 与你的关系
  bond: number // 羁绊 0-100
  desire: string // 渴望
}

// 占位状态。后续可替换为「据上下文动态读取」。
export const DEFAULT_STATUS: Record<string, CharacterStatus> = {
  dashiyin: { mood: '害羞', location: '电影院', relation: '恋人', bond: 72, desire: '想被你牵着走' },
  xiaoshiyin: { mood: '开心', location: '游乐园', relation: '家人', bond: 85, desire: '想和你分着吃糖' },
  xiaobai: { mood: '平静', location: '天台晒太阳', relation: '熟人', bond: 40, desire: '想被摸头' },
  xiaohongshutou: { mood: '兴奋', location: '操场', relation: '好朋友', bond: 58, desire: '想赢你一次' },
}

// 推荐回复（壳子，示例文案）
export function suggestionsFor(session: ChatSession): string[] {
  if (session.kind === 'group')
    return ['大家今天过得怎么样？', '谁想一起烤小饼干？', '给我讲讲你们最近的事吧']
  return ['你今天过得怎么样？', '陪我聊聊天吧', '给我讲个故事吧']
}
