// 小窝 · 通用 API 中心（§9.6）。
//
// 两层配置：全局「小窝大脑默认」（**带视觉路**）+ 每个功能可单独覆盖任意字段。
// 与聊天页那个模型设置（localStorage 的 xiaotangren.config）**完全分开**，互不影响。
//
// 功能清单来自后端注册表，前端不写死 —— 加功能只要在后端 features_registry.py 加一条。

import { useEffect, useRef, useState } from 'react'
import {
  fetchNestFeatures,
  fetchNestBrainDefault,
  saveNestBrainDefault,
  fetchNestFeatureConfig,
  saveNestFeatureConfig,
  clearNestFeatureConfig,
  testNestFeatureApi,
  type NestFeature,
  type NestEffectiveConfig,
  type NestApiTestResult,
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

export default function NestApiPanel({ bare = false }: { bare?: boolean } = {}) {
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
  // 首次加载失败单独记一份（Block 二 ③）：以前 catch 成空值，页面就装成「还没配」，
  // 跟真的没配一模一样 —— 后端没连上时不该这么说。
  const [loadErr, setLoadErr] = useState('')
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<NestApiTestResult | null>(null)
  // 屏上这张卡是哪个功能的（'' = 还没读到 / 读失败）—— 和设置面板同一个道理：
  // 换功能时先清空、读回来了才画，不然上个功能的卡会留在新功能底下。
  // 失败单独记一份 `featureErr`：跟「保存失败」`err` 混在一起的话，
  // 没选中功能时保存全局默认失败，会被说成「这个功能的配置没读到」。
  const [featureErr, setFeatureErr] = useState('')
  const reqRef = useRef(0)

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  useEffect(() => {
    void fetchNestFeatures().then(setFeatures)
      .catch((e) => { setFeatures([]); setLoadErr(e instanceof Error ? e.message : String(e)) })
    void fetchNestBrainDefault()
      .then((r) => { setBrain(r.config || {}); setBrainConfigured(r.configured); setLoadErr('') })
      .catch((e) => { setLoadErr(e instanceof Error ? e.message : String(e)) })
  }, [])

  const loadFeature = async (id: string) => {
    setActiveId(id)
    setErr('')
    setProbe(null)
    // 换功能先把上一个的卡片收起来 —— 不清的话，下面那张卡还是**上一个功能**的
    // 名字 / 上游 / 覆盖，chip 却已经跳到新功能上了。看着像「新功能的配置」，
    // 这时候点「保存独立配置」就是拿旧值往新功能头上写。
    // `seq` 挡迟到的旧响应（连点两个 chip 时，先回来的不算数）。
    const seq = ++reqRef.current
    setEffective(null)
    setFeatureErr('')
    try {
      const eff = await fetchNestFeatureConfig(id)
      if (seq !== reqRef.current) return
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
      if (seq !== reqRef.current) return
      setFeatureErr(e instanceof Error ? e.message : String(e))
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

  // 测一下路通不通：后端会真的发几个 token 出去（很便宜，但确实是一次调用）。
  const runTest = async (id: string) => {
    setTesting(true); setErr(''); setProbe(null)
    try {
      setProbe(await testNestFeatureApi(id))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setTesting(false) }
  }

  const useSuggested = (url: string) => {
    setBrain({ ...brain, base_url: url })
    flash(`已把 Base URL 改成 ${url} —— 记得点「保存全局默认」再测一次`)
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

  // bare：由外面的抽屉提供卡片和标题（§9.6 布局改造），这里只出内容。
  const body = (
    <>
      {!bare && (
        <>
          <div className="mb-1 flex items-center justify-between gap-2">
            <h2 className="font-bold">🧠 小窝大脑 API</h2>
            <span className={`text-[11px] ${brainConfigured ? 'text-[var(--text-3)]' : 'text-[var(--pink-deep)]'}`}>
              {brainConfigured ? '已配置' : '还没配，功能默认没得上游'}
            </span>
          </div>
          <p className="mb-3 text-[12px] text-[var(--text-2)]">
            小窝里所有功能共用这一份「大脑」配置，<b>与聊天页的模型设置分开</b>，不互相影响。默认带视觉路（看图 / 看视频抽帧）。
          </p>
        </>
      )}

      {loadErr && (
        <p role="alert" className="mb-3 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[12px] text-[var(--pink-deep)]">
          ⚠ 配置没读到：{loadErr} —— 下面显示的空不代表「还没配」，是后端没连上。
        </p>
      )}

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

        {activeId && !effective && (
          // 卡收起来的时候要说一句在等什么（Block 二 ③）—— 不然点了 chip 下面空着，
          // 看着跟「这个功能没什么可配的」一样。
          <p role={featureErr ? 'alert' : undefined}
            className={`mt-2 text-[12px] ${featureErr ? 'text-[var(--pink-deep)]' : 'text-[var(--text-3)]'}`}>
            {featureErr ? `⚠ 这个功能的配置没读到：${featureErr}（上面的 chip 还能点别的）` : '正在读这个功能的配置…'}
          </p>
        )}

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

            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button className="btn sm" disabled={testing || busy} onClick={() => void runTest(activeId)}>
                {testing ? '正在试…' : '🧪 测一下路通不通'}
              </button>
              <span className="text-[11px] text-[var(--text-3)]">
                真的发几个 token 出去 —— 功能报「上游 405 / 401」这种错时先点它
              </span>
            </div>

            {probe && (
              <div className="mb-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2">
                {probe.checks.map((c) => (
                  <div key={c.name} className="flex items-start gap-2 py-0.5 text-[12px]">
                    <span className={c.ok ? 'text-[var(--text-3)]' : 'text-[var(--pink-deep)]'}>
                      {c.ok ? '✅' : '⚠️'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="font-medium">{c.label}</b>
                      {c.status ? <span className="ml-1 text-[11px] text-[var(--text-3)]">HTTP {c.status}</span> : null}
                      <span className="ml-1 break-words text-[var(--text-2)]">{c.detail}</span>
                      {c.hint && <span className="mt-0.5 block text-[11px] text-[var(--pink-deep)]">→ {c.hint}</span>}
                    </span>
                  </div>
                ))}
                {probe.suggest_base_url && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-1.5 text-[12px]">
                    <span className="text-[var(--text-2)]">建议 Base URL 填：<b>{probe.suggest_base_url}</b>（只补一个 /v1）</span>
                    <button className="btn ghost sm" onClick={() => useSuggested(probe.suggest_base_url)}>填进全局默认</button>
                  </div>
                )}
              </div>
            )}

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

      {/* 卡收起时那句已经在上面说过了（读配置失败），这里只管**卡画着**的时候的错
          —— 保存 / 测路 / 切换视觉失败。 */}
      {effective && err && <p role="alert" className="mt-2 text-[12px] text-[var(--pink-deep)]">⚠ {err}</p>}
      {toast && (
        <div className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {toast}
        </div>
      )}
      <p className="mt-3 text-[11px] text-[var(--text-3)]">
        密钥只存本机后端（`settings.nest_brain_default` / `game_api_configs` 表），仅本机桥接端可读，不会写日志、不会外发。
        功能清单来自后端 `features_registry.py`；每个功能的实现是独立项目，放在 `features/&lt;folder&gt;/`。
      </p>
    </>
  )

  if (bare) return body
  return (
    <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      {body}
    </section>
  )
}