import { useEffect, useState } from 'react'
import { useExpertMode } from '../lib/expertMode'

type StartupSettings = { backend: boolean; frontend: boolean; qq_bridge: boolean; desktop_pet: boolean; autonomous_activity: boolean }

const options: { key: keyof StartupSettings; label: string; detail: string }[] = [
  { key: 'backend', label: '后端大脑', detail: '聊天、记忆和功能连接所需的基础服务。' },
  { key: 'frontend', label: '前端页面', detail: '提供电脑和局域网可访问的小窝页面。' },
  { key: 'qq_bridge', label: 'QQ 桥与网关', detail: '按已有账号配置连接 QQ；需要后端。' },
  { key: 'autonomous_activity', label: '自主活动插件', detail: '仅已安装且专家模式开启时启动；活动仍需要自行启用。' },
  { key: 'desktop_pet', label: '桌宠', detail: '启动桌面人物与聊天气泡；需要后端。' },
]

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`)
  return body
}

export default function StartupSettingsPanel() {
  const expert = useExpertMode()
  const [settings, setSettings] = useState<StartupSettings | null>(null)
  const [managed, setManaged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let live = true
    void request('/api/system/startup').then(body => {
      if (live) { setSettings(body.settings); setManaged(body.managed) }
    }).catch(e => { if (live) setError(String(e instanceof Error ? e.message : e)) })
    return () => { live = false }
  }, [])
  const change = (key: keyof StartupSettings, enabled: boolean) => {
    setSettings(current => {
      if (!current) return current
      const next = { ...current, [key]: enabled }
      if (key === 'backend' && !enabled) { next.qq_bridge = false; next.desktop_pet = false; next.autonomous_activity = false }
      if ((key === 'qq_bridge' || key === 'desktop_pet' || key === 'autonomous_activity') && enabled) next.backend = true
      return next
    })
    setNotice('')
  }
  const save = async () => {
    if (!settings) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await request('/api/system/startup', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
      setSettings(result.settings); setNotice(result.message)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="space-y-4" aria-label="启动与退出">
    <div className="nest-room-heading"><div><h2>启动与退出</h2>
      <p>勾选下次双击 BAT 时启动的服务。普通模式自动启动已安装的常规服务；自主活动插件需单独勾选。保存不会改变当前运行状态。</p>
    </div></div>
    <p className="text-sm">关闭总启动窗口，会一起关闭后端、前端、QQ 桥、网关、桌宠，以及从小窝启动的其他功能。</p>
    {!managed && <p role="status" className="text-sm">当前后端未由总启动器管理。下次使用 start.bat 启动后，关闭窗口即可统一退出。</p>}
    {settings && <div className="divide-y divide-[var(--border)]">{options.filter(option => option.key !== 'autonomous_activity' || expert.autonomy_installed).map(option =>
      <label key={option.key} className="flex cursor-pointer items-start gap-3 py-3">
        <input type="checkbox" className="mt-1" checked={settings[option.key]} disabled={busy}
          onChange={e => change(option.key, e.target.checked)} />
        <span><span className="block font-medium">{option.label}</span><span className="text-sm text-[var(--text-3)]">{option.detail}</span></span>
      </label>)}
    </div>}
    {settings && !settings.frontend && <p className="text-sm">前端关闭后，下次不会提供设置页面。可运行 start.bat --configure 在启动窗口调整，或用 start.bat --reset-startup 恢复全选。</p>}
    {settings && !settings.backend && <p className="text-sm">关闭后端会同时取消 QQ 桥和桌宠。下次可用 start.bat --configure 调整。</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <button className="btn sm" disabled={busy || !settings} onClick={() => void save()}>{busy ? '保存中…' : '保存下次启动设置'}</button>
  </section>
}
