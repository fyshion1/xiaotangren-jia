export type Reminder = {
  id: string; persona_id: string; title: string; due_at: number; revision: number
  status: 'draft' | 'scheduled' | 'due' | 'dismissed' | 'cancelled' | 'expired'
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/reminders${path}`, init)
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : '提醒操作未完成，请重试')
  return body
}
export const fetchReminders = (dueOnly = false) => request<{ items: Reminder[]; persona_id: string }>(dueOnly ? '/due' : '')
export async function changeReminder(item: Reminder, action: 'confirm' | 'cancel' | 'dismiss' | 'edit', title?: string, due_at?: string) {
  const result = await request<Reminder>(`/${encodeURIComponent(item.id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, revision: item.revision, ...(title !== undefined ? { title, due_at } : {}) }),
  })
  window.dispatchEvent(new Event('xtr:reminders-changed'))
  return result
}
export const reminderTime = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
export const reminderLabels: Record<Reminder['status'], string> = { draft: '待确认', scheduled: '等待提醒', due: '已到时间', dismissed: '已读', cancelled: '已取消', expired: '草稿已过期' }
