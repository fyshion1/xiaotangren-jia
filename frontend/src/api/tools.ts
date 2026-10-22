export type ToolSettings = {
  enabled: boolean; web_enabled: boolean; pet_enabled: boolean; qq_enabled: boolean; owner_persona_id: string
  allowed_names: string[]; max_turns: number
  max_calls: number; timeout_seconds: number
}
export type ToolCapability = { name: string; label: string; description: string; example: string; group: string }
export type ToolGroup = { id: string; label: string; description: string; installed: boolean }
export type ToolConfig = { installed: boolean; groups: ToolGroup[]; web_search_installed?: boolean; config: ToolSettings; capabilities: ToolCapability[]; personas: { id: string; name: string }[] }
export type AgentEvent = {
  type: string; run_id?: string; phase?: string; turn?: number; call_id?: string
  name?: string; query?: string; ok?: boolean; code?: string; attempts?: number; truncated?: boolean
  output?: string; status?: string
}
export type ToolRun = { id: string; session_id: string; feature_id: string; status: string; created_at: number; events: AgentEvent[] }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/tools/${path}`, init)
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : '工具设置未能保存，请检查输入')
  return body
}
export const fetchToolConfig = () => request<ToolConfig>('config')
export async function saveToolConfig(config: ToolSettings) {
  const result = await request<ToolConfig>('config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Exploration-Dashboard': '1' }, body: JSON.stringify(config) })
  window.dispatchEvent(new Event('xtr:tools-changed'))
  return result
}
export const fetchToolRuns = (personaId = '', sessionId = '') => request<{ items: ToolRun[] }>(`runs?${new URLSearchParams({ persona_id: personaId, session_id: sessionId })}`)

export const toolLabels: Record<string, string> = { knowledge_search: '查个人知识资料', knowledge_read: '展开笔记出处', knowledge_propose: '补充知识草案', daily_life_record: '记录饮食运动', daily_life_query: '查询饮食运动', project_cost_record: '记录项目费用', project_cost_query: '查询项目费用', web_search: '联网搜索', lyrics_search: '查找歌词', reminder_draft: '提醒草稿' }
export const runLabels: Record<string, string> = { running: '执行中', completed: '已完成', stopped: '已保护性停止', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' }
toolLabels.lyrics_read = '读取歌词正文'
