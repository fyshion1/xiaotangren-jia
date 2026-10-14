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

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchCharacters, fetchNestFeatureSettings, saveNestFeatureSettings, type NestFeature, type NestSettingField } from '../api/client'
import type { CharacterProfile } from '../data/characters'

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

export default function NestSettingsPanel({ features }: { features: NestFeature[] }) {
  const configurable = useMemo(() => features.filter(CONFIGURABLE), [features])
  const [activeId, setActiveId] = useState('')
  const feature = configurable.find((f) => f.id === activeId) || configurable[0] || null

  const [schema, setSchema] = useState<NestSettingField[]>([])
  const [values, setValues] = useState<Values>({})
  const [characters, setCharacters] = useState<CharacterProfile[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { void fetchCharacters().then(setCharacters).catch(() => setCharacters([])) }, [])

  const load = useCallback(async (id: string) => {
    setErr('')
    setNote('')
    try {
      const got = await fetchNestFeatureSettings(id)
      setSchema(got.schema || [])
      setValues(got.values || {})
      setDirty(false)
      setNote(got.configured ? `上次改于 ${got.updated_at}` : '还没改过 —— 现在用的是功能自带的默认值')
    } catch (e) {
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
      const saved = await saveNestFeatureSettings(feature.id, values)
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

  const resetOne = (field: NestSettingField) => set(field.key, field.default)

  if (configurable.length === 0) return null
  if (!feature) return null

  // 按 group 分组：同一组的字段放一起（顺序 = 声明顺序，前端不改动）。
  const groups: { name: string; fields: NestSettingField[] }[] = []
  for (const field of schema) {
    const name = field.group || '配置'
    const bucket = groups.find((g) => g.name === name)
    if (bucket) bucket.fields.push(field)
    else groups.push({ name, fields: [field] })
  }

  const renderField = (field: NestSettingField, value: unknown, onChange: (v: unknown) => void, compact = false) => {
    const v = value
    const common = { key: field.key }
    const control = () => {
      switch (field.type) {
        case 'bool':
          return (
            <label className="flex items-center gap-2 text-[13px] text-[var(--text)]">
              <input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(e.target.checked)} />
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
              {characters.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}（{c.id}）</option>)}
            </select>
          )
        case 'textarea':
          return <textarea className="input min-h-[64px] w-full" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} />
        case 'list':
          return (
            <input className="input" value={asList(v).join('，')}
              onChange={(e) => onChange(e.target.value)}
              placeholder="逗号分隔（中英文逗号都行）" />
          )
        case 'media_list':
          return <MediaListEditor field={field} value={asList(v)} onChange={onChange} />
        case 'accounts':
          return <AccountsEditor field={field} rows={Array.isArray(v) ? (v as Row[]) : []}
            characters={characters} onChange={onChange} />
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
            title={`恢复默认：${String(field.default)}`} onClick={() => resetOne(field)}>恢复默认</button>
        </div>
        <div className="mt-1.5">{control()}</div>
        {field.desc && <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-3)]">{hint(field.desc)}</p>}
      </div>
    )
  }

  return (
    <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
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

      <div className="mb-3 flex flex-wrap gap-2">
        {configurable.map((f) => (
          <button key={f.id} className={`form-chip ${f.id === feature.id ? 'on' : ''}`}
            onClick={() => setActiveId(f.id)}>{f.emoji} {f.name}</button>
        ))}
      </div>

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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? '存着…' : dirty ? '存下来（立刻生效）' : '没有改动'}
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={() => void load(feature.id)}>重新读一次</button>
        {note && <span className="text-[11px] text-[var(--pink-deep)]">{note}</span>}
      </div>
      {err && <p role="alert" className="mt-2 text-[12px] text-[var(--pink-deep)]">⚠ {err}</p>}
    </section>
  )
}

/** 多个账号的表格编辑器（QQ 桥那种「一个 QQ 号演一个小糖人」）。 */
function AccountsEditor({
  field, rows, characters, onChange,
}: {
  field: NestSettingField
  rows: Row[]
  characters: CharacterProfile[]
  onChange: (v: unknown) => void
}) {
  const cols = field.fields || []
  const update = (index: number, key: string, value: unknown) => {
    const next = rows.map((row, i) => (i === index ? { ...row, [key]: value } : row))
    onChange(next)
  }
  const add = () => onChange([...rows, Object.fromEntries(cols.map((c) => [c.key, c.default ?? (c.type === 'bool' ? true : '')]))])
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
              <tr key={index} className="border-t border-[var(--border)]">
                {cols.map((c) => (
                  <td key={c.key} className="px-1.5 py-1 align-middle">
                    {c.type === 'bool' ? (
                      <input type="checkbox" checked={row[c.key] !== false}
                        onChange={(e) => update(index, c.key, e.target.checked)} />
                    ) : c.type === 'character' ? (
                      <select className="input py-1" value={String(row[c.key] ?? '')}
                        onChange={(e) => update(index, c.key, e.target.value)}>
                        <option value="">（第一个人）</option>
                        {characters.map((ch) => <option key={ch.id} value={ch.id}>{ch.emoji} {ch.name}</option>)}
                      </select>
                    ) : c.type === 'number' ? (
                      <input className="input py-1" type="number" value={String(row[c.key] ?? '')}
                        onChange={(e) => update(index, c.key, e.target.value === '' ? '' : Number(e.target.value))} />
                    ) : c.type === 'list' ? (
                      <input className="input py-1" value={asList(row[c.key]).join('，')}
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
    </div>
  )
}