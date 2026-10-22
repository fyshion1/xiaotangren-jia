import { useEffect, useState } from 'react'

type Config = { mode: 'native' | 'delegated'; worker_url: string; has_token: boolean; profile: string }
type Status = Config & { online: boolean; detail: string; capabilities: string[]; embedding_model?: string }

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/compute/${path}`, body ? {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined)
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `HTTP ${response.status}`)
  return result
}

export default function ComputeSettings() {
  const [config, setConfig] = useState<Config | null>(null)
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void request<Config>('config').then(setConfig).catch(e => setMessage(String(e))) }, [])

  async function act(save: boolean) {
    if (!config) return
    setBusy(true)
    try {
      if (save) {
        setConfig(await request<Config>('config', { mode: config.mode, worker_url: config.worker_url,
          token, clear_token: clearToken }))
        setToken(''); setClearToken(false)
        setMessage('已保存并立即生效；不会移动或同步另一台机器的数据。')
      } else {
        const status = await request<Status>('status')
        setMessage(`${status.detail}${status.online ? `；已启用能力：${status.capabilities.join('、') || '无'}${status.embedding_model ? `；向量模型：${status.embedding_model}` : ''}` : ''}`)
      }
    } catch (e) { setMessage(String(e)) }
    finally { setBusy(false) }
  }

  return <section className="my-4 rounded-2xl border border-[var(--border)] p-4">
    <h3>运行模式与委托计算</h3>
    <p className="fm-hint">聊天、QQ、记忆和联网搜索由当前主机负责。本地向量和生图可交给另一台电脑或云服务器；算力端离线时保留基础功能。外部 embedding API 独立使用。</p>
    {config && <fieldset disabled={busy} className="grid gap-2 my-2">
      <p className="fm-hint">当前部署：{config.profile === 'lightweight' ? '轻量主机（无桌宠、语音、视频计算和自主后台活动）' : '完整原生功能'}</p>
      <label>计算模式<select className="input" value={config.mode} onChange={e => setConfig({ ...config, mode: e.target.value as Config['mode'] })}>
        <option value="native">原生 · 当前机器计算</option><option value="delegated">委托 · 使用远程算力端</option>
      </select></label>
      <label>算力端地址<input className="input" value={config.worker_url} placeholder="http://192.168.31.91:8010" onChange={e => setConfig({ ...config, worker_url: e.target.value })} /></label>
      <label>访问密钥<input className="input" type="password" autoComplete="new-password" value={token} placeholder={config.has_token ? '已配置；留空保留' : '填写算力端 WORKER_TOKEN'} onChange={e => setToken(e.target.value)} /></label>
      <label><input type="checkbox" checked={clearToken} onChange={e => setClearToken(e.target.checked)} />清除访问密钥（先切回原生模式）</label>
      <p className="fm-hint">跨公网使用 HTTPS 或 VPN 地址。向量模型需要两端一致；更换模型后重建记忆索引。连接检查只检查服务和已启用能力，不会加载模型。</p>
      <div className="flex gap-2"><button className="btn sm" onClick={() => void act(true)}>保存</button><button className="btn sm ghost" onClick={() => void act(false)}>检查已保存连接</button></div>
    </fieldset>}
    <p className="fm-hint" role="status">{message}</p>
  </section>
}
