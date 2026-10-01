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
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  // 图片：image = 显示用缩略图 URL；imageOrig = 原图 URL（原图被清理后为空，自动降级用缩略图）
  image?: string
  imageOrig?: string
  imageSource?: 'upload' | 'generated'
  // 群聊「一人分饰多角」回复：渲染用分段（按 **角色名** 拆分），content 为去掉角色名后的拼接正文（供朗读）
  kind?: 'text' | 'groups'
  segments?: { speaker: string; text: string }[]
  // 落库后的游标（seq = rowid），用于向上翻页；未落库的临时消息为空
  seq?: number
  // 落库后的行 id（'m-<hex>'）。单条真删、⭐ 存画廊的 message_id 级联都要它；
  // 未落库的临时消息为空 —— 那类消息只能从本地 state 剔除，删不了库。
  dbId?: string
}

// 大老大 = 用户本人（见 seed_characters.py 文件头 ⚠）。她有完整档案（介绍 / 立绘 /
// 两个形态 / 专属画廊），但不作为群聊的默认在场角色 —— 否则模型分饰多角时会以为要
// 「扮演大老大」，和用户自己发的消息打架。私聊照常生成，那是她画廊的落点。
export const SELF_CHARACTER_ID = 'dalaoda'

// 由当前角色列表生成默认会话：一个群聊 + 每个小糖人的私聊。
export function buildSessions(chars: CharacterProfile[]): ChatSession[] {
  const cast = chars.filter((c) => c.id !== SELF_CHARACTER_ID).map((c) => c.id)
  const group: ChatSession = {
    id: 'group',
    kind: 'group',
    name: '小糖人的家（群聊）',
    emoji: '🏠',
    subtitle: `${cast.length} 位都在场 · 默认`,
    characterIds: cast,
  }
  const singles: ChatSession[] = chars.map((c) => ({
    id: `single-${c.id}`,
    kind: 'single' as const,
    name: c.name,
    emoji: c.emoji,
    subtitle: c.alias,
    characterIds: [c.id],
  }))
  return [group, ...singles]
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