// 记忆 API（《项目要求》§9.2 三层 RAG / §9.3 手动+自动记忆）。
// 三层：家记忆（home，共享）/ 个人记忆（personal，按 char_id）/ 会话上下文（不进库）。

export type MemoryItem = {
  id: string
  bucket: 'home' | 'personal'
  char_id: string
  text: string
  source: string // manual | auto | ...
  engine: string
  dim: number
  meta: Record<string, unknown>
  created_at: string
  score?: number
}

export type MemoryStatus = {
  engine: string
  signature: string
  available: boolean
  dim: number
  detail: string
  home_total: number
  personal_total: number
  // 换了 embedding 引擎后，用旧口径存下的向量条数（>0 就该点「重建索引」）
  stale_vectors: number
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

export async function fetchMemories(bucket?: string, char?: string): Promise<MemoryItem[]> {
  const qs = new URLSearchParams()
  if (bucket) qs.set('bucket', bucket)
  if (char) qs.set('char', char)
  qs.set('limit', '500')
  const data = await asJson<{ items: MemoryItem[] }>(`/api/memories?${qs}`)
  return data.items ?? []
}

export async function fetchMemoryStatus(): Promise<MemoryStatus | null> {
  try {
    return await asJson<MemoryStatus>('/api/memories/status')
  } catch {
    return null
  }
}

// 手动记一条（§9.3）。bucket 留空则由后端按会话类型推断（§9.2.2 打标规则）。
export async function rememberMemory(payload: {
  text: string
  bucket?: string
  char_id?: string
  session_kind?: string
  character_ids?: string[]
}): Promise<MemoryItem> {
  return asJson<MemoryItem>('/api/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucket: '',
      char_id: '',
      session_kind: 'group',
      character_ids: [],
      source: 'manual',
      meta: {},
      ...payload,
    }),
  })
}

export async function deleteMemory(memId: string): Promise<void> {
  await asJson(`/api/memories/${memId}`, { method: 'DELETE' })
}

export async function reindexMemories(): Promise<{ total: number; done: number; failed: number }> {
  return asJson('/api/memories/reindex', { method: 'POST' })
}

// ---- 自动记忆提取（§9.3）----
// 规则预筛在后端做（命中「记得/以后/约定」等词才叫 LLM），前端只管把最近几轮递过去。

export type ExtractTurn = { role: 'user' | 'assistant'; content: string; character_id?: string }

export type ExtractedMemory = { text: string; private: boolean; who: string }

export type ExtractResult = {
  triggered: boolean
  memories: ExtractedMemory[]
  saved: MemoryItem[]
}

export async function extractMemories(payload: {
  messages: ExtractTurn[]
  character_ids: string[]
  session_kind?: string
  force?: boolean
  preview?: boolean
  base_url?: string
  api_key?: string
  model?: string
  /** 功能命名空间（§9.6）：普通聊天留空；游戏 / 小窝外设传自己的 id，记忆互不串门。 */
  feature_id?: string
}): Promise<ExtractResult> {
  return asJson<ExtractResult>('/api/memories/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_kind: 'group',
      force: false,
      preview: false,
      ...payload,
    }),
  })
}