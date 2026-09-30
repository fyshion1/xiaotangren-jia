// 与后端通信封装：聊天记录持久化 / 附件上传（《项目要求》§15）。
// 文本进库、媒体落盘；图片先传到 /api/attachments 拿引用 URL，再把 URL 存进消息。

import type { ChatMessage } from '../data/chats'

export type StoredMessage = {
  id: string
  seq: number
  session_id: string
  role: 'user' | 'assistant'
  content: string
  image: string
  image_source: string
  kind: 'text' | 'groups'
  segments: { speaker: string; text: string }[]
  created_at?: string
}

export type MessagePage = {
  items: StoredMessage[]
  total: number
  next_cursor: number | null
  has_more: boolean
}

// 库里存的 StoredMessage → 前端渲染用 ChatMessage
export function toChatMessage(s: StoredMessage): ChatMessage {
  return {
    role: s.role,
    content: s.content,
    image: s.image ? thumbOf(s.image) : undefined,
    imageOrig: s.image || undefined,
    imageSource: (s.image_source as 'upload' | 'generated') || undefined,
    kind: s.kind === 'groups' ? 'groups' : 'text',
    segments: s.segments?.length ? s.segments : undefined,
    seq: s.seq,
  }
}

// 消息 → 落库 payload（不存 dataURL，只存附件引用 URL）
// 库里 image 存「原图 URL」，缩略图 URL 由它推导（见 thumbOf），原图被清理时自动降级。
function toPayload(sessionId: string, m: ChatMessage) {
  return {
    session_id: sessionId,
    role: m.role,
    content: m.content,
    image: m.imageOrig ?? m.image ?? '',
    image_source: m.imageSource ?? '',
    kind: m.kind === 'groups' ? 'groups' : 'text',
    segments: m.segments ?? [],
  }
}

// /api/files/{sess}/orig/{id}.png → /api/files/{sess}/thumb/{id}.jpg
export function thumbOf(origUrl: string): string {
  if (!origUrl) return ''
  return origUrl.replace('/orig/', '/thumb/').replace(/\.[^./]+$/, '.jpg')
}

export async function saveMessage(sessionId: string, m: ChatMessage): Promise<StoredMessage | null> {
  try {
    const resp = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPayload(sessionId, m)),
    })
    if (!resp.ok) return null
    return (await resp.json()) as StoredMessage
  } catch {
    return null
  }
}

export async function loadMessages(sessionId: string, before?: number, limit = 30): Promise<MessagePage> {
  const qs = new URLSearchParams({ session: sessionId, limit: String(limit) })
  if (before) qs.set('before', String(before))
  try {
    const resp = await fetch(`/api/messages?${qs}`)
    if (!resp.ok) return { items: [], total: 0, next_cursor: null, has_more: false }
    return (await resp.json()) as MessagePage
  } catch {
    return { items: [], total: 0, next_cursor: null, has_more: false }
  }
}

export async function clearMessages(sessionId: string): Promise<void> {
  await fetch(`/api/messages?session=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {})
}

// 把 dataURL 上传成附件，返回原图/缩略图引用 URL，失败返回 null（降级：直接塞 dataURL）
export async function uploadAttachment(
  sessionId: string,
  dataUrl: string,
  source: 'upload' | 'generated' = 'upload',
): Promise<{ orig: string; thumb: string; id: string } | null> {
  try {
    const resp = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, data_url: dataUrl, source }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    return { orig: data.orig, thumb: data.thumb, id: data.id }
  } catch {
    return null
  }
}

export type AttachmentStats = {
  sessions: { session: string; orig_bytes: number; thumb_bytes: number }[]
  orig_bytes: number
  thumb_bytes: number
}

export async function attachmentStats(): Promise<AttachmentStats | null> {
  try {
    const resp = await fetch('/api/attachments/stats')
    if (!resp.ok) return null
    return (await resp.json()) as AttachmentStats
  } catch {
    return null
  }
}

export async function clearOriginals(session?: string): Promise<number> {
  const qs = session ? `?session=${encodeURIComponent(session)}` : ''
  try {
    const resp = await fetch(`/api/attachments/clear-originals${qs}`, { method: 'POST' })
    if (!resp.ok) return 0
    return ((await resp.json()) as { removed: number }).removed
  } catch {
    return 0
  }
}