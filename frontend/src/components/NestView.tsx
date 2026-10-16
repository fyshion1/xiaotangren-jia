// 糖人小窝（《项目要求》§9.6）：全家共同的回忆 + 一起玩的功能入口。
// 功能清单来自后端注册表（`/api/nest/features`，代码级真相源），前端不写死 ——
// 加功能只要在 backend/app/features_registry.py 加一条，并给它建一个独立项目 `features/<folder>/`。
// 记忆 / 模型调用都走「小窝大脑 API」（NestApiPanel），与聊天页的模型设置分开。
//
// ── 布局（§9.6.7）：抽屉 + 工作台 ─────────────────────────────────────────
// 以前这里把**所有**面板无条件排下去（大脑 API / 功能开关 / 跑起来 / 动态流 / Gemini /
// 英语 / 日语 / 画廊 / 世界书），一共十块、好几千行。一进小窝就把所有面板挂起来 ——
// 日语、英语那种上千行的面板你要是不用也在那儿发请求，整个页面长得拉不到底。
//
// 现在两件事：
//   ① 「一起玩」是一个**抽屉**：默认收起，点开才列出所有项目，上面有搜索框（项目多了也找得到）。
//   ② 「项目工作台」一次只挂 1~2 个面板：抽屉里点一个项目 = 送进工作台（tab 上有个 × 关掉就卸载）。
// 其余（设置 / 跑起来 / 动态流 / 画廊 / 世界书）各收成一个抽屉，默认全收起 ——
// **收起的抽屉里不渲染 children**，没展开的东西一丁点开销都没有。
//
// 手机端不碰：底部导航和 ◁ 返回在 App.tsx（§28 起固定），这里只改小窝 body。

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import GalleryGrid from './GalleryGrid'
import WorldbookPanel from './WorldbookPanel'
import EnglishStudyPanel from './EnglishStudyPanel'
import GeminiSyncPanel from './GeminiSyncPanel'
import JapaneseLabPanel from './JapaneseLabPanel'
import NestApiPanel from './NestApiPanel'
import NestDrawer from './NestDrawer'
import NestFeedPanel from './NestFeedPanel'
import NestRunnerPanel from './NestRunnerPanel'
import NestSettingsPanel from './NestSettingsPanel'
import { fetchAgentInbox, sendAgentMessage, type AgentMessage } from '../api/agents'
import { fetchNestFeatures, launchInteractiveHome, type NestFeature } from '../api/client'

// 只有后端注册表里 status='available' 的功能才有可点的入口；planned 的点了给一句规划中提示。
// 小窝本地的动作（Unity 启动 / 弹面板）在这里挂钩，不塞进后端注册表。
const AVAILABLE_ACTION: Record<string, 'unity' | 'panel' | 'runner'> = {
  interactive_home: 'unity',
  gemini_sync: 'panel',
  english_study: 'panel',
  japanese_lab: 'panel',
}

// 能进「项目工作台」的面板（本体内的 / 独立项目的都在这）。键 = 功能 id。
// 加一个可开的面板功能，就在这加一行 + 注册表里加一条 —— 别处不用动。
const WORKBENCH_PANELS: Record<string, { title: string; render: () => ReactNode }> = {
  japanese_lab: {
    title: '🌸 小糖人日语实验室',
    render: () => <JapaneseLabPanel />,
  },
  english_study: {
    title: '📖 英语学习',
    render: () => <EnglishStudyPanel />,
  },
  gemini_sync: {
    title: '🔗 Gemini 网页同步',
    render: () => <GeminiSyncPanel />,
  },
}

/** 工作台最多同时挂几个 —— 大老大要的「1~2 个」。开到第三个就把最旧的顶掉。 */
const MAX_WORKBENCH = 2
const OPEN_KEY = 'xtr.nestWorkbench'
const ACTIVE_KEY = 'xtr.nestWorkbenchActive'

const readStored = (key: string): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const STATUS_FILTERS: { id: '' | 'available' | 'planned'; label: string }[] = [
  { id: '', label: '全部' },
  { id: 'available', label: '可用' },
  { id: 'planned', label: '规划中' },
]

export default function NestView() {
  const [features, setFeatures] = useState<NestFeature[]>([])
  const [toast, setToast] = useState('')
  const [agentText, setAgentText] = useState('')
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([])
  const [agentBusy, setAgentBusy] = useState(false)
  // 「让功能跑起来」面板当前选中的功能 id（点卡片时滚过去并选中它）。
  const [runnerId, setRunnerId] = useState('')
  // 抽屉的开关 —— 全默认收起，进小窝看到的就是一屏。
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [feedOpen, setFeedOpen] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [worldbookOpen, setWorldbookOpen] = useState(false)
  // 抽屉里的搜索 / 筛选。
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | 'available' | 'planned'>('')
  // 工作台：开着哪几个面板 + 当前看的是哪个（存 localStorage，下次进来还在）。
  const [openIds, setOpenIds] = useState<string[]>(() => readStored(OPEN_KEY).filter((id) => id in WORKBENCH_PANELS))
  const [activePanel, setActivePanel] = useState<string>(() => localStorage.getItem(ACTIVE_KEY) || '')

  useEffect(() => { void fetchNestFeatures().then(setFeatures).catch(() => setFeatures([])) }, [])
  useEffect(() => { void fetchAgentInbox('xiaotangren-ui').then(setAgentMessages).catch(() => {}) }, [])

  useEffect(() => { localStorage.setItem(OPEN_KEY, JSON.stringify(openIds)) }, [openIds])
  useEffect(() => {
    if (activePanel) localStorage.setItem(ACTIVE_KEY, activePanel)
    else localStorage.removeItem(ACTIVE_KEY)
  }, [activePanel])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const byId = useMemo(() => new Map(features.map((f) => [f.id, f])), [features])

  // 抽屉里那串列表：先按搜索词滤，再按可用状态滤。搜名字 / emoji / 说明 / 目录名 / id ——
  // 「日语」「🌸」「japanese-lab」都能找到同一个。
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return features.filter((f) => {
      if (statusFilter && f.status !== statusFilter) return false
      if (!q) return true
      return [f.name, f.emoji, f.desc, f.id, f.folder].join(' ').toLowerCase().includes(q)
    })
  }, [features, query, statusFilter])

  // 最近用过的（工作台里开着的）—— 收起状态也摆在抽屉上面，省得每次都要点开找。
  const recent = openIds.map((id) => byId.get(id)).filter((f): f is NestFeature => !!f)

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

  // 把一个项目送进工作台：已经在就切过去；满了就把最旧的那个挤掉（大老大只要 1~2 个）。
  const openPanel = (id: string) => {
    setOpenIds((ids) => (ids.includes(id) ? ids : [...ids, id].slice(-MAX_WORKBENCH)))
    setActivePanel(id)
    setCatalogOpen(false)
    // 等工作台挂上再滚；下一个宏任务足够（React 这一帧就提交了）。
    window.setTimeout(() => {
      document.getElementById('nest-workbench')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  const closePanel = (id: string) => {
    const next = openIds.filter((x) => x !== id)
    setOpenIds(next)
    if (activePanel === id) setActivePanel(next[next.length - 1] ?? '')
  }

  const openTools = () => {
    setToolsOpen(true)
    window.setTimeout(() => {
      document.getElementById('nest-tools')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
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
      // 面板类：直接开进工作台（以前是「滚到下面那块」，现在下面一次只挂一两个）。
      openPanel(f.id)
      // 独立项目的面板连的是它自己的小服务 —— 面板一挂上就自己按注册表把 serve 拉起来，
      // 不用大老大再跑去「🚀 让功能跑起来」点一下（§9.6 安全边界不破：前端只报子命令名）。
      flash(f.id === 'japanese_lab' || f.id === 'english_study'
        ? `「${f.name}」开在工作台里了 —— 它的服务正在自动拉起来，一两秒就好。`
        : `「${f.name}」开在工作台里了 —— 顶上那个 tab 就是它，× 关掉就卸载。`)
      return
    }
    // 注册表里声明了 runner 的功能（如逛 B站）→ 在小窝里配置 + 启动，不用去终端敲命令。
    if (f.runner && f.runner.commands.length > 0) {
      setRunnerId(f.id)
      openTools()
      flash(`「${f.name}」在「🛠 设置与工具 → 🚀 让功能跑起来」里已选中 —— 选谁去看、怎么跑、日志都在那儿。`)
      return
    }
    // 其余都是独立项目：本体只提供大脑 API，不实现它的逻辑。
    flash(`「${f.name}」的实现是独立项目（features/${f.folder || f.id}/），` +
      (f.status === 'planned' ? '还在规划中 🏡' : '还没接进来。'))
  }

  const activeFeature = byId.get(activePanel)
  const panel = WORKBENCH_PANELS[activePanel]

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

      {/* ---- 一起玩：抽屉。收起时只露一行「最近用的」，点开才列全部 + 能搜 ---- */}
      <NestDrawer
        title="🎮 一起玩"
        hint="Fun · 每个功能一个独立项目"
        badge={features.length > 0 ? `${features.length} 个项目` : ''}
        open={catalogOpen}
        onToggle={() => setCatalogOpen((v) => !v)}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className="input min-w-[180px] flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) openFeature(matches[0])
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="搜项目 —— 名字 / 说明 / 目录名都行，回车直接开第一个"
          />
          {STATUS_FILTERS.map((s) => (
            <button key={s.id} className={`form-chip ${statusFilter === s.id ? 'on' : ''}`}
              onClick={() => setStatusFilter(s.id)}>{s.label}</button>
          ))}
        </div>

        {features.length === 0 ? (
          <p className="text-[13px] text-[var(--text-3)]">功能清单没拉到（后端没连上？）。</p>
        ) : matches.length === 0 ? (
          <p className="text-[13px] text-[var(--text-3)]">没有匹配「{query || statusFilter}」的项目。</p>
        ) : (
          // 一行一个、紧凑列表（不是两列大卡）—— 项目再多也塞得下，抽屉自己滚，不撑高页面。
          <div className="max-h-[min(60vh,520px)] space-y-1.5 overflow-y-auto pr-1">
            {matches.map((f) => {
              const openable = !!WORKBENCH_PANELS[f.id]
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => openFeature(f)}
                  className={`flex w-full items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-left transition hover:border-[var(--pink)] ${openIds.includes(f.id) ? 'border-[var(--pink)]' : ''}`}
                >
                  <span className="mt-0.5 text-[20px] leading-none">{f.emoji}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <b className="text-[14px] text-[var(--text)]">{f.name}</b>
                      <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">
                        {f.status === 'available' ? '可用' : '规划中'}
                      </span>
                      {openIds.includes(f.id) && (
                        <span className="text-[10px] text-[var(--pink-deep)]">● 工作台里开着</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--text-2)]">{f.desc}</span>
                    <span className="mt-0.5 block text-[11px] text-[var(--text-3)]">
                      {f.needs_vision ? '👁 用视觉' : '🙈 不用视觉'} · {f.folder ? `features/${f.folder}` : '在本体内'}
                      {f.runner ? ' · 🚀 可在小窝里启动' : ''}
                      {openable ? ' · 点一下开在工作台' : ''}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </NestDrawer>

      {/* 收起时露一行最近用的 —— 一般只用一两个，别让人每次都去抽屉里翻 */}
      {!catalogOpen && recent.length > 0 && (
        <div className="mb-3 -mt-1 flex flex-wrap items-center gap-2 px-1">
          <span className="text-[11px] text-[var(--text-3)]">最近用过</span>
          {recent.map((f) => (
            <button key={f.id} className={`form-chip ${activePanel === f.id ? 'on' : ''}`}
              onClick={() => { setActivePanel(f.id); document.getElementById('nest-workbench')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
              {f.emoji} {f.name}
            </button>
          ))}
        </div>
      )}

      {/* ---- 项目工作台：一次只挂 1~2 个面板。关掉 = 真的卸载，页面立刻变短 ---- */}
      <section id="nest-workbench" className="mb-4 scroll-mt-4">
        {openIds.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] px-4 py-6 text-center text-[13px] text-[var(--text-3)]">
            工作台空着 —— 上面「🎮 一起玩」里点一个项目，它就在这儿打开。
            <br />
            一次只开 1~2 个（一般是这个数）：<b>×</b> 关掉就等于卸下来，页面不会越用越长。
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {openIds.map((id) => {
                const f = byId.get(id)
                const meta = WORKBENCH_PANELS[id]
                return (
                  <span key={id}
                    className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition ${
                      activePanel === id
                        ? 'border-[var(--pink)] bg-[var(--pink-soft)] font-semibold text-[var(--pink-deep)]'
                        : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-3)] hover:border-[var(--pink)]'}`}>
                    <button type="button" onClick={() => setActivePanel(id)}>
                      {f?.emoji} {f?.name ?? meta?.title ?? id}
                    </button>
                    <button type="button" title="关掉（卸载这块面板）" className="px-0.5 opacity-60 hover:opacity-100"
                      onClick={() => closePanel(id)}>×</button>
                  </span>
                )
              })}
              {openIds.length < MAX_WORKBENCH && (
                <button className="btn ghost sm" onClick={() => setCatalogOpen(true)}>＋ 再开一个</button>
              )}
            </div>

            {panel ? (
              <>
                <div className="mb-2 text-[12px] text-[var(--text-3)]">
                  {panel.title}
                  {activeFeature && ` · ${activeFeature.desc}`}
                </div>
                {panel.render()}
              </>
            ) : (
              <p className="text-[13px] text-[var(--text-3)]">
                「{activePanel}」没有可开的面板 —— 它的入口在下面「🛠 设置与工具」里。
              </p>
            )}
          </>
        )}
      </section>

      {/* ---- 设置与工具：偶尔才碰的东西都收在这一个抽屉里 ---- */}
      <div id="nest-tools" className="scroll-mt-4">
        <NestDrawer
          title="🛠 设置与工具"
          hint="大脑 API / 功能开关 / 让功能跑起来 / Agent 协作"
          badge={toolsOpen ? '' : '收起'}
          open={toolsOpen}
          onToggle={() => setToolsOpen((v) => !v)}
        >
          <div className="space-y-4">
            {/* 通用外设接入层：Agent 协作（跨项目消息中转，不暴露内部上下文） */}
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="mb-1 flex items-center justify-between gap-2"><h2 className="font-bold">🤝 Agent 协作</h2><span className="text-[11px] text-[var(--text-3)]">通用消息中转</span></div>
              <p className="mb-3 text-[12px] text-[var(--text-2)]">给其他项目的 Agent 留言、交换协议或请求状态；具体功能和逻辑由独立项目处理。</p>
              <div className="flex gap-2">
                <input className="input min-w-0 flex-1" value={agentText} onChange={(e) => setAgentText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendToAgent() }} placeholder="写一条协作消息…" />
                <button className="btn sm" disabled={agentBusy || !agentText.trim()} onClick={() => void sendToAgent()}>发送</button>
              </div>
              {agentMessages.length > 0 && <div className="mt-3 max-h-48 space-y-2 overflow-y-auto">{agentMessages.slice(0, 12).map((m) => <div key={m.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px]"><b>{m.sender}</b><span className="mx-1 text-[var(--text-3)]">→</span>{String(m.payload.text ?? JSON.stringify(m.payload))}</div>)}</div>}
            </section>

            {/* 小窝大脑 API：全局默认 + 每功能覆盖 */}
            <NestApiPanel bare />

            {/* 功能的开关搬进前端（§9.6.5）：白名单 / 演谁 / 音色 / 表情包…改完立刻生效 */}
            <NestSettingsPanel features={features} bare />

            {/* 让独立功能跑起来：选谁去看 + 启动 + 看日志（不用去终端敲命令） */}
            <NestRunnerPanel features={features} activeId={runnerId} onActiveChange={setRunnerId} bare />
          </div>
        </NestDrawer>
      </div>

      {/* ---- 功能动态流：独立功能推回来的产出（§9.6）---- */}
      <NestDrawer
        title="📬 小糖人找到了什么"
        hint="功能推回来的东西都在这 · 收藏/不感兴趣会写回给功能"
        badge={feedOpen ? '' : '收起'}
        open={feedOpen}
        onToggle={() => setFeedOpen((v) => !v)}
      >
        <NestFeedPanel features={features} bare />
      </NestDrawer>

      {/* ---- 共同回忆 · 画廊：只看 owner='' 的那些（全家共用）---- */}
      <NestDrawer
        title="🖼 共同回忆 · 画廊"
        hint="全家的合照都放这儿"
        badge={galleryOpen ? '' : '收起'}
        open={galleryOpen}
        onToggle={() => setGalleryOpen((v) => !v)}
      >
        <GalleryGrid owner="" variant="home" bare />
      </NestDrawer>

      {/* ---- 家 · 共用世界书（§19）：群聊里生效的就是这一档 ---- */}
      <NestDrawer
        title="📖 家 · 共用世界书"
        hint="World Info · 关键词触发的设定集"
        badge={worldbookOpen ? '' : '收起'}
        open={worldbookOpen}
        onToggle={() => setWorldbookOpen((v) => !v)}
      >
        <WorldbookPanel owner="" ownerLabel="家 · 共用世界书" bare />
      </NestDrawer>
    </main>
  )
}