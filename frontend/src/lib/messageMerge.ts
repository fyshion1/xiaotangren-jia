import type { ChatMessage } from '../data/chats'

/** 合并服务器历史时，一条已落库消息只替换一条对应的临时消息。 */
export function mergeStoredMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const remaining = previous.filter((m) => !m.dbId)
  const byId = new Map(previous.filter((m) => m.dbId).map((m) => [m.dbId!, m]))
  for (const stored of incoming) {
    const match = remaining.findIndex((local) => local.role === stored.role && local.content === stored.content
      && (local.imageOrig || local.image || '') === (stored.imageOrig || stored.image || '')
      && JSON.stringify(local.segments || []) === JSON.stringify(stored.segments || []))
    const local = match >= 0 ? remaining.splice(match, 1)[0] : undefined
    if (stored.dbId) byId.set(stored.dbId, { ...local, ...stored, clientId: local?.clientId || byId.get(stored.dbId)?.clientId })
  }
  return [...[...byId.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0)), ...remaining]
}
