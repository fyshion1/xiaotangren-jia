// 会话 → 画廊归属的推导（《项目要求》§9.4）。
// 私聊自动归属于该角色；群聊 / 导入的会话没有单一归属，算「家 · 共用」。
// 聊天里的 ⭐、生图浮层的 ⭐、右键删除后的重载都用这一处规则，别各写一份。

import type { ChatSession } from '../data/chats'

/** 画廊归属：'' = 家共用，<charId> = 该角色专属。 */
export type Owner = string

export function ownerOf(session: ChatSession | undefined | null): Owner {
  if (!session) return ''
  if (session.kind === 'single') return session.characterIds[0] ?? ''
  return ''
}

/** 归属的中文显示名（画廊筛选 chips / 下拉用）。 */
export function ownerLabel(owner: Owner, characters: { id: string; name: string }[]): string {
  if (!owner) return '家 · 共用'
  return characters.find((c) => c.id === owner)?.name ?? owner
}
