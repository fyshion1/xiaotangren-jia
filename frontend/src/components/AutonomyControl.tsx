import { useCallback, useEffect, useRef, useState } from 'react'
import QqAccountSelect from './QqAccountSelect'
import SandboxPersonalMemory from './SandboxPersonalMemory'

type Wallet = { id: string; persona: string; speaker: string; base_url: string; model: string; token_limit: number; charged: number; remaining: number; enabled: boolean; has_key: boolean; provider_balance?: boolean }
type Config = { enabled: boolean; continuous?: boolean; allow_estimated_usage?: boolean; continuation_minutes?: number; qq_account_index?: number | null; qq_notify?: boolean; min_minutes: number; max_minutes: number; daily_opportunities: number; run_tokens: number; day_tokens: number }
type Status = { settings: Config; threads?: { persona: string; speaker: string; state: string; notes: string; next_at: number }[]; clock: { next_at: number; count: number; last_result: string } | null; notifications: { run_id: string; speaker: string; state: string; plan: string }[] }
type Named = { id: string; name?: string }

async function api(path: string, body?: object) {
  const response = await fetch('/api/exploration-projects/' + path, {
    method: body ? 'PUT' : 'GET', headers: { 'X-Exploration-Dashboard': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '自主活动设置未能保存')
  return value
}

export default function AutonomyControl() {
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [profiles, setProfiles] = useState<Named[]>([])
  const [characters, setCharacters] = useState<Named[]>([])
  const [state, setState] = useState<Status | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [persona, setPersona] = useState('')
  const [speaker, setSpeaker] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [tokens, setTokens] = useState(0)
  const [enabled, setEnabled] = useState(false)
  const [providerBalance, setProviderBalance] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const walletAttempt = useRef<{ payload: string; id: string } | null>(null)
  const load = useCallback(async () => {
    const [w, s] = await Promise.all([api('wallets'), api('autonomy')])
    setWallets(w.items); setState(s); setConfig(old => old || s.settings)
  }, [])
  useEffect(() => {
    void Promise.all([fetch('/api/profiles').then(r => r.json()), fetch('/api/characters').then(r => r.json()), load()])
      .then(([p, c]) => { setProfiles(p.profiles); setCharacters(c); setPersona(p.active_id || p.profiles[0]?.id || ''); setSpeaker(c[0]?.id || '') })
      .catch(() => setError('全局活动与钱包未能读取'))
    const timer = window.setInterval(() => { void load().catch(() => {}) }, 15000)
    return () => window.clearInterval(timer)
  }, [load])
  const selected = wallets.find(w => w.persona === persona && w.speaker === speaker)
  useEffect(() => {
    setEndpoint(selected?.base_url || ''); setModel(selected?.model || ''); setEnabled(Boolean(selected?.enabled)); setKey(''); setTokens(0)
    setProviderBalance(Boolean(selected?.provider_balance))
  }, [selected?.id, selected?.base_url, selected?.model, selected?.enabled, selected?.provider_balance, persona, speaker])
  async function save(path: string, body: object) {
    setBusy(true); setError(''); setNotice('')
    const payload = JSON.stringify(body)
    if (path === 'wallets' && walletAttempt.current?.payload !== payload) walletAttempt.current = { payload, id: crypto.randomUUID() }
    try {
      await api(path, path === 'wallets' ? { ...body, operation_id: walletAttempt.current?.id } : body)
      walletAttempt.current = null; setKey(''); setTokens(0); await load(); setNotice('已保存到本机后台')
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
    <h3 className="font-semibold">沙盒生活与独立钱包</h3>
    <SandboxPersonalMemory persona={persona} speaker={speaker} />
    <p className="my-2 text-xs text-[var(--text-3)]">由小窝后台独立调度，QQ 桥是可选通知插件。沙盒消息全天可主动联系，不受 QQ 娱乐频率、免打扰、近期聊天或未回复限制。先配置角色钱包，再启用时钟。</p>
    {error && <p role="alert" className="my-2 text-sm">{error}</p>}
    {notice && <p role="status" className="my-2 text-sm">{notice}</p>}
    {config && <div className="space-y-2 text-sm">
      <label className="block"><input type="checkbox" aria-label="启用独立自主活动" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })} /> 启用独立自主活动</label>
      <label className="block"><input type="checkbox" checked={config.continuous ?? true} onChange={e => setConfig({ ...config, continuous: e.target.checked })} /> 持续生活：自动接着自己的兴趣探索，可自行休息再醒来</label>
      <label className="block"><input type="checkbox" checked={config.allow_estimated_usage ?? false} onChange={e => setConfig({ ...config, allow_estimated_usage: e.target.checked })} /> 兼容供应商用量：成功返回但计量缺失或不一致时，按完整预留额度扣账后继续</label>
      <p className="text-xs text-[var(--text-3)]">兼容模式仍受钱包、单轮和每日上限约束；超时、连接失败或已知用量超出预留仍停机，不自动重试。</p>
      <label className="block">闲逛间隔（分钟） <input aria-label="轮间歇息（分钟）" className="w-20 rounded border p-1" type="number" min={1} max={60} value={config.continuation_minutes ?? 1} onChange={e => setConfig({ ...config, continuation_minutes: Number(e.target.value) })} /></label>
      <p className="text-xs text-[var(--text-3)]">有明确下一步时可连续工作，不受闲逛间隔限制；六次调用或十分钟后保存接力并重新检查权限。休息、暂停、资源不足及错误会停止连续调用，连续三次相同工具结果会拦截空转。</p>
      <label className="block"><input type="checkbox" checked={config.qq_notify ?? true} onChange={e => setConfig({ ...config, qq_notify: e.target.checked })} /> 允许自主活动通过 QQ 联系我（含预算愿望）</label>
      <div>沙盒专用 QQ 账号 <QqAccountSelect label="沙盒专用 QQ 账号" value={config.qq_account_index ?? null} nullable onChange={v => setConfig({ ...config, qq_account_index: v })} /></div>
      <p className="text-xs text-[var(--text-3)]">选择已在 QQ 桥配置并启用的专用账号，再保存。未绑定时不通过 QQ 发沙盒消息；原账号继续普通聊天。最近对话中的“沙盒生活”始终可用。</p>
      <div className="flex flex-wrap gap-3">
        {([
          ['min_minutes', '最短间隔（分钟）', 5, 1440], ['max_minutes', '最长间隔（分钟）', 5, 1440],
          ['daily_opportunities', '每日探索机会', 0, 48], ['run_tokens', '普通单次 token 上限', 0, 50000], ['day_tokens', '普通每日 token 上限', 0, 200000],
        ] as const).filter(([field]) => !(config.continuous ?? true) || field === 'run_tokens' || field === 'day_tokens').map(([field, label, min, max]) => <label key={field}>{label} <input className="w-24 rounded border p-1" aria-label={label} type="number" min={min} max={max} value={config[field]} onChange={e => setConfig({ ...config, [field]: Number(e.target.value) })} /></label>)}
      </div>
      <button className="btn sm" disabled={busy || config.max_minutes < config.min_minutes} onClick={() => void save('autonomy', config)}>保存独立活动设置</button>
      <p className="text-xs text-[var(--text-3)]">{state?.clock ? `${state.clock.last_result} · 今日已启动 ${state.clock.count} 轮` : '尚未安排探索；需要启用的钱包与活动时钟。'}</p>
      {state?.threads?.map(t => <p key={t.persona+':'+t.speaker} className="text-xs">{t.persona} / {t.speaker} · {({ ready: '准备继续', running: '正在活动', resting: '自己休息中', paused: '已暂停', waiting_resources: '等待资源', error: '等待检查或唤醒' } as Record<string,string>)[t.state] || t.state} · {t.notes || '尚未留下感想'}{['ready','resting'].includes(t.state) && (t.next_at > 0 ? ` · 下次 ${new Date(t.next_at*1000).toLocaleString()}` : ' · 等待后台调度')}</p>)}
    </div>}
    <details className="mt-4" open>
      <summary className="cursor-pointer font-semibold">角色独立钱包</summary>
      <div className="mt-2 flex flex-wrap gap-3 text-sm">
        <label>身份 <select aria-label="钱包身份" value={persona} onChange={e => setPersona(e.target.value)}>{profiles.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}</select></label>
        <label>角色 <select aria-label="钱包角色" value={speaker} onChange={e => setSpeaker(e.target.value)}>{characters.map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}</select></label>
      </div>
      <p className="my-2 text-xs text-[var(--text-3)]">{selected ? `${selected.provider_balance ? '按供应商余额运行' : `累计额度 ${selected.token_limit} · 剩余 ${selected.remaining} token`} · 本地已用及预留 ${selected.charged} · ${selected.has_key ? '已保存密钥' : '无密钥'}` : '此身份与角色还没有独立钱包。'}</p>
      <div className="flex gap-2">{([['start','现在去玩 / 继续探索'],['pause','暂停此角色']] as const).map(([action,label]) => <button key={action} className="btn sm" disabled={busy || !persona || !speaker} onClick={async () => {
        setBusy(true); setError('')
        try {
          const response = await fetch('/api/exploration-projects/autonomy/signal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Exploration-Dashboard': '1' }, body: JSON.stringify({ persona, speaker, action, request_id: crypto.randomUUID() }) })
          const value = await response.json(); if (!response.ok) throw new Error(value.detail || '指令未能提交')
          setNotice(value.message); await load()
        } catch(e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
      }}>{label}</button>)}</div>
      <div className="grid gap-2 text-sm">
        <label>模型 API 地址 <input aria-label="钱包 API 地址" className="w-full rounded border p-1" placeholder="https://…/v1" value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
        <label>模型名称 <input aria-label="钱包模型" className="w-full rounded border p-1" value={model} onChange={e => setModel(e.target.value)} /></label>
        <label>独立 API Key <input aria-label="钱包 API Key" className="w-full rounded border p-1" type="password" autoComplete="new-password" maxLength={4096} placeholder={selected?.has_key ? '留空保留已存密钥' : '填写她自己的模型密钥'} value={key} onChange={e => setKey(e.target.value)} /></label>
        <label>本次追加 token <input aria-label="钱包追加 token" className="w-28 rounded border p-1" type="number" min={0} max={2000000} value={tokens} onChange={e => setTokens(Number(e.target.value))} /></label>
        <label><input aria-label="启用角色钱包" type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 启用角色钱包</label>
        <label><input aria-label="按供应商余额运行" type="checkbox" checked={providerBalance} onChange={e => setProviderBalance(e.target.checked)} /> 按供应商余额运行：本地 token 额度只记账，不限制普通沙盒活动</label>
      </div>
      <p className="my-2 text-xs text-[var(--text-3)]">密钥只在宿主加密保存，不进入提示词或容器。按供应商余额运行时，普通活动不受本地钱包、单轮或每日 token 上限约束；成功返回但用量不规范时保守记账。上游报错仍停下，不自动重试。单次运行时限、工具隔离和项目审批继续生效；聊天不会授予项目权限。</p>
      <button className="btn sm" disabled={busy || !persona || !speaker || !endpoint || !model || !Number.isInteger(tokens) || tokens < 0 || tokens > 2000000} onClick={() => void save('wallets', { persona, speaker, base_url: endpoint, model, api_key: key, add_tokens: tokens, enabled, provider_balance: providerBalance })}>保存独立钱包</button>
    </details>
    {!!state?.notifications?.length && <details className="mt-3"><summary className="cursor-pointer text-sm">QQ 通知队列</summary>{state.notifications.map(n => <div key={n.run_id} className="mt-2 rounded border p-2 text-xs"><p>{n.speaker} · {({ pending: '等候插件', sending: '已交付插件，结果待确认', sent: '已发送', unknown: '结果未知，不重发', cancelled: '已取消', expired: '已过期' } as Record<string, string>)[n.state] || n.state}</p><pre className="whitespace-pre-wrap break-words font-sans">{(() => { try { return JSON.parse(n.plan).actions.map((a: { text?: string }) => a.text || '[表情]').join('\n') } catch { return '内容不可读' } })()}</pre></div>)}</details>}
  </section>
}
