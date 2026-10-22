export type KnowledgeDocument = { id: string; title: string; path: string; source: string; chunks: number; warning: string; source_changed: boolean; related_versions: { title: string; source: string }[] }
export type KnowledgeProposal = { id: string; doc_id: string; title: string; path: string; body: string; kind: string; anchor: string; created_at: string }
export type KnowledgeHit = { id: string; doc_id: string; title: string; text: string; path: string; source: string; region: string; themes: string; year_start: number | null; year_end: number | null; uncertain: number; start_line: number; end_line: number; warning: string; related_versions: string[]; alternative_sources: string[]; partial_time_match?: boolean }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/knowledge${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '知识资料操作失败')
  return data
}
export const loadKnowledge = () => request<{ persona_id: string; sources: { path: string; bytes: number }[]; documents: KnowledgeDocument[]; proposals: KnowledgeProposal[] }>('')
export const importKnowledge = (paths: string[]) => request<{ items: { status: string }[] }>('/import', { paths })
export const indexKnowledge = () => request<{ done: number; total: number; remaining: number }>('/index', {})
export const searchKnowledge = (query: string, region: string, year_start?: number, year_end?: number) => request<{ items: KnowledgeHit[]; mode: string; note: string }>('/search', { query, region, year_start, year_end })
export const readKnowledge = (id: string) => request<{ content: string; sha256: string }>(`/documents/${encodeURIComponent(id)}`)
export const proposeKnowledge = (doc_id: string, body: string, kind: string, anchor: string) => request('/proposals', { doc_id, body, kind, anchor })
export const decideKnowledge = (id: string, action: 'confirm' | 'reject') => request(`/proposals/${encodeURIComponent(id)}`, { action })
