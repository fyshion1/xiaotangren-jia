import { useEffect, useState } from 'react'
import { fetchMemoryStatus, reindexMemories } from '../api/memory'

type Config = { engine: 'local' | 'cloud'; base_url: string; cloud_model: string; has_api_key: boolean }

async function requestConfig(body?: object): Promise<Config> {
  const response = await fetch('/api/memories/embedding-config', body ? {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined)
  if (!response.ok) throw new Error(`配置请求失败：HTTP ${response.status}`)
  return response.json()
}

export default function EmbeddingSettings() {
  const [config, setConfig] = useState<Config | null>(null)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { void requestConfig().then(setConfig).catch(error => setMessage(String(error))) }, [])

  async function act(action: 'save' | 'test' | 'reindex') {
    if (!config) return
    setBusy(true)
    setMessage('处理中…')
    try {
      if (action === 'save') {
        setConfig(await requestConfig({ ...config, api_key: key, clear_api_key: clearKey }))
        setKey(''); setClearKey(false)
        setMessage('已保存并立即生效。更换来源或模型后，请重建索引。')
      } else if (action === 'test') {
        const status = await fetchMemoryStatus()
        setMessage(status ? status.available ? `连接正常，向量维度 ${status.dim}；待重建索引 ${status.stale_vectors} 条。` : status.detail : '连接检查失败')
      } else {
        const result = await reindexMemories()
        setMessage(`索引重建：${result.done}/${result.total} 条，未完成 ${result.failed} 条。`)
      }
    } catch (error) { setMessage(String(error)) }
    finally { setBusy(false) }
  }

  return <details className="m-3">
    <summary>记忆语义检索 · Embedding 设置</summary>
    <p className="fm-hint">本地运行或委托运行均可独立使用外部 API，不需要安装本地向量模型。不可用时自动使用关键词检索，记忆保留。</p>
    {config && <fieldset disabled={busy} className="grid gap-2 my-2">
      <label>向量来源<select className="input" value={config.engine} onChange={event => setConfig({ ...config, engine: event.target.value as Config['engine'] })}>
        <option value="local">本地模型</option><option value="cloud">外部 API（OpenAI 兼容）</option>
      </select></label>
      {config.engine === 'cloud' && <>
        <label>API 根地址<input className="input" value={config.base_url} onChange={event => setConfig({ ...config, base_url: event.target.value })} placeholder="https://example.com/v1" /></label>
        <p className="fm-hint">填写含 /v1 等路径的根地址，无需填写 /embeddings；留空使用服务端聊天 API 地址。</p>
        <label>Embedding 模型<input className="input" value={config.cloud_model} onChange={event => setConfig({ ...config, cloud_model: event.target.value })} /></label>
        <label>API 密钥<input type="password" autoComplete="new-password" className="input" value={key} onChange={event => setKey(event.target.value)} placeholder={config.has_api_key ? '已配置；留空保留' : '填写独立 embedding 密钥'} /></label>
        <label><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除独立密钥</label>
        <p className="fm-hint">独立地址不会自动携带聊天密钥。仅复用聊天地址时，未设置独立密钥会沿用服务端聊天密钥。</p>
      </>}
      <div className="db-actions"><button className="btn sm" onClick={() => void act('save')}>保存</button><button className="btn sm ghost" onClick={() => void act('test')}>检查已保存配置</button><button className="btn sm ghost" onClick={() => void act('reindex')}>重建索引</button></div>
    </fieldset>}
    <p role="status" className="fm-hint">{message}</p>
  </details>
}
