import { useEffect, useState } from 'react'
import { fetchSettings, saveSettings } from '../api/client'

let revision = 0
let saving = false

export function useTavernMode() {
  const [enabled, setEnabled] = useState(false)
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    let alive = true
    const started = revision
    void fetchSettings().then(s => {
      if (!alive) return
      const available = s.tavern_installed === 'true'
      setInstalled(available)
      if (!saving && started === revision) {
        const next = available && s.tavern_mode === 'true'
        setEnabled(next); localStorage.setItem('xtr.tavern-mode', String(next))
      }
    }).catch(() => {})
    const changed = (e: Event) => setEnabled((e as CustomEvent<boolean>).detail)
    window.addEventListener('xtr:tavern-mode', changed)
    return () => { alive = false; window.removeEventListener('xtr:tavern-mode', changed) }
  }, [])
  const update = async (next: boolean) => {
    if (saving) return
    if (next && !installed) throw new Error('酒馆插件未安装')
    const previous = enabled
    saving = true
    revision++
    localStorage.setItem('xtr.tavern-mode', String(next))
    window.dispatchEvent(new CustomEvent('xtr:tavern-mode', { detail: next }))
    try {
      await saveSettings({ tavern_mode: String(next) })
    } catch (error) {
      localStorage.setItem('xtr.tavern-mode', String(previous))
      window.dispatchEvent(new CustomEvent('xtr:tavern-mode', { detail: previous }))
      throw error
    } finally { saving = false; revision++ }
  }
  return [enabled, update, installed] as const
}
