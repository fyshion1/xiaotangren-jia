// 小窝 · 功能的开关搬进前端（§9.6.5）。
//
// 起因（大老大原话）：「这块希望在前端可以自己配置，现在说比较复杂」——
// 以前改 QQ 桥的白名单 / 演谁 / 音色 / 表情包，得开终端编辑 `features/qq-bridge/config.json`
// （终端中文还是乱码），现在在这里点几下。
//
// 前端**不写死任何字段**：能配什么、什么类型、默认值，全由功能在
// `backend/app/features_registry.py` 里声明（跟着功能代码走），这里只负责按声明渲染。
// 想加一个开关 = 在那份声明的 `settings` 里加一条，这个面板自动长出来。
//
// 边界：这里只编辑「值」。值的含义、怎么用、什么时候生效，都是功能自己的事
// （QQ 桥每 30 秒拉一次，改完立刻生效，不用重启）。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchCharacters, fetchNestFeatureSettings, fetchNestFeatures, saveNestFeatureSettings, type NestFeature, type NestSettingField } from '../api/client'
import type { CharacterProfile } from '../data/characters'
import QqStickerCatalog from './QqStickerCatalog'
import { QqSetupButton, QqContactSelect } from './QqAccountSetup'
import QqAccountSelect from './QqAccountSelect'

/** 只给能在前端配的功能显示这个面板（注册表里声明了 settings 的那些）。 */
const CONFIGURABLE = (f: NestFeature) => !!(f.settings && f.settings.length > 0)

type Values = Record<string, unknown>
type Row = Record<string, unknown>

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (typeof v === 'string') return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  return []
}

function hint(text: string): string {
  // 声明里的 desc 是给大老大看的人话，原样显示；只把 markdown 的 **加粗** 去掉。
  return text.replace(/\*\*/g, '')
}

// ---- 名字反着写的开关（声明里的 `invert`）----
//
// 有些底层 key 天生是反的：`memory.isolate` = 「单独记」（true = 隔离），
// 而大老大要看的是正面那句「和群聊 / 私聊共享记忆」。声明里标 `invert: true` 之后：
// **勾选框和「恢复默认」按反的显示**，提交上去的（`values`）永远还是存储语义 ——
// 功能侧拉回去直接覆盖 config.json，它不认得这个标记，也不该认得。

/** 存储值 → 给大老大看的值（只管显示/勾选）。 */
function shown(field: NestSettingField, value: unknown): unknown {
  return field.invert && field.type === 'bool' ? !value : value
}

/** 勾选框回写：显示值 → 存储值。 */
function stored(field: NestSettingField, checked: boolean): unknown {
  return field.invert && field.type === 'bool' ? !checked : checked
}

export default function NestSettingsPanel({
  features,
  onlyId,
  hideIds,
  bare = false,
  scope = 'feature',
}: {
  /** 共用模式：把清单传进来（功能 chip 行按它列）。单功能模式可以不给，组件自己去拉。 */
  features?: NestFeature[]
  /** 单功能模式：只出这一个功能的设置、**不要 chip 行** —— 嵌进功能自己的面板里用。 */
  onlyId?: string
  /** 共用模式：这些功能已经把自己的设置嵌在自己面板里了，这里别再重复列一遍。 */
  hideIds?: string[]
  bare?: boolean
  /** 全局页展示 QQ 娱乐与通知字段；独立活动预算由专用面板管理。 */
  scope?: 'feature' | 'autonomy'
}) {
  const [selfFeatures, setSelfFeatures] = useState<NestFeature[]>([])
  const [err, setErr] = useState('')

  // 单功能模式可能没人递清单过来 —— 自己去拉一份（拉不到要说出来，不能装作「没有可配的」）。
  useEffect(() => {
    if (features) return
    void fetchNestFeatures()
      .then(setSelfFeatures)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [features])

  const list = features ?? selfFeatures
  const configurable = useMemo(
    () => list.filter(CONFIGURABLE).filter((f) => !(hideIds && hideIds.includes(f.id))),
    [list, hideIds?.join(',')],  // eslint-disable-line react-hooks/exhaustive-deps
  )
  const [activeId, setActiveId] = useState('')
  const feature = onlyId
    ? configurable.find((f) => f.id === onlyId) || null
    : configurable.find((f) => f.id === activeId) || configurable[0] || null

  const [schema, setSchema] = useState<NestSettingField[]>([])
  const [values, setValues] = useState<Values>({})
  const [characters, setCharacters] = useState<CharacterProfile[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  // 屏上这份字段是哪个功能的（'' = 还没读到 / 读失败）—— **渲染的闸门**：
  // 换功能时先清空、读回来了才画，不然上一个功能的字段会留在屏上，叠在新功能名字底下。
  const [loadedId, setLoadedId] = useState('')
  const reqRef = useRef(0)

  // 名册拿不到只影响「选谁」那种下拉，不该把整块设置弄停；但要把话说清楚。
  useEffect(() => {
    void fetchCharacters().then(setCharacters)
      .catch((e) => setNote(`角色名册没拉到（${e instanceof Error ? e.message : e}）—— 选人的下拉会是空的`))
  }, [])

  const load = useCallback(async (id: string) => {
    // 先把这个功能自己的那份收起来（换功能 = 旧字段立刻下屏），再等新的一份。
    // 两道闸门缺一不可：`seq` 挡**迟到的旧响应**（中途换了功能，这份结果直接扔），
    // `loadedId` 挡**还没到的新响应**（没读回来就不画，屏上只剩「正在读」）。
    const seq = ++reqRef.current
    setErr('')
    setNote('')
    setSchema([])
    setValues({})
    setDirty(false)
    setLoadedId('')
    try {
      const got = await fetchNestFeatureSettings(id)
      if (seq !== reqRef.current) return   // 中途又换了功能，这份结果不要了
      setSchema(got.schema || [])
      setValues(got.values || {})
      setLoadedId(id)
      setNote(got.configured ? `上次改于 ${got.updated_at}` : '还没改过 —— 现在用的是功能自带的默认值')
    } catch (e) {
      if (seq !== reqRef.current) return
      // 读不到就**什么都不显示** —— 绝不能留上一个功能的字段（那是「叠在一起」的来源）。
      // 这里**故意不设 `loadedId`**：没读到 = 渲染闸门一直关着。
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { if (feature) void load(feature.id) }, [feature?.id, load])

  const set = (key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }))
    setDirty(true)
  }

  const save = async () => {
    if (!feature || busy) return
    setBusy(true)
    setErr('')
    try {
      // Global activity and QQ transport settings share legacy storage. Refresh
      // hidden values before a scoped save so one page preserves the other.
      const submitted = feature.id === 'qq_bridge'
        ? { ...(await fetchNestFeatureSettings(feature.id)).values,
            ...Object.fromEntries(schema.filter(field => field.key.startsWith('proactive.') === (scope === 'autonomy') && !['proactive.run_tokens', 'proactive.day_tokens'].includes(field.key))
              .map(field => [field.key, values[field.key]])) }
        : values
      const saved = await saveNestFeatureSettings(feature.id, submitted)
      setValues(saved.values || {})
      setDirty(false)
      setNote(`已存（${saved.updated_at}）—— ${feature.name}下一轮就按这个来，不用重启`
        + (saved.ignored && saved.ignored.length ? `；忽略了 ${saved.ignored.length} 个不认识的项` : ''))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // `field.default` 本来就是**存储语义**，直接写进去即可 —— 反着写的开关不用在这里翻
  // （翻的是显示层：勾选和 title 都走 `shown()`）。做反了会把默认值改成相反的。
  const resetOne = (field: NestSettingField) => set(field.key, field.default)

  // 单功能模式下清单还没拿到 / 拉失败时，别装作「这个功能没有可配的」——
  // 那正是 Block 二 ③ 要治的「假活」：整块消失，看起来就像这里本来就没有东西。
  // 话说清楚，宁可多一行字。
  if (!feature && (onlyId || !features)) {
    if (err) {
      return <p role="alert" className="text-[12px] text-[var(--pink-deep)]">⚠ 功能的开关没读到：{err}</p>
    }
    if (onlyId) {
      return (
        <p className="text-[12px] text-[var(--text-3)]">
          {list.length === 0 ? '还在读这个功能的开关…' : '这个功能没声明可配的开关。'}
        </p>
      )
    }
  }
  if (configurable.length === 0) return null
  if (!feature) return null

  // `loadedId` 是**渲染闸门**：屏上这份字段得确实是这个功能的，才准画。
  // 两个理由，都不是洁癖：
  //   ① 正在读 / 换功能的那一瞬间，画出来是一排**空值**的格子 —— 看起来像「本来就是空的」，
  //      存下去就等于把没显示出来的那些项清掉了（`values` 是整份覆盖）；
  //   ② 读失败时键位都认不出来，更不该让人在空白格子上编辑。
  // 换功能时 `load` 先把 `loadedId` 清空 → 旧功能的字段**立刻下屏**，等新的读回来才放行。
  // 这就是「原来那个收起来」；读失败时一直是 ''（catch 故意不设），字段区保持收起。
  // 只收**字段区**，不收 chip 行 —— 正在读的时候还得能点别的功能切过去。
  const ready = loadedId === feature.id

  // 按 group 分组：同一组的字段放一起（顺序 = 声明顺序，前端不改动）。
  const groups: { name: string; fields: NestSettingField[] }[] = []
  for (const field of schema) {
    if (feature.id === 'qq_bridge' && field.key.startsWith('proactive.') !== (scope === 'autonomy')) continue
    if (feature.id === 'qq_bridge' && ['proactive.run_tokens', 'proactive.day_tokens'].includes(field.key)) continue
    const name = field.group || '配置'
    const bucket = groups.find((g) => g.name === name)
    if (bucket) bucket.fields.push(field)
    else groups.push({ name, fields: [field] })
  }

  const renderField = (field: NestSettingField, value: unknown, onChange: (v: unknown) => void, compact = false) => {
    // 显示一律走 `shown`（反着写的开关在这里翻过来）；写回去的仍是存储语义。
    const v = shown(field, value)
    const common = { key: field.key }
    const control = () => {
      if (feature.id === 'qq_bridge' && field.key === 'proactive.account_index') {
        return <QqAccountSelect label="主动联系使用的 QQ 账号" value={Number(v ?? 0)} settings={values} onChange={onChange} />
      }
      switch (field.type) {
        case 'bool':
          return (
            <label className="flex items-center gap-2 text-[13px] text-[var(--text)]">
              <input type="checkbox" checked={Boolean(v)}
                onChange={(e) => onChange(stored(field, e.target.checked))} />
              <span>{field.label}</span>
            </label>
          )
        case 'number':
          return (
            <input className="input w-28" type="number" value={Number(v ?? 0)}
              min={field.min} max={field.max} step="any"
              onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
          )
        case 'select':
          return (
            <select className="input" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)}>
              {(field.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )
        case 'character':
          return (
            <select className="input" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)}>
              <option value="">（留空 = 名册第一个人）</option>
              {(field.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              {characters.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}（{c.id}）</option>)}
            </select>
          )
        case 'textarea':
          return <textarea className="input min-h-[64px] w-full" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} />
        case 'list':
          return (
            <input className="input" value={typeof v === 'string' ? v : asList(v).join('，')}
              onChange={(e) => onChange(e.target.value)}
              placeholder="逗号分隔（中英文逗号都行）" />
          )
        case 'media_list':
          return <MediaListEditor field={field} value={asList(v)} onChange={onChange} />
        case 'accounts':
          return <AccountsEditor field={field} rows={Array.isArray(v) ? (v as Row[]) : []}
            characters={characters} onChange={onChange} defaults={feature?.id === 'qq_bridge' ? values : undefined} />
        default:
          return (
            <input className="input" type={field.secret ? 'password' : 'text'}
              value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} />
          )
      }
    }
    if (compact) {
      return (
        <label key={field.key} className="block">
          <span className="eyebrow mb-0.5 block">{field.label}</span>
          {control()}
        </label>
      )
    }
    return (
      <div {...common} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-[var(--text)]">{field.label}</span>
          {field.secret && <span className="text-[10px] text-[var(--text-3)]">密钥</span>}
          <button type="button" className="ml-auto text-[10px] text-[var(--text-3)] hover:text-[var(--pink-deep)]"
            title={`恢复默认：${String(shown(field, field.default))}`} onClick={() => resetOne(field)}>恢复默认</button>
        </div>
        <div className="mt-1.5">{control()}</div>
        {field.desc && <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-3)]">{hint(field.desc)}</p>}
      </div>
    )
  }

  // bare：由外面的抽屉提供卡片和标题（§9.6 布局改造），这里只出内容。
  const body = (
    <>
      {!bare && (
        <>
          <div className="mb-1 flex flex-wrap items-baseline gap-2">
            <h2 className="font-bold">⚙ 功能开关</h2>
            <span className="text-[11px] text-[var(--text-3)]">
              在这里改，不用去编辑功能的 config.json
            </span>
          </div>
          <p className="mb-3 text-[12px] text-[var(--text-2)]">
            能配什么由功能自己在注册表里声明 —— 加一条声明，这里就自动长出一个开关。
            存的是「值」，功能下一轮自己来读（QQ 桥每 30 秒一次），改完立刻生效、不用重启。
          </p>
        </>
      )}

      {/* 单功能模式（嵌在功能自己的面板里）：不出 chip 行 —— 挑功能是外面那层的事。 */}
      {!onlyId && (
        <div className="mb-3 flex flex-wrap gap-2">
          {configurable.map((f) => (
            <button key={f.id} className={`form-chip ${f.id === feature.id ? 'on' : ''}`}
              onClick={() => setActiveId(f.id)}>{f.emoji} {f.name}</button>
          ))}
        </div>
      )}

      {/* 字段区只在「屏上这份就是当前功能」时才画 —— 没读到 / 正读着都收起，
          绝不留上一个功能的字段在这儿充数。 */}
      {ready ? (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="text-[14px] font-bold text-[var(--text)]">{g.name}</span>
                <span className="text-[11px] text-[var(--text-3)]">{g.fields.length} 项</span>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {g.fields.map((field) => renderField(field, values[field.key], (v) => set(field.key, v)))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          <p role={err ? 'alert' : undefined}
            className={err ? 'text-[12px] text-[var(--pink-deep)]' : 'text-[12px] text-[var(--text-3)]'}>
            {err ? `⚠ 这个功能的开关没读到：${err}` : '正在读这个功能的开关…'}
          </p>
          {err && <button className="btn ghost sm" disabled={busy} onClick={() => void load(feature.id)}>重新读一次</button>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn sm" disabled={busy || !dirty || !ready} onClick={() => void save()}>
          {busy ? '存着…' : dirty ? '存下来（立刻生效）' : '没有改动'}
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={() => void load(feature.id)}>重新读一次</button>
        {note && <span className="text-[11px] text-[var(--pink-deep)]">{note}</span>}
      </div>
      {ready && feature.id === 'qq_bridge' && scope === 'feature' && <p className="mt-4 text-sm">
        自主活动、预算和小工作室已移至 <a className="underline" href="#autonomous-activity">小窝设置 → 自主活动与沙盒</a>。
      </p>}
      {/* 字段区已经在上面说过「没读到」了，别把同一句再说一遍；
          这条只管**读到了之后**出错的情况（存的时候失败）。 */}
      {ready && err && <p role="alert" className="mt-2 text-[12px] text-[var(--pink-deep)]">⚠ {err}</p>}
    </>
  )

  if (bare) return body
  return (
    <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      {body}
    </section>
  )
}

/** 多个账号的表格编辑器（QQ 桥那种「一个 QQ 号演一个小糖人」）。 */
export function AccountsEditor({
  field, rows, characters, onChange, defaults,
}: {
  field: NestSettingField
  rows: Row[]
  characters: CharacterProfile[]
  onChange: (v: unknown) => void
  defaults?: Values
}) {
  const cols = field.fields || []
  const latest = useRef(rows)
  latest.current = rows
  const [lists, setLists] = useState<Record<string, Record<string, {id: string; name: string}[]>>>({})
  const update = (index: number, key: string, value: unknown) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [key]: value } : row))
    onChange(next)
  }
  const add = () => {
    let existing = rows
    if (!rows.length && defaults) existing = [{
      name: '原来的 QQ 号', self_id: defaults['onebot.self_id'] || '',
      persona: defaults['persona.character_id'] || '', ws_url: defaults['onebot.ws_url'] || '',
      listen_port: defaults['onebot.listen_port'] || 3010, access_token: defaults['onebot.access_token'] || '',
      groups: asList(defaults['allow.groups']), private: asList(defaults['allow.private']), enabled: true,
    }]
    onChange([...existing, { ...Object.fromEntries(cols.map(c => [c.key, c.default ?? (c.type === 'bool' ? true : '')])), groups: [], private: [] }])
  }
  const drop = (index: number) => onChange(rows.filter((_, i) => i !== index))

  return (
    <div className="md:col-span-2 xl:col-span-3">
      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full min-w-[760px] text-[12px]">
          <thead>
            <tr className="text-left text-[11px] text-[var(--text-3)]">
              {cols.map((c) => <th key={c.key} className="px-2 py-1.5 font-medium">{c.label}</th>)}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <Fragment key={`${index}:${String(row.self_id || '')}`}><tr className="border-t border-[var(--border)]">
                {cols.map((c) => (
                  <td key={c.key} className="px-1.5 py-1 align-middle">
                    {c.type === 'bool' ? (
                      <input type="checkbox" checked={row[c.key] !== false}
                        onChange={(e) => update(index, c.key, e.target.checked)} />
                    ) : c.type === 'character' ? (
                      <select className="input py-1" value={String(row[c.key] ?? '')}
                        onChange={(e) => update(index, c.key, e.target.value)}>
                        <option value="">默认：{characters[0]?.name || '名册第一个人'}</option>
                        {(c.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        {characters.map((ch) => <option key={ch.id} value={ch.id}>{ch.emoji} {ch.name}</option>)}
                      </select>
                    ) : c.type === 'number' ? (
                      <input className="input py-1" type="number" value={String(row[c.key] ?? '')}
                        onChange={(e) => update(index, c.key, e.target.value === '' ? '' : Number(e.target.value))} />
                    ) : c.type === 'list' && defaults && ['groups', 'private'].includes(c.key) ? (
                      <QqContactSelect label={c.label} selected={asList(row[c.key])}
                        items={lists[`${index}:${String(row.self_id || '')}`]?.[c.key]}
                        onChange={v => update(index, c.key, v)} />
                    ) : c.type === 'list' ? (
                      <input className="input py-1" value={typeof row[c.key] === 'string' ? String(row[c.key]) : asList(row[c.key]).join('，')}
                        onChange={(e) => update(index, c.key, e.target.value)} />
                    ) : (
                      <input className="input py-1" type={c.secret ? 'password' : 'text'}
                        value={String(row[c.key] ?? '')} onChange={(e) => update(index, c.key, e.target.value)} />
                    )}
                  </td>
                ))}
                <td className="px-1.5">
                  <button type="button" className="text-[11px] text-[var(--text-3)] hover:text-[var(--pink-deep)]"
                    onClick={() => drop(index)}>删</button>
                </td>
              </tr>
              {defaults && <tr><td colSpan={cols.length + 1} className="px-2">
                  {defaults && <QqSetupButton row={row} onChange={patch => {
                    const current = latest.current
                    if (current[index]?.self_id !== row.self_id) return
                    onChange(current.map((r, i) => i === index ? { ...r, ...patch } : r))
                  }} onLists={v => setLists(old => ({ ...old, [`${index}:${String(row.self_id || '')}`]: v }))} />}
              </td></tr>}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={cols.length + 1} className="px-2 py-2 text-[11px] text-[var(--text-3)]">
                还没有号 —— 留空就用下面「这个号」那一组（单账号）。
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" className="btn ghost sm" onClick={add}>＋ 再加一个 QQ 号</button>
        <span className="text-[11px] text-[var(--text-3)]">{field.desc && hint(field.desc)}</span>
      </div>
      {defaults && <p className="mt-2 text-[11px] text-[var(--text-3)]">选 QQ → 自动配置连接并读取名单 → 勾选群和好友 → 保存。运行中的 QQ 桥约 30 秒内同步账号变更。自动配置会为所选账号调整冲突端口，其他账号保持运行；不发送消息。连接字段仍可手动修改。</p>}
    </div>
  )
}

/** 图片 / 表情包库：存的是本体附件库里的引用，这里只列出来 + 能删。 */
function MediaListEditor({
  field, value, onChange,
}: {
  field: NestSettingField
  value: string[]
  onChange: (v: unknown) => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <div className="md:col-span-2 xl:col-span-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-[var(--text)]">{field.label}</span>
        <span className="text-[10px] text-[var(--text-3)]">共 {value.length} 张</span>
      </div>
      {value.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {value.slice(0, 60).map((url, i) => (
            <span key={`${url}-${i}`} className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-1">
              <img src={url} alt="" className="h-8 w-8 rounded object-cover" />
              <button type="button" className="text-[10px] text-[var(--text-3)] hover:text-[var(--pink-deep)]"
                onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
            </span>
          ))}
          {value.length > 60 && <span className="self-center text-[11px] text-[var(--text-3)]">…还有 {value.length - 60} 张</span>}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-[var(--text-3)]">还是空的 —— 群里别人发的表情会被自动收进来。</p>
      )}
      <div className="mt-2 flex gap-2">
        <input className="input min-w-0 flex-1" value={draft} placeholder="也可以手填一个 /api/files/… 引用"
          onChange={(e) => setDraft(e.target.value)} />
        <button type="button" className="btn ghost sm" disabled={!draft.trim()}
          onClick={() => { onChange([...value, draft.trim()]); setDraft('') }}>加</button>
      </div>
      {field.desc && <p className="mt-1 text-[11px] text-[var(--text-3)]">{hint(field.desc)}</p>}
      {field.key === 'sticker.library' && <QqStickerCatalog />}
    </div>
  )
}
