// 糖人小窝（《项目要求》§9.6）：全家共同的回忆 + 以后要接的互动入口。
// 现在只有「共同回忆 · 画廊」（归属为「家 · 共用」的那部分，见 §9.4）是真的；
// 小游戏 / Unity 互动小家是占位卡片，点开只弹「规划中」，不做假功能。

import { useEffect, useState } from 'react'
import GalleryGrid from './GalleryGrid'
import WorldbookPanel from './WorldbookPanel'
import GeminiSyncPanel from './GeminiSyncPanel'
import { fetchAgentInbox, sendAgentMessage, type AgentMessage } from '../api/agents'
import { saveGameApiConfig, fetchGameApiConfigs, launchInteractiveHome } from '../api/client'

const PLACEHOLDERS = [
  {
    emoji: '🎮',
    title: '一起玩的小游戏',
    desc: '谁是卧底 / 你画我猜 / 猜谜 —— 让小糖人们真的一起玩，而不只是聊到。',
    tag: '规划中',
  },
  {
    emoji: '🏡',
    title: '互动小家（Unity 渲染）',
    desc: '把「家」渲染成一个能走动的三维场景，小糖人在里面各有各的房间。',
    tag: '规划中',
  },
]

export default function NestView() {
  type GameApi = { id: string; gameId: string; name: string; baseUrl: string; apiKey: string; model: string }
  const [gameApis, setGameApis] = useState<GameApi[]>(() => { try { return JSON.parse(localStorage.getItem('xiaotangren.game-api-profiles') || '[]') } catch { return [] } })
  const [gameId, setGameId] = useState('dont_starve_together')
  const [gameApiName, setGameApiName] = useState('')
  const [gameApi, setGameApi] = useState({ baseUrl: '', apiKey: '', model: '' })
  useEffect(() => { void fetchGameApiConfigs(gameId).then(items => { const mapped = items.map(p => ({ id: p.id, gameId: p.game_id, name: p.name, baseUrl: p.base_url, apiKey: p.api_key || '', model: p.model || '' })); setGameApis(mapped); localStorage.setItem('xiaotangren.game-api-profiles', JSON.stringify(mapped)) }).catch(() => {}) }, [gameId])
  const saveGameApi = async () => { if (!gameApiName.trim() || !gameApi.baseUrl.trim()) return; try { const saved = await saveGameApiConfig({ game_id: gameId, name: gameApiName.trim(), base_url: gameApi.baseUrl, api_key: gameApi.apiKey, model: gameApi.model }); const next = [...gameApis.filter(p => p.id !== saved.id), { id: saved.id, gameId, name: saved.name, baseUrl: saved.base_url, apiKey: saved.api_key, model: saved.model }]; setGameApis(next); localStorage.setItem('xiaotangren.game-api-profiles', JSON.stringify(next)); setGameApiName(''); setToast('游戏 API 已保存到当前后端') } catch (e) { setToast(`保存失败：${e instanceof Error ? e.message : String(e)}`) } }
  const activateGameApi = (p: GameApi) => setGameApi({ baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model })
  const [toast, setToast] = useState('')
  const [gameOpen, setGameOpen] = useState(false)
  const [agentText, setAgentText] = useState('')
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([])
  const [agentBusy, setAgentBusy] = useState(false)
  useEffect(() => { void fetchAgentInbox('xiaotangren-ui').then(setAgentMessages).catch(() => {}) }, [])
  const sendToAgent = async () => {
    const text = agentText.trim()
    if (!text || agentBusy) return
    setAgentBusy(true)
    try {
      const sent = await sendAgentMessage({ sender: 'xiaotangren-ui', recipient: '*', conversation_id: 'nest', kind: 'message', payload: { text } })
      setAgentMessages((items) => [sent, ...items]); setAgentText('')
    } catch (e) { setToast(e instanceof Error ? e.message : String(e)) }
    finally { setAgentBusy(false) }
  }

  const plan = (what: string) => {
    if (what === '一起玩的小游戏') { setGameOpen(true); return }
    setToast(`${what}还在规划中 —— 先把画廊和聊天养厚，再来盖这间屋子 🏡`)
    setTimeout(() => setToast(''), 4000)
  }

  return (
    <main className="mx-auto max-w-6xl overflow-y-auto px-4 pb-16 pt-5">
      <header className="mb-6">
        <h1 className="text-[26px] font-extrabold tracking-wide">🏠 糖人小窝</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">
          全家的共同回忆。每个人的专属画廊在各自的角色介绍页里；这里只放「家 · 共用」的那部分。
        </p>
      </header>

      {gameOpen && <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
        <div className="mb-1 flex items-center justify-between gap-2"><h2 className="font-bold">Agent 协作</h2><span className="text-[11px] text-[var(--text-3)]">通用消息中转</span></div>
        <p className="mb-3 text-[12px] text-[var(--text-2)]">给其他项目的 Agent 留言、交换协议或请求状态；具体游戏和 Mod 由独立项目处理。</p>
        <div className="flex gap-2"><input className="input min-w-0 flex-1" value={agentText} onChange={(e) => setAgentText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendToAgent() }} placeholder="写一条协作消息…" /><button className="btn sm" disabled={agentBusy || !agentText.trim()} onClick={() => void sendToAgent()}>发送</button></div>
        {agentMessages.length > 0 && <div className="mt-3 max-h-48 space-y-2 overflow-y-auto">{agentMessages.slice(0, 12).map((m) => <div key={m.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px]"><b>{m.sender}</b><span className="mx-1 text-[var(--text-3)]">→</span>{String(m.payload.text ?? JSON.stringify(m.payload))}</div>)}</div>}
      </section>}
      {gameOpen && <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
        <h2 className="font-bold">游戏专用 API 配置</h2><p className="my-2 text-[12px] text-[var(--text-2)]">每个游戏独立保存 API，不影响普通聊天配置。</p>
        <div className="mb-2 flex flex-wrap gap-2"><select className="input" value={gameId} onChange={e => setGameId(e.target.value)}><option value="dont_starve_together">饥荒联机版</option><option value="custom">自定义游戏</option></select>{gameApis.filter(p => p.gameId === gameId).map(p => <button className="btn ghost sm" key={p.id} onClick={() => activateGameApi(p)}>{p.name}</button>)}</div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2"><input className="input" placeholder="配置名称" value={gameApiName} onChange={e => setGameApiName(e.target.value)} /><input className="input" placeholder="Base URL" value={gameApi.baseUrl} onChange={e => setGameApi({ ...gameApi, baseUrl: e.target.value })} /><input className="input" placeholder="API Key（本地保存）" type="password" value={gameApi.apiKey} onChange={e => setGameApi({ ...gameApi, apiKey: e.target.value })} /><input className="input" placeholder="聊天模型" value={gameApi.model} onChange={e => setGameApi({ ...gameApi, model: e.target.value })} /></div>
        <button className="btn sm mt-2" disabled={!gameApiName.trim() || !gameApi.baseUrl.trim()} onClick={saveGameApi}>保存此游戏 API</button>
      </section>}

      {toast && (
        <div className="mb-4 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {toast}
        </div>
      )}

      <section className="mb-10 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {PLACEHOLDERS.map((p) => (
          <button
            key={p.title}
            type="button"
            onClick={() => { if (p.title === '互动小家（Unity 渲染）') { if (window.confirm('要进入互动小家吗？确认后将打开 Unity 项目。')) void launchInteractiveHome().then(() => setToast('Unity 互动小家已启动')).catch(e => setToast(`启动失败：${e instanceof Error ? e.message : String(e)}`)); } else plan(p.title) }}
            className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-5 text-left transition hover:border-[var(--pink)]"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[22px]">{p.emoji}</span>
              <span className="text-[15px] font-bold text-[var(--text)]">{p.title}</span>
              <span className="ml-auto rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-3)]">
                {p.tag}
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--text-2)]">{p.desc}</p>
          </button>
        ))}
      </section>

      <GeminiSyncPanel />
      {/* 共同回忆 · 画廊：只看 owner='' 的那些（全家共用） */}
      <GalleryGrid owner="" variant="home" />

      {/* 家 · 共用世界书（§19）：群聊里生效的就是这一档；每人自己的那份在各自介绍页 */}
      <WorldbookPanel owner="" ownerLabel="家 · 共用世界书" />
    </main>
  )
}
