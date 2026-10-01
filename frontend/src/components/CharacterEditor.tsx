import { useRef, useState } from 'react'
import type { CharacterForm, CharacterProfile } from '../data/characters'
import { LABEL_OF, PROFILE_FIELD_LABELS, parseProfileText, type FieldKey, type ParseResult } from '../lib/parseProfile'
import { BASE_FORM_ID, activeFormId, listForms, resolveForm } from '../lib/forms'
import { uploadAttachment } from '../api/storage'

type Props = {
  initial: CharacterProfile
  onSave: (next: CharacterProfile) => void
  onClose: () => void
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-1 block">{label}</span>
      {children}
    </label>
  )
}

/** 图片字段：本地上传落盘（§15.1 复用附件管道）或直接贴外链 URL，二选一。 */
function ImageField({
  label,
  hint,
  value,
  onChange,
  aspect = 'aspect-[3/4]',
}: {
  label: string
  hint: string
  value: string
  onChange: (next: string) => void
  aspect?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function pick(file: File) {
    setBusy(true)
    setErr('')
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('读取文件失败'))
        r.readAsDataURL(file)
      })
      const up = await uploadAttachment('characters', dataUrl)
      if (!up) throw new Error('上传失败：后端没响应')
      onChange(up.orig)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="eyebrow">{label}</span>
        {value && (
          <button
            className="ml-auto text-[12px] text-[var(--text-3)] hover:text-[var(--pink-deep)]"
            onClick={() => onChange('')}
            title="清空（回到 emoji 占位）"
          >
            清空
          </button>
        )}
      </div>
      <div className="flex gap-3">
        <div
          className={`${aspect} w-[92px] shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]`}
        >
          {value ? (
            <img src={value} alt={label} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-[var(--text-3)]">预览</div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <input
            className="input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="图片 URL（留空用 emoji 占位）"
          />
          <div className="flex items-center gap-2">
            <button className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? '上传中…' : '🖼 选择本地图片'}
            </button>
            <span className="text-[11px] text-[var(--text-3)]">{hint}</span>
          </div>
          {err && <div className="text-[11px] text-[var(--pink-deep)]">⚠ {err}</div>}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void pick(f)
        }}
      />
    </div>
  )
}

// 单行文本字段：路径 -> 标签（立绘 / 头像走 ImageField，已从这里移出）
const TEXT_FIELDS: { label: string; key: keyof CharacterProfile }[] = [
  ['名字', 'name'],
  ['日文假名', 'jp'],
  ['别名 / 称号', 'alias'],
  ['生日', 'birthday'],
  ['年龄', 'age'],
  ['身高', 'height'],
  ['血型', 'bloodType'],
  ['星座', 'constellation'],
  ['口头禅', 'catchphrase'],
  ['体型', 'bodyType'],
  ['瞳色', 'eyeColor'],
  ['发型', 'hairstyle'],
  ['发色', 'hairColor'],
  ['胸部', 'bust'],
  ['臀部', 'hip'],
  ['服装', 'clothing'],
  ['职业', 'occupation'],
  ['关系', 'relationships'],
  ['特殊特征', 'specialFeatures'],
  ['体重', 'weight'],
  ['三围', 'measurements'],
  ['弱点', 'weakPoint'],
].map(([label, key]) => ({ label, key }) as { label: string; key: keyof CharacterProfile })

const TAG_FIELDS: { label: string; key: 'personality' | 'likes' | 'dislikes' }[] = [
  { label: '性格（逗号分隔）', key: 'personality' },
  { label: '喜好（逗号分隔）', key: 'likes' },
  { label: '讨厌（逗号分隔）', key: 'dislikes' },
]

const LONG_FIELDS: { label: string; key: keyof CharacterProfile }[] = [
  { label: '关于（角色提示词 · 喂给模型）', key: 'about' },
  { label: '秘密', key: 'secret' },
  { label: '私密小愿望', key: 'privateWish' },
]

/** 形态管理分区（§17）：在编辑器下方，折叠面板形式。 */
function FormManager({
  form,
  setForm,
}: {
  form: CharacterProfile
  setForm: React.Dispatch<React.SetStateAction<CharacterProfile>>
}) {
  const [newFormName, setNewFormName] = useState('')
  const forms = listForms(form)
  const curId = activeFormId(form)

  const setField = (key: keyof CharacterProfile, value: string | string[]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const ensureForm = (id: string, name: string) => {
    setForm((f) => ({
      ...f,
      forms: [...(f.forms ?? []).filter((fm) => fm.id !== id), { id, name, fields: {} }],
      activeFormId: id,
    }))
  }

  const delForm = (id: string) => {
    if (id === BASE_FORM_ID) return
    setForm((f) => ({
      ...f,
      forms: (f.forms ?? []).filter((fm) => fm.id !== id),
      activeFormId: f.activeFormId === id ? BASE_FORM_ID : f.activeFormId,
    }))
  }

  const curForm = forms.find((f) => f.id === curId) ?? forms[0]
  const isBase = curId === BASE_FORM_ID

  // 当前形态下，编辑器显示的完整档案（基础 + 覆盖合并）
  const resolved = resolveForm(form)
  const view = resolved.profile

  // 覆盖形态下，被勾选的词条 → 它们在 forms 里的当前值
  const curFields = (curForm.fields ?? {}) as Record<string, unknown>

  const toggleProp = (key: string) => {
    if (isBase) return // 基础形态顶层字段由主表单编辑，不走形态覆盖
    const next: Record<string, unknown> = { ...curFields }
    if (key in next) delete next[key]
    else next[key] = view[key as keyof CharacterProfile]
    setForm((f) => ({
      ...f,
      forms: (f.forms ?? []).map((fm) =>
        fm.id === curId ? { ...fm, fields: next as CharacterForm['fields'] } : fm,
      ),
    }))
  }

  const updateProp = (key: string, value: string | string[]) => {
    const next: Record<string, unknown> = { ...curFields, [key]: value }
    setForm((f) => ({
      ...f,
      forms: (f.forms ?? []).map((fm) =>
        fm.id === curId ? { ...fm, fields: next as CharacterForm['fields'] } : fm,
      ),
    }))
  }

  return (
    <div className="mt-5 border-t border-[var(--border-strong)] pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">形态管理（§17）</span>
        <span className="text-[12px] text-[var(--text-3)]">
          当前：{curForm.name}（{isBase ? '基础形态' : '覆盖形态'}）
        </span>
      </div>

      {/* 形态切换 */}
      <div className="mb-3 flex flex-wrap gap-2">
        {forms.map((f) => (
          <button
            key={f.id}
            onClick={() => setField('activeFormId', f.id)}
            className={`form-chip ${f.id === curId ? 'on' : ''}`}
            title={f.name}
          >
            {f.id === curId ? `🎀 ${f.name}` : f.name}
          </button>
        ))}
      </div>

      {/* 基础形态名 / 新形态 */}
      <div className="mb-3 flex items-end gap-2">
        {isBase ? (
          <div className="flex-1">
            <span className="eyebrow mb-1 block">基础形态名称</span>
            <input
              className="input"
              value={form.baseFormName ?? ''}
              onChange={(e) => setField('baseFormName', e.target.value)}
              placeholder="如：第一形态 · 粉发"
            />
          </div>
        ) : (
          <div className="flex-1">
            <span className="eyebrow mb-1 block">新增形态</span>
            <input
              className="input"
              value={newFormName}
              onChange={(e) => setNewFormName(e.target.value)}
              placeholder="如：第二形态 · 紫发"
            />
          </div>
        )}
        {!isBase && (
          <>
            <button
              className="btn sm"
              onClick={() => {
                if (!newFormName.trim()) return
                ensureForm(`form_${Date.now()}`, newFormName.trim())
                setNewFormName('')
              }}
            >
              + 新增
            </button>
            <button
              className="btn ghost sm"
              onClick={() => delForm(curId)}
              disabled={forms.length <= 1}
            >
              删除形态
            </button>
          </>
        )}
      </div>

      {/* 覆盖字段：基础形态下编辑顶层表单；覆盖形态下逐词条打勾选填 */}
      {!isBase && (
        <div className="mb-3 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] p-2.5">
          <div className="eyebrow mb-1.5">
            本形态覆盖以下词条（勾选 = 覆盖，未勾 = 沿用基础形态）
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PROFILE_FIELD_LABELS.filter((f) => !['id', 'name'].includes(f.key)).map((f) => {
              const key = f.key as string
              const on = key in curFields
              return (
                <label key={f.key} className="flex items-center gap-1.5 text-[12px]">
                  <input type="checkbox" checked={on} onChange={() => toggleProp(key)} />
                  <span className="text-[var(--text-2)]">{f.label}</span>
                </label>
              )
            })}
          </div>

          {/* 已勾选的词条：在本形态下显示为可编辑输入 */}
          {Object.keys(curFields).length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {PROFILE_FIELD_LABELS.filter((f) => f.key in curFields).map((f) => {
                const key = f.key
                const val = curFields[key]
                const isList = ['personality', 'likes', 'dislikes'].includes(key)
                return (
                  <Row key={key} label={f.label}>
                    {isList ? (
                      <input
                        className="input"
                        value={(val as string[] | undefined)?.join('，') ?? ''}
                        onChange={(e) =>
                          updateProp(key, e.target.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean))
                        }
                      />
                    ) : (
                      <input
                        className="input"
                        value={(val as string | undefined) ?? ''}
                        onChange={(e) => updateProp(key, e.target.value)}
                      />
                    )}
                  </Row>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function CharacterEditor({ initial, onSave, onClose }: Props) {
  const [form, setForm] = useState<CharacterProfile>({ ...initial })
  // 粘贴模板填充（纯前端）：解析 → 预览勾选 → 写进表单（仍需点「保存」才落库）
  const [fillerOpen, setFillerOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [checked, setChecked] = useState<Set<FieldKey>>(new Set())

  const set = (key: keyof CharacterProfile, value: string | string[]) => setForm((f) => ({ ...f, [key]: value }))

  function doParse() {
    const r = parseProfileText(pasteText)
    setParsed(r)
    setChecked(new Set(Object.keys(r.fields) as FieldKey[]))
  }

  function applyChecked() {
    if (!parsed) return
    setForm((f) => {
      const next = { ...f }
      for (const key of checked) {
        const value = parsed.fields[key]
        if (value === undefined) continue
        ;(next as Record<string, unknown>)[key] = value
      }
      return next
    })
    setFillerOpen(false)
    setParsed(null)
    setPasteText('')
  }

  const fieldLabel = (key: FieldKey) => PROFILE_FIELD_LABELS.find((x) => x.key === key)?.label ?? LABEL_OF[key] ?? key
  const previewKeys = parsed
    ? (Object.keys(parsed.fields) as FieldKey[]).sort(
        (a, b) =>
          PROFILE_FIELD_LABELS.findIndex((x) => x.key === a) -
          PROFILE_FIELD_LABELS.findIndex((x) => x.key === b),
      )
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
      <div className="my-4 w-full max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-bold">
            编辑资料 · {initial.name}
            <span className="ml-2 text-[12px] font-normal text-[var(--text-3)]">所有词条可随时改，保存后立即生效</span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setFillerOpen((v) => !v)
                setParsed(null)
              }}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-1 text-[12px] text-[var(--text-2)] hover:border-[var(--pink)]"
              title="从《角色设定.md》整段复制粘贴，自动识别词条，快速填充"
            >
              📋 粘贴模板填充
            </button>
            <button onClick={onClose} className="rounded-lg px-2.5 py-1 text-[var(--text-3)] hover:bg-[var(--surface-2)]">
              ✕
            </button>
          </div>
        </div>

        {fillerOpen && (
          <div className="mb-4 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] p-3">
            <div className="eyebrow mb-1.5">粘贴模板填充 · 识别词条后勾选应用（保存前可再改）</div>
            <p className="mb-2 text-[12px] text-[var(--text-3)]">
              支持两种格式：①《角色设定.md》里某个角色那一段整块复制（标签行 + 空行 + 值行）；
              ②每行写「标签：值」，如 <code>生日：3 月 14 日</code>、<code>性格：温柔、深情</code>。
              一次粘一个角色；同名标签只取首个。
            </p>
            <textarea
              className="textarea"
              rows={7}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="在此粘贴角色设定文本…"
            />
            <div className="mt-2 flex items-center gap-2">
              <button className="btn sm" onClick={doParse} disabled={!pasteText.trim()}>
                解析
              </button>
              {parsed && (
                <span className="text-[12px] text-[var(--text-3)]">
                  识别到 {previewKeys.length} 个词条
                  {parsed.warnings.length ? `，${parsed.warnings.length} 条提示` : ''}
                </span>
              )}
            </div>

            {parsed && (
              <div className="mt-3">
                {previewKeys.length > 0 ? (
                  <div className="max-h-[34vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
                    <table className="w-full text-[12px]">
                      <tbody>
                        {previewKeys.map((key) => {
                          const value = parsed.fields[key]
                          const shown = Array.isArray(value) ? value.join('，') : String(value ?? '')
                          return (
                            <tr key={key} className="border-b border-[var(--border)] last:border-0 align-top">
                              <td className="w-8 px-2 py-1.5">
                                <input
                                  type="checkbox"
                                  checked={checked.has(key)}
                                  onChange={(e) =>
                                    setChecked((prev) => {
                                      const next = new Set(prev)
                                      if (e.target.checked) next.add(key)
                                      else next.delete(key)
                                      return next
                                    })
                                  }
                                />
                              </td>
                              <td className="w-32 px-2 py-1.5 font-medium text-[var(--text-2)]">{fieldLabel(key)}</td>
                              <td className="px-2 py-1.5 text-[var(--text-3)]">{shown}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-[12px] text-[var(--text-3)]">没识别出词条，检查一下粘贴的内容。</div>
                )}

                {parsed.warnings.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-[12px] text-[var(--text-3)]">
                    {parsed.warnings.map((w, i) => (
                      <li key={i}>⚠ {w}</li>
                    ))}
                  </ul>
                )}

                <div className="mt-2 flex items-center gap-2">
                  <button className="btn sm" onClick={applyChecked} disabled={!checked.size}>
                    应用所选（{checked.size}）
                  </button>
                  <button className="btn ghost sm" onClick={() => setParsed(null)}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="max-h-[62vh] space-y-3.5 overflow-y-auto pr-1">
          {/* 立绘 / 头像（item 4、5）：静态图或 GIF 都行，浏览器选图上传即落盘 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ImageField
              label="立绘（静态 / GIF）"
              hint="介绍页大图 · 支持 GIF"
              value={form.portrait ?? ''}
              onChange={(v) => set('portrait', v)}
            />
            <ImageField
              label="头像"
              hint="聊天气泡用 · 正方图最佳"
              value={form.avatar ?? ''}
              onChange={(v) => set('avatar', v)}
              aspect="aspect-square"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {TEXT_FIELDS.map((f) => (
              <Row key={f.key} label={f.label}>
                <input
                  className="input"
                  value={(form[f.key] as string) ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </Row>
            ))}
          </div>

          {TAG_FIELDS.map((f) => (
            <Row key={f.key} label={f.label}>
              <input
                className="input"
                value={(form[f.key] as string[]).join('，')}
                onChange={(e) => set(f.key, e.target.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean))}
              />
            </Row>
          ))}

          {LONG_FIELDS.map((f) => (
            <Row key={f.key} label={f.label}>
              <textarea
                className="textarea"
                value={(form[f.key] as string) ?? ''}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </Row>
          ))}

          {/* 形态管理（§17）：基础形态在此编辑顶层词条，其余形态在上方切 chip 后逐条覆盖 */}
          <FormManager form={form} setForm={setForm} />
        </div>

        <div className="mt-5 flex justify-end gap-2.5">
          <button className="btn ghost sm" onClick={onClose}>
            取消
          </button>
          <button className="btn sm" onClick={() => onSave(form)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}