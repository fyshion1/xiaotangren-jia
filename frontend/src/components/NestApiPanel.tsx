// 小窝 · 通用 API 中心（§9.6）。
//
// 两层配置：全局「默认模型配置」（**带视觉路**）+ 每个功能可单独覆盖任意字段。
// 聊天页与所有小窝功能统一使用这里的配置。
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
  fetchNestModels,
  type NestFeature,
  type NestEffectiveConfig,
  type NestApiTestResult,
  type NestModelList,
} from '../api/client'

/** 模型名输入框 + 下拉 + 🧪：「↓」读一次上游 /models，同页同地址共用结果；
 *  上游列法各不一样（普通 /v1、中转站按分组），读不到的也如实说，手填照样能用。
 *  「↓」只证明清单读得到；**能不能用要 🧪 真发一句** —— 中转站按 key 的分组挂模型，
 *  名字列着、分组下没渠道照样 500。 */
function ModelInput({
  value, onChange, placeholder, list, probe, onList, onProbe, busy, hint, fix, onFix,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  list: NestModelList | null
  probe: NestModelList | null
  onList: () => void
  onProbe: (m: string) => void
  busy: boolean
  /** 刚读清单的结论：读失败给原因，读成功给「几组」—— 只在这次填的地址上显示。 */
  hint?: string
  /** 原地址读不到、换了个路径才读到：给出建议 Base URL，点「改成这个」填回去。 */
  fix?: string
  onFix?: (u: string) => void
}) {
  const known = Boolean(list?.ok && list.models.length > 0)
  const stale = known && value && !list!.models.includes(value)
  return (
    <div>
      <div className="flex items-center gap-1">
        <input className="input min-w-0 flex-1" placeholder={placeholder} list="nest-model-options"
          value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="btn ghost sm" title="从上游读模型清单" disabled={busy} onClick={onList}>
          {busy ? '…' : '↓'}
        </button>
        <button className="btn ghost sm" title="用这个模型真发一句话试试" disabled={!value.trim() || busy}
          onClick={() => onProbe(value.trim())}>
          🧪
        </button>
      </div>
      {known && (
        <datalist id="nest-model-options">
          {list!.models.map((m) => <option key={m} value={m} />)}
        </datalist>
      )}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {known && !value.trim() && <span className="text-[var(--text-3)]">未填</span>}
        {stale && <span className="text-[var(--pink-deep)]" title="清单里没有这个名字">⚠不在清单</span>}
        {probe && (
          <span className={probe.ok ? 'text-[var(--text-2)]' : 'text-[var(--pink-deep)]'}>
            {probe.ok ? '✅ 这个能用' : `❌ ${probe.detail}`}
            {!probe.ok && probe.hint && <span className="block">→ {probe.hint}</span>}
          </span>
        )}
        {hint && <span className={list?.ok ? 'text-[var(--text-3)]' : 'text-[var(--pink-deep)]'}>{hint}</span>}
        {fix && onFix && (
          <span className="flex items-center gap-1">
            <span className="text-[var(--text-2)]">清单是在 <b>{fix}</b> 读到的</span>
            <button className="btn ghost sm" onClick={() => onFix(fix)}>改成这个</button>
          </span>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-0.5 block">{label}</span>
      {children}
    </label>
  )
}

const KIND_LABEL: Record<string, string> = {
  game: '游戏', media: '媒体', im: '聊天软件', home: '工作区', other: '其他',
}

/** Base URL 的比较键：末尾斜杠不算区别（下拉/试模型按它查缓存）。 */
function keyOf(url: string): string {
  return (url || '').trim().replace(/\/+$/, '')
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
  // 覆盖框里留空的字段走全局默认 —— 下拉/试模型也跟着走同一个上游，不拿空地址去读
  const overrideUrl = (override.base_url || brain.base_url || '').trim()
  const overrideKey = override.api_key || brain.api_key || ''
  const overrideVisionUrl = (override.vision_base_url || overrideUrl).trim()
  const visionUrl = (brain.vision_base_url || brain.base_url || '').trim()
  const [probe, setProbe] = useState<NestApiTestResult | null>(null)
  // 屏上这张卡是哪个功能的（'' = 还没读到 / 读失败）—— 和设置面板同一个道理：
  // 换功能时先清空、读回来了才画，不然上个功能的卡会留在新功能底下。
  // 失败单独记一份 `featureErr`：跟「保存失败」`err` 混在一起的话，
  // 没选中功能时保存全局默认失败，会被说成「这个功能的配置没读到」。
  const [featureErr, setFeatureErr] = useState('')
  const reqRef = useRef(0)
  // 模型清单：按 Base URL 缓存（换地址就重读），探测结果按 key 分开记
  const [models, setModels] = useState<Record<string, NestModelList>>({})
  const [modelBusy, setModelBusy] = useState('')
  const [probes, setProbes] = useState<Record<string, NestModelList>>({})
  const [modelHints, setModelHints] = useState<Record<string, string>>({})
  const [urlFixes, setUrlFixes] = useState<Record<string, string>>({})

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
      flash('默认模型配置已保存')
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
      setEffective(eff); flash('已删除独立配置，回落默认模型配置')
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

  /** 读上游模型清单（只读，不发消息）。key 用请求时输入框里的那份。 */
  const loadModels = async (baseUrl: string, apiKey: string) => {
    const url = baseUrl.trim()
    if (!url) { flash('先填 Base URL 再读模型清单'); return }
    const slot = keyOf(url)
    setModelBusy('list:' + slot)
    try {
      const r = await fetchNestModels(url, apiKey)
      setModels((m) => ({ ...m, [slot]: r }))
      if (r.suggest_base_url) setUrlFixes((u) => ({ ...u, [slot]: r.suggest_base_url! }))
      else setUrlFixes((u) => { const n = { ...u }; delete n[slot]; return n })
      setModelHints((h) => ({
        ...h,
        [slot]: r.ok
          ? (r.groups.filter((g) => g.group).length > 1
              ? `站点有 ${r.models.length} 个；按分组是站点自己的渠道名，不代表你 key 能用 —— 拿不准就点 🧪 真发一句`
              : `读到 ${r.models.length} 个`)
          : `读不到清单：${r.detail}`,
      }))
    } catch (e) {
      setModelHints((h) => ({ ...h, [slot]: '读不到清单：' + (e instanceof Error ? e.message : String(e)) }))
    } finally {
      setModelBusy('')
    }
  }

  /** 用给定模型真发一句话（流式，跟她说话同一条路）：ok = 这条路确实能用。
   *  **光在清单里不代表能用** —— 中转站会按 key 的分组挂模型，名字列着、分组下没渠道就 500
   *  （「分组 X 下模型 Y 的可用渠道不存在」）。 */
  const probeModel = async (baseUrl: string, apiKey: string, model: string) => {
    const url = baseUrl.trim()
    if (!url) { flash('先填 Base URL 再试'); return }
    const key = 'probe:' + keyOf(url) + '|' + model
    setModelBusy(key)
    try {
      const r = await fetchNestModels(url, apiKey, model)
      setProbes((p) => ({ ...p, [key]: r }))
    } catch (e) {
      setProbes((p) => ({ ...p, [key]: {
        ok: false, models: [], groups: [], detail: e instanceof Error ? e.message : String(e),
      } }))
    } finally {
      setModelBusy('')
    }
  }

  const modelsOf = (url: string) => models[keyOf(url)] ?? null
  const probeOf = (url: string, model: string) => (model.trim() ? probes['probe:' + keyOf(url) + '|' + model.trim()] ?? null : null)
  const modelHintOf = (url: string) => modelHints[keyOf(url)] || ''
  const urlFixOf = (url: string) => urlFixes[keyOf(url)] || ''
  // 「↓」「🧪」忙的时候一起变灰，免得连点把同一个上游打一串
  const busyModel = modelBusy.startsWith('list:') || modelBusy.startsWith('probe:')

  const toggleVision = async (id: string, on: boolean) => {    setBusy(true); setErr('')
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
            <h2 className="font-bold">模型连接 API</h2>
            <span className={`text-[11px] ${brainConfigured ? 'text-[var(--text-3)]' : 'text-[var(--pink-deep)]'}`}>
              {brainConfigured ? '已配置' : '还没配，功能默认没得上游'}
            </span>
          </div>
          <p className="mb-3 text-[12px] text-[var(--text-2)]">
            所有功能共用这一份模型配置，<b>聊天页也使用这里的配置</b>。默认带视觉路（看图 / 看视频抽帧）。
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
          <Field label="对话模型">
            <ModelInput value={brain.model || ''} onChange={(v) => setBrain({ ...brain, model: v })}
              placeholder="gemini-3.8-flash" list={modelsOf(brain.base_url || '')}
              probe={probeOf(brain.base_url || '', brain.model || '')} busy={busyModel}
              onList={() => void loadModels(brain.base_url || '', brain.api_key || '')}
              onProbe={(m) => void probeModel(brain.base_url || '', brain.api_key || '', m)}
              hint={modelHintOf(brain.base_url || '')}
              fix={urlFixOf(brain.base_url || '')}
              onFix={(u) => {
                setBrain({ ...brain, base_url: u })
                flash(`Base URL 改成 ${u} —— 点 🧪 再试一次，对了再保存`)
              }} />
          </Field>
          <Field label="视觉模型">
            <ModelInput value={brain.vision_model || ''} onChange={(v) => setBrain({ ...brain, vision_model: v })}
              placeholder="留空 = 跟对话模型同一路" list={modelsOf(visionUrl)} probe={null} busy={busyModel}
              onList={() => void loadModels(visionUrl, brain.vision_api_key || brain.api_key || '')}
              onProbe={(m) => void probeModel(visionUrl, brain.vision_api_key || brain.api_key || '', m)}
              hint={modelHintOf(visionUrl)}
              fix={urlFixOf(visionUrl)}
              onFix={(u) => {
                // 视觉地址留空时跟着对话那路走 —— 这里改的是视觉那一格
                setBrain({ ...brain, vision_base_url: u })
                flash(`视觉 Base URL 改成 ${u}`)
              }} />
          </Field>
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
                <Field label="对话模型">
                  <ModelInput value={override.model} onChange={(v) => setOverride({ ...override, model: v })}
                    placeholder={brain.model || ''}
                    list={modelsOf(overrideUrl)} probe={probeOf(overrideUrl, override.model)} busy={busyModel}
                    onList={() => void loadModels(overrideUrl, overrideKey)}
                    onProbe={(m) => void probeModel(overrideUrl, overrideKey, m)}
                    hint={modelHintOf(overrideUrl)}
                    fix={urlFixOf(overrideUrl)}
                    onFix={(u) => setOverride({ ...override, base_url: u })} />
                </Field>
                <Field label="视觉模型">
                  <ModelInput value={override.vision_model} onChange={(v) => setOverride({ ...override, vision_model: v })}
                    placeholder="留空 = 全局默认的视觉模型"
                    list={modelsOf(overrideVisionUrl)} probe={null} busy={busyModel}
                    onList={() => void loadModels(overrideVisionUrl, override.api_key || '')}
                    onProbe={(m) => void probeModel(overrideVisionUrl, override.api_key || '', m)}
                    hint={modelHintOf(overrideVisionUrl)} />
                </Field>
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