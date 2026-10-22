export type MemoryDocument = {
  id: string; persona_id: string; text: string; path: string; revision: string
  allow_injection?: boolean; summary?: string; details?: string; occurred_at?: string; redact?: boolean; aliases?: Record<string,string>
  category: 'experience' | 'bond' | 'promise' | 'vision'
  scope: 'personal' | 'shared'; character_ids: string[]
  state: 'active' | 'completed' | 'paused' | 'cancelled' | 'expired'
  review_status: 'pending' | 'approved' | 'rejected' | 'archived' | 'expired'
  expires_at?: string; keep_pending?: boolean; automatic?: boolean; superseded_by?: string
  integration_records?: {id:string;revision:string}[]
  source: string; created_at: string; inject: boolean; core: boolean
  evidence?: { role?: string; content?: string }[]; feature_id?: string
  related_reviewed?: { id: string; text: string; review_status: string; reason: string; source_ids: string[] }[]
}
export const MEMORY_CATEGORIES = { experience: '共同经历', bond: '羁绊', promise: '约定', vision: '长期愿景' }

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`)
  return data as T
}

export function fetchMemoryWorkflow(personaId: string) {
  return request<{ sources?: {path:string;day:string;session_id:string;message_count:number}[]; runs?: {session_id:string;day:string;status:string;detail:string}[]; candidates: MemoryDocument[]; approved: MemoryDocument[]; source_count: number; fact_candidates: { path: string; text: string; title?: string }[] }>(`/api/memory-workflow?persona_id=${encodeURIComponent(personaId)}`)
}
export function proposeMemory(body: {
  persona_id: string; text: string; character_ids: string[]; category?: string; scope?: string
  session_id?: string; messages?: { role: string; content: string }[]; legacy_id?: string
}) { return request<MemoryDocument>('/api/memory-workflow/candidates', body) }

export function reviewMemory(item: MemoryDocument, action: string, changes: Partial<MemoryDocument> = {}) {
  return request<MemoryDocument>(`/api/memory-workflow/${encodeURIComponent(item.id.replace(/^file:/, ''))}/review`, {
    persona_id: item.persona_id, revision: item.revision, action, changes,
  })
}

export function mergeMemoryCandidates(persona_id: string, items: MemoryDocument[]) {
  return request<MemoryDocument>('/api/memory-workflow/merge', { persona_id, records: items.map(m => ({ id: m.id, revision: m.revision })) })
}
export function archiveMemoryHistory(persona_id: string) {
  return request<{ archived: number }>('/api/memory-workflow/archive-history', { persona_id })
}

export function organizeMemories(persona_id: string, config: {base_url?:string;api_key?:string;model?:string}) {
  return request<{drafts:MemoryDocument[];detail:string}>('/api/memory-workflow/organize', {persona_id, ...config})
}

export function integrateMemories(persona_id: string, items: MemoryDocument[], config: {base_url?:string;api_key?:string;model?:string}) {
  return request<MemoryDocument>('/api/memory-workflow/integrate', {persona_id, records:items.map(m=>({id:m.id.replace(/^file:/,''),revision:m.revision})), ...config})
}
