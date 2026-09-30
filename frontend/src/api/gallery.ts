// 画廊 + 照片记忆 API（《项目要求》§9.4）。
// 画廊图 = 图片文件（走 /api/files 静态目录）+ 一段文字描述；
// 描述按 A 方案当成一条家记忆进 §9.2 的 RAG，聊到相关话题时以「你有一张照片：…」注入。

export type GalleryItem = {
  id: string
  session_id: string
  message_id: string
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

export async function fetchGallery(): Promise<GalleryItem[]> {
  const data = await asJson<{ items: GalleryItem[] }>('/api/gallery?limit=500')
  return data.items ?? []
}

// 聊天图片气泡的「⭐ 存入画廊」。同一张图重复收藏是幂等的，不报错。
export async function starImage(payload: {
  orig: string
  session_id?: string
  message_id?: string
  description?: string
  in_memory?: boolean
}): Promise<GalleryItem> {
  return asJson<GalleryItem>('/api/gallery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ in_memory: true, ...payload }),
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
  patch: { description?: string; in_memory?: boolean },
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