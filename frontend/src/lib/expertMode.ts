import { useEffect, useSyncExternalStore } from 'react'

type ExpertState = { enabled: boolean; autonomy_installed: boolean; loaded: boolean; qq_accounts?: { self_id: string; name: string }[] }
let state: ExpertState = { enabled: false, autonomy_installed: false, loaded: false }
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()
function publish(next: ExpertState) { state = next; listeners.forEach(listener => listener()) }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function refreshExpert() {
  if (!pending) pending = fetch('/api/expert').then(async response => {
    if (!response.ok) throw new Error('专家模式状态未能读取')
    publish({ ...await response.json(), loaded: true })
  }).finally(() => { pending = null })
  return pending
}
export async function setExpertMode(enabled: boolean, passphrase = '', qq_self_id = '') {
  const response = await fetch('/api/expert', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Exploration-Dashboard': '1' }, body: JSON.stringify({enabled, passphrase, qq_self_id}) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || '专家模式设置失败')
  publish({ ...body, loaded: true })
  window.dispatchEvent(new Event('xtr:tools-changed'))
}
export function useExpertMode() {
  const value = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    void refreshExpert().catch(() => {})
    const refresh = () => { void refreshExpert().catch(() => {}) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  return value
}
