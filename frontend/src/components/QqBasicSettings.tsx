import { useEffect, useState } from 'react'
import { fetchCharacters, fetchNestFeatureSettings, saveNestFeatureSettings } from '../api/client'
import type { CharacterProfile } from '../data/characters'
import { useExpertMode } from '../lib/expertMode'
import { QqContactSelect, QqSetupButton } from './QqAccountSetup'

type Values = Record<string, unknown>
type Contact = { id: string; name: string }
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
export default function QqBasicSettings() {
  const expert = useExpertMode()
  const [values, setValues] = useState<Values | null>(null)
  const [row, setRow] = useState<Values>({})
  const [characters, setCharacters] = useState<CharacterProfile[]>([])
  const [contacts, setContacts] = useState<Record<string, Contact[]>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState('')
  async function load() {
    try {
      const data = await fetchNestFeatureSettings('qq_bridge')
      setValues(data.values)
      setRow((data.values.accounts as Values[] | undefined)?.[0] || {})
    } catch (e) { setNote(String(e)) }
  }
  useEffect(() => { void load(); void fetchCharacters().then(setCharacters).catch(e => setNote(String(e))) }, [])
  const change = (key: string, value: unknown) => setValues(v => ({ ...v, [key]: value }))
  async function save() {
    setBusy(true)
    try {
      const keys = ['owner.qq', 'allow.require_mention_in_group', 'voice.enabled', 'voice.auto',
        'voice.engine', 'voice.voice', 'asr.engine', 'asr.fallback', 'sticker.enabled',
        'gateway.folder', 'gateway.webui_port', 'gateway.password']
      await saveNestFeatureSettings('qq_bridge', { ...Object.fromEntries(keys.filter(k => values?.[k] !== undefined).map(k => [k, values?.[k]])), ...(row.self_id ? { accounts: [{ ...row, enabled: true }] } : {}) })
      setNote('已保存。账号连接变化会在约 30 秒内同步；关闭专家模式后请重新启动 QQ 桥。')
      await load()
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function selectExisting() {
    setBusy(true)
    try {
      const response = await fetch('/api/qq-bridge/setup/select-basic-account', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Exploration-Dashboard': '1' }, body: JSON.stringify({ self_id: selected }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || '选择失败')
      await load(); setNote('已选定账号。其他账号配置保留，请重新启动 QQ 桥。')
    } catch (e) { setNote(String(e)) }
    finally { setBusy(false) }
  }
  if (!values) return <p role="status">{note || '正在读取 QQ 聊天设置…'}</p>
  return <div className="space-y-4 text-sm" aria-label="QQ 简化设置">
    <p>连接一个机器人 QQ，选择让谁来聊天。日常设置保留在这里，连接参数可自动填写。</p>
    {Boolean(values['bridge.selection_required']) && <div role="alert">
      <p>已有多个账号或连接配置需要修复，请选择一个账号运行；其他配置会保留。</p>
      <select className="input" aria-label="保留运行的 QQ" value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">选择已有账号</option>{expert.qq_accounts?.map(a => <option key={a.self_id} value={a.self_id}>{a.name}（{a.self_id}）</option>)}
      </select><button className="btn" disabled={busy || !selected} onClick={() => void selectExisting()}>使用这个账号</button>
    </div>}
    <div><b>1. 绑定机器人 QQ</b><p>当前账号：{String(row.self_id || '尚未绑定')}</p>
      <QqSetupButton row={row} onChange={patch => {
        if (patch.self_id && patch.self_id !== row.self_id) setContacts({})
        setRow(r => ({ ...r, ...patch }))
      }} onLists={setContacts} />
      <label>你的 QQ 号<input className="input" value={String(values['owner.qq'] || '')} onChange={e => change('owner.qq', e.target.value)} /></label>
    </div>
    <div><b>2. 让谁来聊天</b><select className="input" aria-label="让谁来聊天" value={String(row.persona || '')} onChange={e => setRow(r => ({ ...r, persona: e.target.value }))}>
      <option value="">使用第一个角色</option><option value="group">当前多人角色组</option>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select></div>
    <div><b>3. 允许回复谁</b><p>默认只回复你。下方勾选其他好友或群；不勾选就不回复。</p>
      <QqContactSelect label="允许的好友" selected={list(row.private)} items={contacts.private} onChange={v => setRow(r => ({ ...r, private: v }))} />
      <QqContactSelect label="允许的群" selected={list(row.groups)} items={contacts.groups} onChange={v => setRow(r => ({ ...r, groups: v }))} />
      <label><input type="checkbox" checked={values['allow.require_mention_in_group'] !== false} onChange={e => change('allow.require_mention_in_group', e.target.checked)} />群里被 @ 才回复（推荐）</label>
    </div>
    <div><b>4. 声音和表情</b>
      <label>听懂语音<select className="input" value={String(values['asr.engine'] || 'qq')} onChange={e => { change('asr.engine', e.target.value); change('asr.fallback', e.target.value === 'none' ? 'none' : 'local') }}>
        <option value="qq">先用 QQ 转写，本地识别兜底</option><option value="local">直接本地识别</option><option value="none">关闭语音识别</option>
      </select></label><p>本地识别组件是否齐全，可在上方检查；未安装时按提示选择可选安装。</p>
      <label>回复方式<select className="input" value={values['voice.enabled'] === false || values['voice.auto'] === 'off' ? 'off' : 'mirror'} onChange={e => { change('voice.enabled', e.target.value !== 'off'); change('voice.auto', e.target.value) }}>
        <option value="off">只发文字</option><option value="mirror">你发语音时也用语音回复</option>
      </select></label>
      <label>音色<select className="input" value={values['voice.engine'] === 'piper' ? String(values['voice.voice'] || 'huayan') : 'zh-CN-XiaoxiaoNeural'} onChange={e => { change('voice.voice', e.target.value); change('voice.engine', e.target.value === 'zh-CN-XiaoxiaoNeural' ? 'edge' : 'piper') }}>
        <option value="zh-CN-XiaoxiaoNeural">晓晓（需要联网）</option><option value="huayan">华燕（需安装本地音色）</option><option value="xiaoya">小雅（需另装音色）</option><option value="chaowen">超文（需另装音色）</option>
      </select></label>
      <label><input type="checkbox" checked={values['sticker.enabled'] !== false} onChange={e => change('sticker.enabled', e.target.checked)} />聊天时使用表情包</label>
      <details><summary>查看和移除表情包</summary><div className="flex flex-wrap gap-2">{list(values['sticker.library']).map(url => <div key={url}>
        <img src={url} alt="已收集的表情" className="h-20 w-20 object-contain" />
        <button className="btn ghost sm" onClick={async () => {
          setBusy(true)
          try { const library = list(values['sticker.library']).filter(x => x !== url); await saveNestFeatureSettings('qq_bridge', { 'sticker.library': library }); change('sticker.library', library); setNote('已从表情包库移除。原聊天记录中的图片保留。') }
          catch (e) { setNote(String(e)) } finally { setBusy(false) }
        }} disabled={busy}>从图库移除</button>
      </div>)}</div></details>
    </div>
    <details><summary>连接修复（通常使用自动配置）</summary>
      {['gateway.folder', 'gateway.password', 'gateway.webui_port'].map(key => <label key={key} className="block">{({ 'gateway.folder': '网关安装目录', 'gateway.password': '网关网页密码', 'gateway.webui_port': '网关网页端口' } as Record<string, string>)[key]}
        <input className="input" type={key.endsWith('password') ? 'password' : key.endsWith('port') ? 'number' : 'text'} value={String(values[key] ?? '')} onChange={e => change(key, key.endsWith('port') ? Number(e.target.value) : e.target.value)} /></label>)}
      <label>本机 WS 地址<input className="input" value={String(row.ws_url || '')} onChange={e => setRow(r => ({ ...r, ws_url: e.target.value }))} /></label>
      <label>连接 token<input className="input" type="password" value={String(row.access_token || '')} onChange={e => setRow(r => ({ ...r, access_token: e.target.value }))} /></label>
      <p>网页密码和连接 token 不相同。修改网页密码后先保存，再读取已登录 QQ。</p>
    </details>
    <button className="btn" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存 QQ 聊天设置'}</button>
    {note && <p role="status">{note}</p>}
  </div>
}
