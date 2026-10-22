import { useEffect, useState } from 'react'
import { fetchNestRunStatus, runNestFeature, stopNestFeature } from '../api/client'
import NestSettingsPanel from './NestSettingsPanel'

export default function DesktopPetPanel() {
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    let live = true
    const refresh = () => {
      // 后端不可达时保持上一次的显示（Block 二 ③）：别把状态条闪成「没跑」，
      // 那会让人以为桌宠自己停了、跑去重点一次。
      void fetchNestRunStatus('desktop_pet')
        .then(s => { if (live) setRunning(s.running) })
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  const toggle = async () => {
    setBusy(true); setNote('')
    try {
      if (running) { await stopNestFeature('desktop_pet'); setRunning(false); setNote('桌宠已停止。') }
      else {
        await runNestFeature('desktop_pet', { command: 'run' })
        const status = await fetchNestRunStatus('desktop_pet'); setRunning(status.running)
        setNote(status.running ? '桌宠已启动。Ctrl+Shift+Space 打开桌面聊天；托盘菜单可以退出。' : '桌宠未能保持运行，请到「跑起来」查看桌宠日志。')
      }
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <div className="space-y-5">
    <div className="rounded-2xl border border-purple-100 bg-purple-50/50 p-5">
      <div className="flex items-center justify-between gap-4">
        <div><h3 className="font-semibold text-purple-900">🐾 桌边的小糖人</h3><p className="mt-2 text-sm text-gray-600">桌面气泡可切换群聊或角色私聊；拖动人物或气泡标题栏一起移动，靠近边缘自动贴边。</p></div>
        <button className="shrink-0 rounded-xl bg-purple-500 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy} onClick={() => void toggle()}>{busy ? '请稍等…' : running ? '停止桌宠' : '启动桌宠'}</button>
      </div>
      <p className="mt-3 text-xs leading-6 text-gray-500">消息、当前用户身份和记忆沿用小窝的私聊或家庭群聊。大脑使用「小窝大脑 API」配置。</p>
      <p className="mt-1 text-xs leading-6 text-gray-500">气泡 ＋ / − 或右下角可调整大小，「停靠」可贴边或贴任务栏；聊天对象与尺寸会保存到这里，底部可切主题；切换聊天对象保留当前模型，外观区可选 Live2D 或 3D VRM。</p>
      {note && <p role="status" className="mt-3 text-sm text-purple-700">{note}</p>}
    </div>
    <NestSettingsPanel onlyId="desktop_pet" bare />
  </div>
}
