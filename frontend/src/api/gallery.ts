// 画廊 + 照片记忆 API（《项目要求》§9.4）。
// 画廊图 = 图片文件（走 /api/files 静态目录）+ 一段文字描述；
// 描述按 A 方案当成一条记忆进 §9.2 的 RAG，聊到相关话题时以「你有一张照片：…」注入。
// 归属（owner）：'' = 家共用，<charId> = 该角色专属 —— 私聊自动归属，画廊里可手改。

import { uploadAttachment } from './storage'

export type GalleryItem = {
  id: string
  session_id: string
  message_id: string
  owner: string
  orig: string
  thumb: string
  description: string
  in_memory: boolean
  memory_id: string
  created_at: string
}

async function asJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    let detail = ''
    try {
      detail = (await resp.json())?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

/** 不传 owner = 全量；传 '' 或 <charId> = 按归属过滤（空串是合法筛选值，别用 falsy 判断）。 */
export async function fetchGallery(owner?: string): Promise<GalleryItem[]> {
  const qs = new URLSearchParams({ limit: '500' })
  if (owner !== undefined) qs.set('owner', owner)
  const data = await asJson<{ items: GalleryItem[] }>(`/api/gallery?${qs}`)
  return data.items ?? []
}

// 聊天图片气泡的「⭐ 存入画廊」。同一归属下重复收藏是幂等的，不报错。
export async function starImage(payload: {
  orig: string
  session_id?: string
  message_id?: string
  description?: string
  owner?: string
  in_memory?: boolean
}): Promise<GalleryItem> {
  return asJson<GalleryItem>('/api/gallery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ in_memory: true, ...payload }),
  })
}

// 本地上传一张图进画廊：FileReader → dataURL → 落盘（/api/attachments）→ 收藏。
// 落盘目录用固定的 "gallery" 会话名 —— 画廊图不隶属任何聊天会话。
export async function uploadToGallery(
  file: File,
  opts: { owner?: string; description?: string } = {},
): Promise<GalleryItem> {
  const dataUrl = await readAsDataUrl(file)
  const saved = await uploadAttachment('gallery', dataUrl)
  if (!saved) throw new Error('图片上传失败（后端没起？或格式不支持）')
  return starImage({
    orig: saved.orig,
    description: opts.description ?? '',
    owner: opts.owner ?? '',
  })
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取本地文件失败'))
    reader.readAsDataURL(file)
  })
}

// 让 vision 模型看图写描述（save=true 时直接落库并同步那条照片记忆）
export async function describeImage(
  id: string,
  opts: {
    hint?: string
    save?: boolean
    base_url?: string
    api_key?: string
    model?: string
    uncensored?: boolean
  } = {},
): Promise<{ description: string; saved: boolean; item?: GalleryItem }> {
  return asJson(`/api/gallery/${id}/describe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ save: true, ...opts }),
  })
}

export async function updateGallery(
  id: string,
  patch: { description?: string; in_memory?: boolean; owner?: string },
): Promise<GalleryItem> {
  return asJson<GalleryItem>(`/api/gallery/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function deleteGallery(id: string): Promise<void> {
  await asJson(`/api/gallery/${id}`, { method: 'DELETE' })
}