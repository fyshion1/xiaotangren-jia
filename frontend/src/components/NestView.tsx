// 糖人小窝（《项目要求》§9.6）：全家共同的回忆 + 一起玩的功能入口。
// 功能清单来自后端注册表（`/api/nest/features`，代码级真相源），前端不写死 ——
// 加功能只要在 backend/app/features_registry.py 加一条，并给它建一个独立项目 `features/<folder>/`。
// 记忆 / 模型调用都走「小窝大脑 API」（NestApiPanel），与聊天页的模型设置分开。

import { useEffect, useState } from 'react'
import GalleryGrid from './GalleryGrid'
import WorldbookPanel from './WorldbookPanel'
import GeminiSyncPanel from './GeminiSyncPanel'
import NestApiPanel from './NestApiPanel'
import NestFeedPanel from './NestFeedPanel'
import NestRunnerPanel from './NestRunnerPanel'
import { fetchAgentInbox, sendAgentMessage, type AgentMessage } from '../api/agents'
import { fetchNestFeatures, launchInteractiveHome, type NestFeature } from '../api/client'

// 只有后端注册表里 status='available' 的功能才有可点的入口；planned 的点了给一句规划中提示。
// 小窝本地的动作（Unity 启动 / 弹面板）在这里挂钩，不塞进后端注册表。
const AVAILABLE_ACTION: Record<string, 'unity' | 'panel' | 'runner'> = {
  interactive_home: 'unity',
  gemini_sync: 'panel',
}

export default function NestView() {
  const [features, setFeatures] = useState<NestFeature[]>([])
  const [toast, setToast] = useState('')
  const [agentText, setAgentText] = useState('')
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([])
  const [agentBusy, setAgentBusy] = useState(false)
  // 「让功能跑起来」面板当前选中的功能 id（点卡片时滚过去并选中它）。
  const [runnerId, setRunnerId] = useState('')

  useEffect(() => { void fetchNestFeatures().then(setFeatures).catch(() => setFeatures([])) }, [])
  useEffect(() => { void fetchAgentInbox('xiaotangren-ui').then(setAgentMessages).catch(() => {}) }, [])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const sendToAgent = async () => {
    const text = agentText.trim()
    if (!text || agentBusy) return
    setAgentBusy(true)
    try {
      const sent = await sendAgentMessage({ sender: 'xiaotangren-ui', recipient: '*', conversation_id: 'nest', kind: 'message', payload: { text } })
      setAgentMessages((items) => [sent, ...items]); setAgentText('')
    } catch (e) { flash(e instanceof Error ? e.message : String(e)) }
    finally { setAgentBusy(false) }
  }

  const openFeature = (f: NestFeature) => {
    const action = AVAILABLE_ACTION[f.id]
    if (action === 'unity') {
      if (window.confirm('要进入互动小家吗？确认后将打开 Unity 项目。')) {
        void launchInteractiveHome().then(() => flash('Unity 互动小家已启动')).catch((e) => flash(`启动失败：${e instanceof Error ? e.message : String(e)}`))
      }
      return
    }
    if (action === 'panel') {
      // Gemini 同步的采集端是浏览器扩展，这里只把面板位置点出来。
      flash('Gemini 网页同步面板在下面「🔗 Gemini 网页同步」——先装浏览器扩展再回来配对。')
      document.getElementById('gemini-sync-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    // 注册表里声明了 runner 的功能（如逛 B站）→ 在小窝里配置 + 启动，不用去终端敲命令。
    if (f.runner && f.runner.commands.length > 0) {
      setRunnerId(f.id)
      document.getElementById('nest-runner-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      flash(`「${f.name}」在下面「🚀 让功能跑起来」里配置并启动 —— 选谁去看、怎么跑、日志都在那儿。`)
      return
    }
    // 其余都是独立项目：本体只提供大脑 API，不实现它的逻辑。
    flash(`「${f.name}」的实现是独立项目（features/${f.folder || f.id}/），` +
      (f.status === 'planned' ? '还在规划中 🏡' : '还没接进来。'))
  }

  return (
    <main className="mx-auto max-w-6xl overflow-y-auto px-4 pb-16 pt-5">
      <header className="mb-6">
        <h1 className="text-[26px] font-extrabold tracking-wide">🏠 糖人小窝</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">
          全家的共同回忆，和以后要接的一起玩。每个人的专属画廊在各自介绍页里；这里只放「家 · 共用」的那部分。
        </p>
      </header>

      {toast && (
        <div className="mb-4 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {toast}
        </div>
      )}

      {/* 一起玩的功能：清单来自后端注册表，前端不写死 */}
      <section className="mb-8">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-[20px] font-extrabold tracking-wide">🎮 一起玩</h2>
          <span className="text-[13px] text-[var(--text-3)]">Fun · 每个功能一个独立项目</span>
        </div>
        {features.length === 0 ? (
          <p className="text-[13px] text-[var(--text-3)]">功能清单没拉到（后端没连上？）。</p>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {features.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => openFeature(f)}
                className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-5 text-left transition hover:border-[var(--pink)]"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[22px]">{f.emoji}</span>
                  <span className="text-[15px] font-bold text-[var(--text)]">{f.name}</span>
                  <span className="ml-auto rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-3)]">
                    {f.status === 'available' ? '可用' : '规划中'}
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--text-2)]">{f.desc}</p>
                <p className="mt-2 text-[11px] text-[var(--text-3)]">
                  {f.needs_vision ? '👁 用视觉' : '🙈 不用视觉'} · {f.folder ? `features/${f.folder}` : '在本体内'}
                  {f.runner ? ' · 🚀 可在小窝里启动' : ''}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 通用外设接入层：Agent 协作（跨项目消息中转，不暴露内部上下文） */}
      <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
        <div className="mb-1 flex items-center justify-between gap-2"><h2 className="font-bold">🤝 Agent 协作</h2><span className="text-[11px] text-[var(--text-3)]">通用消息中转</span></div>
        <p className="mb-3 text-[12px] text-[var(--text-2)]">给其他项目的 Agent 留言、交换协议或请求状态；具体功能和逻辑由独立项目处理。</p>
        <div className="flex gap-2">
          <input className="input min-w-0 flex-1" value={agentText} onChange={(e) => setAgentText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendToAgent() }} placeholder="写一条协作消息…" />
          <button className="btn sm" disabled={agentBusy || !agentText.trim()} onClick={() => void sendToAgent()}>发送</button>
        </div>
        {agentMessages.length > 0 && <div className="mt-3 max-h-48 space-y-2 overflow-y-auto">{agentMessages.slice(0, 12).map((m) => <div key={m.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px]"><b>{m.sender}</b><span className="mx-1 text-[var(--text-3)]">→</span>{String(m.payload.text ?? JSON.stringify(m.payload))}</div>)}</div>}
      </section>

      {/* 小窝大脑 API：全局默认 + 每功能覆盖 */}
      <NestApiPanel />

      {/* 让独立功能跑起来：选谁去看 + 启动 + 看日志（不用去终端敲命令） */}
      <NestRunnerPanel features={features} activeId={runnerId} onActiveChange={setRunnerId} />

      {/* 功能动态流：独立功能推回来的产出（§9.6） */}
      <NestFeedPanel features={features} />

      <div id="gemini-sync-panel"><GeminiSyncPanel /></div>

      {/* 共同回忆 · 画廊：只看 owner='' 的那些（全家共用） */}
      <GalleryGrid owner="" variant="home" />

      {/* 家 · 共用世界书（§19）：群聊里生效的就是这一档；每人自己的那份在各自介绍页 */}
      <WorldbookPanel owner="" ownerLabel="家 · 共用世界书" />
    </main>
  )
}