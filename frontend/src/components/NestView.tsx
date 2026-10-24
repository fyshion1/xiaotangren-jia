import CharacterAssetsPanel from './CharacterAssetsPanel'
import PluginManager from './PluginManager'
import {themeInstalled} from '#theme/config'
import { useTavernMode } from '../lib/tavernMode'
import TavernSettings from './TavernSettings'
import UiIcon from '../visual/UiIcon'
import NestHero from '../visual/NestHero'
import NestWelcomeSettings from '../visual/NestWelcomeSettings'
import NestStickerEditor from '../visual/NestStickerEditor'
import '../visual/nest-layout.css'
// 糖人小窝（《项目要求》§9.6）：全家共同的回忆 + 一起玩的功能入口。
// 功能清单来自后端注册表（`/api/nest/features`，代码级真相源），前端不写死 ——
// 加功能只要在 backend/app/features_registry.py 加一条，并给它建一个独立项目 `features/<folder>/`。
// 记忆 / 模型调用都走「小窝大脑 API」（NestApiPanel），聊天与所有小窝功能统一使用这里的大脑配置。
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
import EnglishStudyPanel from './EnglishStudyPanel'
import GeminiSyncPanel from './GeminiSyncPanel'
import JapaneseLabPanel from './JapaneseLabPanel'
import NestApiPanel from './NestApiPanel'
import ComputeSettings from './ComputeSettings'
import ProcessPanel from './ProcessPanel'
import PluginPanel from './PluginPanel'
import ExpertModeControl from './ExpertModeControl'
import { useExpertMode } from '../lib/expertMode'
import StoragePanel from './StoragePanel'
import NestDrawer from './NestDrawer'
import NestFeedPanel from './NestFeedPanel'
import NestRunnerPanel from './NestRunnerPanel'
import QqBridgePanel from './QqBridgePanel'
import DesktopPetPanel from './DesktopPetPanel'
import ToolCenter from './ToolCenter'
import ProjectCostsPanel from './ProjectCostsPanel'
import { fetchNestFeatures, launchInteractiveHome, type NestFeature } from '../api/client'

// 只有后端注册表里 status='available' 的功能才有可点的入口；planned 的点了给一句规划中提示。
// 小窝本地的动作（Unity 启动 / 弹面板）在这里挂钩，不塞进后端注册表。
const AVAILABLE_ACTION: Record<string, 'unity' | 'panel' | 'runner'> = {
  project_costs: 'panel',
  desktop_pet: 'panel',
  interactive_home: 'unity',
  gemini_sync: 'panel',
  english_study: 'panel',
  japanese_lab: 'panel',
  // QQ 桥虽然也有 runner，但它要先把外面的网关开起来 —— 有自己的面板，不放「设置与工具」里。
  qq_bridge: 'panel',
}

// 能进「项目工作台」的面板（本体内的 / 独立项目的都在这）。键 = 功能 id。
// 加一个可开的面板功能，就在这加一行 + 注册表里加一条 —— 别处不用动。
const WORKBENCH_PANELS: Record<string, { title: string; render: () => ReactNode }> = {
  project_costs: { title: '🧾 项目费用', render: () => <ProjectCostsPanel /> },
  desktop_pet: { title: '🐾 桌边的小糖人', render: () => <DesktopPetPanel /> },
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
  qq_bridge: {
    title: '💬 QQ 糖人',
    render: () => <QqBridgePanel />,
  },
}

/** 工作台最多同时挂几个 —— 用户要的「1~2 个」。开到第三个就把最旧的顶掉。 */
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
  const expert = useExpertMode()
  const [, , tavernInstalled] = useTavernMode()

  const nestChoice='n3'
  const [area,setArea]=useState(() => window.location.hash === '#project-costs' ? 'play' : ['#tool-center', '#autonomous-activity', '#plugins', '#character-assets'].includes(window.location.hash) ? 'settings' : 'memories')
  const [setting,setSetting]=useState(() => window.location.hash === '#character-assets' ? 'assets' : window.location.hash === '#plugins' ? 'plugins' : window.location.hash === '#autonomous-activity' ? 'autonomy' : window.location.hash === '#tool-center' ? 'tools' : 'appearance')
  useEffect(() => {
    if (!themeInstalled && setting === 'appearance') setSetting('brain')
  }, [setting])
  useEffect(() => {
    if (!expert.loaded) return
    if (!expert.enabled && ["autonomy", "tools", "processes", "runner", "compute"].includes(setting)) setSetting("appearance")
    if (!expert.autonomy_installed && setting === "autonomy") setSetting("appearance")
  }, [expert.loaded, expert.enabled, expert.autonomy_installed, setting])
  useEffect(() => {
    if (expert.loaded && !expert.enabled && area === 'feed') setArea('memories')
  }, [expert.loaded, expert.enabled, area])
  useEffect(() => {
    const openTools = () => {
      if (window.location.hash === '#character-assets') {setArea('settings');setSetting('assets')}
      if (window.location.hash === '#plugins') {setArea('settings');setSetting('plugins')}
      if (window.location.hash === '#tool-center') { setArea('settings'); setSetting('tools') }
      if (window.location.hash === '#autonomous-activity') { setArea('settings'); setSetting('autonomy') }
      if (window.location.hash === '#project-costs') { setArea('play'); setOpenIds(ids => ids.includes('project_costs') ? ids : [...ids.slice(-(MAX_WORKBENCH - 1)), 'project_costs']); setActivePanel('project_costs') }
    }
    window.addEventListener('hashchange', openTools)
    return () => window.removeEventListener('hashchange', openTools)
  }, [])
  const [features, setFeatures] = useState<NestFeature[]>([])
  useEffect(() => {
    const refresh = () => { void fetchNestFeatures().then(list => {setFeatures(list); setOpenIds(ids=>ids.filter(id=>list.some(f=>f.id===id)))}) }
    window.addEventListener('plugins-changed', refresh)
    return () => window.removeEventListener('plugins-changed', refresh)
  }, [])
  const [featureError, setFeatureError] = useState(false)
  const [toast, setToast] = useState('')
  // 「让功能跑起来」面板当前选中的功能 id（点卡片时滚过去并选中它）。
  const [runnerId, setRunnerId] = useState('')
  // 抽屉的开关 —— 全默认收起，进小窝看到的就是一屏。
  const [catalogOpen, setCatalogOpen] = useState(true)
  // 抽屉里的搜索 / 筛选。
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | 'available' | 'planned'>('')
  // 工作台：开着哪几个面板 + 当前看的是哪个（存 localStorage，下次进来还在）。
  const [openIds, setOpenIds] = useState<string[]>(() => window.location.hash === '#project-costs' ? ['project_costs'] : readStored(OPEN_KEY).filter((id) => id in WORKBENCH_PANELS))
  const [activePanel, setActivePanel] = useState<string>(() => window.location.hash === '#project-costs' ? 'project_costs' : localStorage.getItem(ACTIVE_KEY) || '')

  // 拉不到就当空清单 —— 清单那块自己会说「功能清单没拉到（后端没连上？）」，
  // 不会假装「本来就一个功能都没有」。
  useEffect(() => { void fetchNestFeatures().then(items => {
    setFeatures(items)
    const installed = new Set(items.map(item => item.id))
    setOpenIds(ids => ids.filter(id => installed.has(id)))
  }).catch(() => { setFeatureError(true); setFeatures([]) }) }, [expert.enabled])
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

  // 把一个项目送进工作台：已经在就切过去；满了就把最旧的那个挤掉（用户只要 1~2 个）。
  const openPanel = (id: string) => {
    setArea('play')
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
    setArea('settings');setSetting('runner')
    window.setTimeout(() => {
      document.getElementById('nest-tools')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  const openFeature = (f: NestFeature) => {
    if (f.id === 'xiaotangren_theme' && themeInstalled) {
      setArea('settings'); setSetting('appearance')
      return
    }
    if (f.id === 'tavern' && tavernInstalled) {
      setArea('settings'); setSetting('tavern')
      return
    }
    if (f.id === 'tools' && expert.enabled) {
      setArea('settings'); setSetting('tools')
      return
    }
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
      // 不用用户再跑去「🚀 让功能跑起来」点一下（§9.6 安全边界不破：前端只报子命令名）。
      flash(f.id === 'japanese_lab' || f.id === 'english_study'
        ? `「${f.name}」开在工作台里了 —— 它的服务正在自动拉起来，一两秒就好。`
        : f.id === 'qq_bridge'
          ? `「${f.name}」开在工作台里了 —— 网关卡没开的话，那里有「⚡ 开 QQ 网关」一键起。`
          : `「${f.name}」开在工作台里了 —— 顶上那个 tab 就是它，× 关掉就卸载。`)
      return
    }
    // 注册表里声明了 runner 的功能（如逛 B站）→ 在小窝里配置 + 启动，不用去终端敲命令。
    if (f.runner && f.runner.commands.length > 0) {
      setRunnerId(f.id)
      openTools()
      flash(`「${f.name}」在「设置 → 运行与日志」里已选中 —— 选谁去看、怎么跑、日志都在那儿。`)
      return
    }
    // 其余都是独立项目：本体只提供大脑 API，不实现它的逻辑。
    flash(`「${f.name}」的实现是独立项目（features/${f.folder || f.id}/），` +
      (f.status === 'planned' ? '还在规划中 🏡' : '还没接进来。'))
  }

  const activeFeature = byId.get(activePanel)
  const panel = WORKBENCH_PANELS[activePanel]

  return (
    <main className="visual-nest mx-auto max-w-6xl overflow-y-auto px-4 pb-16 pt-5">
      <NestHero variant={nestChoice}/>

      {toast && (
        <div className="mb-4 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {toast}
        </div>
      )}

      <nav className="nest-room-nav" aria-label="功能分区">{([
        ['memories','gallery',themeInstalled?'共同回忆':'媒体库','相片与收藏'],['play','game',themeInstalled?'一起玩':'功能','已安装的扩展'],['feed','inbox',themeInstalled?'小窝动态':'动态','运行结果与发现'],['settings','settings','设置','偏好与连接']
      ] as const).filter(([id]) => id !== 'feed' || expert.enabled).map(([id,icon,label,note])=><button key={id} aria-current={area===id?'page':undefined} onClick={()=>setArea(id)}><UiIcon name={icon} size={25}/><span><strong>{label}</strong><small>{note}</small></span></button>)}</nav>
      {expert.enabled && <div className="tool-entry-bar"><button type="button" onClick={() => { setArea('settings'); setSetting('tools') }}>✦ 工具中心</button><span>按插件管理能力与最近执行记录</span></div>}
      {area==='play'&&<div className="nest-play-room">
      <div className="nest-room-heading"><div><span className="nest-section-note">{themeInstalled?'留一点时间，一起做点喜欢的事':'已安装的扩展'}</span><h2>{themeInstalled?'一起玩':'功能'}</h2></div></div>
      {/* ---- 一起玩：抽屉。收起时只露一行「最近用的」，点开才列全部 + 能搜 ---- */}
      <NestDrawer
        title={themeInstalled?"🎮 一起玩":"功能目录"}
        hint={themeInstalled?"选一件想和她们一起做的事":"选择一个已安装的扩展"}
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
          <p className="text-[13px] text-[var(--text-3)]">{featureError ? '功能清单读取失败，请检查后端连接。' : '尚未安装可选功能，可按 README 从 GitHub 安装。'}</p>
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
                      {f.runner ? ' · 可在此启动' : ''}
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
            工作台空着 —— 上面「<UiIcon name="game"/> 一起玩」里点一个项目，它就在这儿打开。
            <br />
            一次只开 1~2 个（一般是这个数）：<b>×</b> 关掉就等于卸下来，页面不会越用越长。
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {openIds.filter(id => byId.has(id)).map((id) => {
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
                「{activePanel}」没有可开的面板 —— 它的入口在下面「<UiIcon name="tools"/> 设置与工具」里。
              </p>
            )}
          </>
        )}
      </section>

      </div>}

      {area==='memories'&&<section className="nest-room" aria-label={themeInstalled?"共同回忆":"媒体库"}>
        <div className="nest-room-heading"><div><span className="nest-section-note">{themeInstalled?'我们的相册':'资源管理'}</span><h2>{themeInstalled?'共同回忆':'媒体库'}</h2><p>{themeInstalled?'全家的合照、喜欢的画，还有值得留下的片刻。':'浏览与管理共享图片和收藏。'}</p></div>{themeInstalled && <button className="nest-text-action" onClick={()=>{setArea('settings');setSetting('appearance')}}><UiIcon name="paint"/>页头与入场设置 →</button>}</div>
        {themeInstalled && <NestStickerEditor/>}<GalleryGrid owner="" variant="home" bare />
      </section>}
      {expert.enabled && area==='feed'&&<section className="nest-room" aria-label="动态"><div className="nest-room-heading"><div><span className="nest-section-note">运行结果</span><h2>{themeInstalled?'小糖人找到了什么':'扩展动态'}</h2><p>功能带回来的发现，收藏或留下你的反馈。</p></div></div><NestFeedPanel features={features} bare /></section>}
      {area==='settings'&&<div id="nest-tools" className="nest-settings-layout">
        <nav className="nest-setting-nav" aria-label="设置分类">{([
          ['plugins','settings','插件管理'],['assets','gallery','角色资源'],['tavern','card','酒馆模式'],['appearance','paint','外观与入场'],['autonomy','rocket','自主活动与沙盒'],['tools','tools','工具中心'],['brain','memory','模型连接'],['runner','rocket','运行与日志'],['processes','settings','进程管理'],['storage','settings','存储管理'],['compute','rocket','委托计算']
        ] as const).filter(([id]) => (id !== 'appearance' || themeInstalled) && (id !== 'tavern' || tavernInstalled) && (!['tools','processes','runner','autonomy','compute'].includes(id) || (expert.enabled && (id !== 'autonomy' || expert.autonomy_installed)))).map(([id,icon,label])=><button key={id} aria-current={setting===id?'page':undefined} onClick={()=>{setSetting(id); if(id==='plugins') window.location.hash='plugins'; if(id==='assets') window.location.hash='character-assets'}}><UiIcon name={icon}/>{label}</button>)}</nav>
        <section className="nest-setting-content" aria-label="设置内容">
          {setting==='plugins' && <PluginManager/>}
          {setting==='assets' && <CharacterAssetsPanel/>}
          {tavernInstalled && setting==='tavern'&&<TavernSettings/>}
          {themeInstalled && setting==='appearance' &&<NestWelcomeSettings/>}
          {expert.enabled && expert.autonomy_installed && setting==='autonomy'&&<PluginPanel featureId="autonomous_activity" title="自主活动与沙盒"/>}
          {expert.enabled && setting==='tools'&&<ToolCenter/>}
          {expert.enabled && setting==='processes'&&<ProcessPanel/>}
          {expert.enabled && setting==='compute'&&<ComputeSettings/>}
          {setting==='storage'&&<StoragePanel embedded/>}
          {setting==='brain'&&<><div className="nest-room-heading"><div><h2>模型连接</h2><p>聊天与扩展共用的模型配置。</p></div></div><NestApiPanel bare/></>}
          {expert.enabled && setting==='runner'&&<NestRunnerPanel features={features} activeId={runnerId} onActiveChange={setRunnerId} bare/>}
          <ExpertModeControl/>
        </section>
      </div>}
    </main>
  )
}
