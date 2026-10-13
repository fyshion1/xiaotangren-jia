// 小窝 · 通用 API 中心（§9.6）。
//
// 两层配置：全局「小窝大脑默认」（**带视觉路**）+ 每个功能可单独覆盖任意字段。
// 与聊天页那个模型设置（localStorage 的 xiaotangren.config）**完全分开**，互不影响。
//
// 功能清单来自后端注册表，前端不写死 —— 加功能只要在后端 features_registry.py 加一条。

import { useEffect, useState } from 'react'
import {
  fetchNestFeatures,
  fetchNestBrainDefault,
  saveNestBrainDefault,
  fetchNestFeatureConfig,
  saveNestFeatureConfig,
  clearNestFeatureConfig,
  type NestFeature,
  type NestEffectiveConfig,
} from '../api/client'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-0.5 block">{label}</span>
      {children}
    </label>
  )
}

const KIND_LABEL: Record<string, string> = {
  game: '游戏', media: '媒体', im: '聊天软件', home: '小窝', other: '其他',
}

export default function NestApiPanel() {
  const [features, setFeatures] = useState<NestFeature[]>([])
  const [brain, setBrain] = useState<Record<string, string>>({})
  const [brainConfigured, setBrainConfigured] = useState(false)
  const [activeId, setActiveId] = useState<string>('')
  const [effective, setEffective] = useState<NestEffectiveConfig | null>(null)
  const [override, setOverride] = useState({ name: '默认', base_url: '', api_key: '', model: '', vision_base_url: '', vision_api_key: '', vision_model: '', needs_vision: true })
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  useEffect(() => {
    void fetchNestFeatures().then(setFeatures).catch(() => setFeatures([]))
    void fetchNestBrainDefault()
      .then((r) => { setBrain(r.config || {}); setBrainConfigured(r.configured) })
      .catch(() => {})
  }, [])

  const loadFeature = async (id: string) => {
    setActiveId(id)
    setErr('')
    try {
      const eff = await fetchNestFeatureConfig(id)
      setEffective(eff)
      setOverride({
        name: eff.override?.name || '默认',
        base_url: '',
        api_key: '',
        model: '',
        vision_base_url: '',
        vision_api_key: '',
        vision_model: '',
        needs_vision: eff.needs_vision,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const saveBrain = async () => {
    setBusy(true); setErr('')
    try {
      const r = await saveNestBrainDefault(brain)
      setBrain(r.config || {}); setBrainConfigured(true)
      flash('小窝大脑默认已保存')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const saveOverride = async () => {
    if (!activeId) return
    // 只要有一个字段非空就提交覆盖；全空则提示（覆盖必须有 base_url）。
    if (!override.base_url.trim()) { setErr('功能覆盖至少要填 Base URL；只想用全局默认就别保存覆盖'); return }
    setBusy(true); setErr('')
    try {
      const eff = await saveNestFeatureConfig(activeId, override)
      setEffective(eff)
      setOverride({ ...override, base_url: '', api_key: '', model: '', vision_base_url: '', vision_api_key: '', vision_model: '' })
      flash(`已保存「${eff.name}」的独立配置`)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const clearOverride = async () => {
    if (!activeId || !effective?.override) return
    setBusy(true); setErr('')
    try {
      const eff = await clearNestFeatureConfig(activeId, effective.override.id)
      setEffective(eff); flash('已删除独立配置，回落小窝大脑默认')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const toggleVision = async (id: string, on: boolean) => {
    setBusy(true); setErr('')
    try {
      // 只改屏蔽开关：先取出该功能生效配置里的 base_url/key/model 兜底，避免覆盖成空。
      const eff = await fetchNestFeatureConfig(id)
      await saveNestFeatureConfig(id, {
        name: eff.override?.name || '默认',
        base_url: eff.override ? eff.base_url : (brain.base_url || ''),
        api_key: eff.override ? eff.api_key : (brain.api_key || ''),
        model: eff.override ? eff.model : (brain.model || ''),
        vision_base_url: eff.override ? eff.vision_base_url : (brain.vision_base_url || brain.base_url || ''),
        vision_api_key: eff.override ? eff.vision_api_key : (brain.vision_api_key || brain.api_key || ''),
        vision_model: eff.override ? eff.vision_model : (brain.vision_model || ''),
        needs_vision: on,
      })
      if (activeId === id) await loadFeature(id)
      flash(on ? '已开启视觉' : '已屏蔽视觉（这个功能不再走看图/看视频）')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="font-bold">🧠 小窝大脑 API</h2>
        <span className={`text-[11px] ${brainConfigured ? 'text-[var(--text-3)]' : 'text-[var(--pink-deep)]'}`}>
          {brainConfigured ? '已配置' : '还没配，功能默认没得上游'}
        </span>
      </div>
      <p className="mb-3 text-[12px] text-[var(--text-2)]">
        小窝里所有功能共用这一份「大脑」配置，<b>与聊天页的模型设置分开</b>，不互相影响。默认带视觉路（看图 / 看视频抽帧）。
      </p>

      {/* —— 全局默认 —— */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="mb-2 flex items-center gap-2">
          <b className="text-[13px]">全局默认</b>
          <span className="text-[11px] text-[var(--text-3)]">功能没单独配时用它</span>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Field label="Base URL"><input className="input" placeholder="https://…/v1" value={brain.base_url || ''} onChange={(e) => setBrain({ ...brain, base_url: e.target.value })} /></Field>
          <Field label="API Key"><input className="input" type={showKey ? 'text' : 'password'} placeholder="本地保存，不外发" value={brain.api_key || ''} onChange={(e) => setBrain({ ...brain, api_key: e.target.value })} /></Field>
          <Field label="对话模型"><input className="input" placeholder="gemini-3.8-flash" value={brain.model || ''} onChange={(e) => setBrain({ ...brain, model: e.target.value })} /></Field>
          <Field label="视觉模型"><input className="input" placeholder="留空 = 跟对话模型同一路" value={brain.vision_model || ''} onChange={(e) => setBrain({ ...brain, vision_model: e.target.value })} /></Field>
          <Field label="视觉 Base URL（可空）"><input className="input" placeholder="留空 = 与上面同一个 Base URL" value={brain.vision_base_url || ''} onChange={(e) => setBrain({ ...brain, vision_base_url: e.target.value })} /></Field>
          <Field label="视觉 API Key（可空）"><input className="input" type={showKey ? 'text' : 'password'} placeholder="留空 = 与上面同一个 Key" value={brain.vision_api_key || ''} onChange={(e) => setBrain({ ...brain, vision_api_key: e.target.value })} /></Field>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button className="btn sm" disabled={busy || !(brain.base_url || '').trim()} onClick={() => void saveBrain()}>保存全局默认</button>
          <button className="btn ghost sm" onClick={() => setShowKey((v) => !v)}>{showKey ? '🙈 隐藏密钥' : '👁 显示密钥'}</button>
        </div>
      </div>

      {/* —— 每个功能 —— */}
      <div className="mt-3">
        <div className="mb-2 flex items-center gap-2">
          <b className="text-[13px]">每个功能</b>
          <span className="text-[11px] text-[var(--text-3)]">可单独覆盖；不用视觉的可以屏蔽</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {features.map((f) => (
            <button
              key={f.id}
              className={`form-chip ${activeId === f.id ? 'on' : ''}`}
              onClick={() => void loadFeature(f.id)}
            >
              {f.emoji} {f.name}
              <span className="ml-1 text-[10px] text-[var(--text-3)]">{KIND_LABEL[f.kind] || f.kind}{f.needs_vision ? ' · 视觉' : ' · 无视觉'}</span>
            </button>
          ))}
        </div>

        {activeId && effective && (
          <div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
              <b>{effective.name}</b>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${effective.source === 'feature_override' ? 'border-[var(--pink)] text-[var(--pink-deep)]' : 'border-[var(--border)] text-[var(--text-3)]'}`}>
                {effective.source === 'feature_override' ? `独立配置：${effective.override?.name ?? ''}` : '正在用全局默认'}
              </span>
              <label className="ml-auto flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
                <input type="checkbox" checked={effective.needs_vision} disabled={busy}
                  onChange={(e) => void toggleVision(activeId, e.target.checked)} />
                用视觉（看图 / 看视频）
              </label>
            </div>
            <p className="mb-2 text-[11px] text-[var(--text-3)]">
              生效上游：{effective.base_url || '（未配置）'} · 模型 {effective.model || '（未配置）'}
              {effective.needs_vision && <> · 视觉 {effective.vision_model || '（跟对话同一路）'}</>}
              {!effective.needs_vision && <> · <span className="text-[var(--pink-deep)]">视觉已屏蔽</span></>}
            </p>

            <details className="text-[12px]">
              <summary className="cursor-pointer text-[var(--text-2)]">＋ 单独配这个功能（留空 = 用全局默认）</summary>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                <Field label="配置名称"><input className="input" value={override.name} onChange={(e) => setOverride({ ...override, name: e.target.value })} /></Field>
                <Field label="Base URL"><input className="input" placeholder="留空 = 全局默认" value={override.base_url} onChange={(e) => setOverride({ ...override, base_url: e.target.value })} /></Field>
                <Field label="API Key"><input className="input" type={showKey ? 'text' : 'password'} value={override.api_key} onChange={(e) => setOverride({ ...override, api_key: e.target.value })} /></Field>
                <Field label="对话模型"><input className="input" value={override.model} onChange={(e) => setOverride({ ...override, model: e.target.value })} /></Field>
                <Field label="视觉模型"><input className="input" value={override.vision_model} onChange={(e) => setOverride({ ...override, vision_model: e.target.value })} /></Field>
                <Field label="视觉 Base URL"><input className="input" value={override.vision_base_url} onChange={(e) => setOverride({ ...override, vision_base_url: e.target.value })} /></Field>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button className="btn sm" disabled={busy} onClick={() => void saveOverride()}>保存独立配置</button>
                {effective.override && <button className="btn ghost sm" disabled={busy} onClick={() => void clearOverride()}>删除独立配置（回落默认）</button>}
              </div>
            </details>
          </div>
        )}
      </div>

      {err && <p role="alert" className="mt-2 text-[12px] text-[var(--pink-deep)]">⚠ {err}</p>}
      {toast && (
        <div className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {toast}
        </div>
      )}
      <p className="mt-3 text-[11px] text-[var(--text-3)]">
        密钥只存本机后端（`settings.nest_brain_default` / `game_api_configs` 表），仅本机桥接端可读，不会写日志、不会外发。
        功能清单来自后端 `features_registry.py`；每个功能的实现是独立项目，放在 `features/&lt;folder&gt;/`。
      </p>
    </section>
  )
}