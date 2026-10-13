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
    imageSource: (s.image_source as 'upload' | 'generated' | 'video') || undefined,
    kind: s.kind === 'groups' ? 'groups' : 'text',
    segments: s.segments?.length ? s.segments : undefined,
    seq: s.seq,
    dbId: s.id,
    createdAt: s.created_at,
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
    if (!resp.ok) {
      // 不再静默：落库失败（后端没起 / 500）必须留痕，否则用户以为「聊天记录已经存了」
      console.warn(`保存消息失败 HTTP ${resp.status}（session=${sessionId}）`)
      return null
    }
    return (await resp.json()) as StoredMessage
  } catch (e) {
    console.warn(`保存消息失败（session=${sessionId}）:`, e)
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

export type DeleteResult = { deleted: number; files_removed: number; gallery_removed: number }
export type DeletePreview = { messages: number; images: number; gallery: number }

/** 预演真删会连带删掉多少图 / 画廊收藏（不改数据，确认框用它写文案）。 */
export async function previewDeleteMessages(ids: string[]): Promise<DeletePreview | null> {
  try {
    const resp = await fetch('/api/messages/delete-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!resp.ok) return null
    return (await resp.json()) as DeletePreview
  } catch {
    return null
  }
}

/** 真删若干条消息（QQ 式右键多选）：消息 + 不再被引用的图片文件 + 画廊收藏 + 照片记忆。 */
export async function deleteMessages(ids: string[]): Promise<DeleteResult | null> {
  try {
    const resp = await fetch('/api/messages/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!resp.ok) return null
    return (await resp.json()) as DeleteResult
  } catch {
    return null
  }
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
  current_session: string | null
  sessions: { session: string; orig_bytes: number; thumb_bytes: number }[]
  orig_bytes: number
  thumb_bytes: number
}

export async function attachmentStats(session: string): Promise<AttachmentStats> {
  const resp = await fetch(`/api/attachments/stats?session=${encodeURIComponent(session)}`)
  if (!resp.ok) throw new Error(`存储统计加载失败（HTTP ${resp.status}）`)
  return (await resp.json()) as AttachmentStats
}

export type VideoAnalyze = {
  task_id: string
  status: string
  frame_count: number
  frames: string[]
  commit_required: boolean
}

/** 上传视频 → 本地抽帧（后端 ffmpeg，完整视频不上模型）。失败抛 Error（后端 detail）。 */
export async function analyzeVideo(file: File): Promise<VideoAnalyze> {
  const fd = new FormData()
  fd.append('file', file)
  const resp = await fetch('/api/media/video/analyze', { method: 'POST', body: fd })
  if (!resp.ok) {
    let msg = `抽帧失败（HTTP ${resp.status}）`
    try {
      const data = (await resp.json()) as { detail?: unknown }
      if (data?.detail) msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
    } catch {
      /* 拿不到 detail 就用上面的兜底文案 */
    }
    throw new Error(msg)
  }
  return (await resp.json()) as VideoAnalyze
}

export async function clearOriginals(session: string): Promise<number> {
  if (!session.trim()) throw new Error('请先选择要清理的会话')
  const resp = await fetch(`/api/attachments/clear-originals?session=${encodeURIComponent(session)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  })
  const data = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(data?.detail ?? `清理失败（HTTP ${resp.status}）`)
  return data.removed as number
}

// ---- §9.4 画廊多文件上传（多选照片 + 多选视频）----
// 走 multipart 批量接口，不再一条一份 dataURL；后端按文件类型分流到 save_image / save_video。

export type SavedAttachment = {
  id: string
  session: string
  source: string
  kind: 'image' | 'video'
  width: number
  height: number
  size: number
  thumb: string
  orig: string
}

export type BatchUploadResult = {
  saved: SavedAttachment[]
  errors: { name: string; error: string }[]
}

/** 多文件上传（照片 / 视频混选都行）。单个文件超限不会拖垮整批 —— 只看 errors。 */
export async function uploadAttachmentsBatch(
  sessionId: string,
  files: File[],
  source: 'upload' | 'generated' = 'upload',
): Promise<BatchUploadResult> {
  const fd = new FormData()
  fd.append('session_id', sessionId)
  fd.append('source', source)
  for (const f of files) fd.append('files', f, f.name)
  const resp = await fetch('/api/attachments/batch', { method: 'POST', body: fd })
  const data = await resp.json().catch(() => null)
  if (!resp.ok) {
    const detail = data?.detail
    throw new Error(typeof detail === 'string' ? detail : `上传失败（HTTP ${resp.status}）`)
  }
  return { saved: data?.saved ?? [], errors: data?.errors ?? [] }
}

// ---- 存储管理（§15.3）：列出磁盘文件 → 用户勾选 → 确认后只删勾中的 ----

export type AttachmentFile = {
  name: string
  stem: string
  ext: string
  kind: 'image' | 'video'
  size: number
  mtime: number
  orig: string
  thumb: string
  /** 还被几处引用（幸存消息 + 画廊收藏）；> 0 表示删了会出现空图。 */
  refs: number
}

export type AttachmentList = { session: string; items: AttachmentFile[]; count: number }

export async function listAttachments(session: string): Promise<AttachmentList> {
  const resp = await fetch(`/api/attachments/list?session=${encodeURIComponent(session)}`)
  if (!resp.ok) throw new Error(`文件列表加载失败（HTTP ${resp.status}）`)
  return (await resp.json()) as AttachmentList
}

export type SelectiveDeleteResult = { removed: number; skipped: string[]; gallery_rows: number }

/** 只删勾选的文件（连带清理它们的画廊收藏）。names 为空后端会拒，绝不会「一点删光」。 */
export async function deleteAttachments(session: string, names: string[]): Promise<SelectiveDeleteResult> {
  const resp = await fetch('/api/attachments/delete-selected', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: session, names, confirmed: true }),
  })
  const data = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(data?.detail ?? `删除失败（HTTP ${resp.status}）`)
  return data as SelectiveDeleteResult
}
