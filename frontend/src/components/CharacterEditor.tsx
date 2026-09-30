import { useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import { LABEL_OF, PROFILE_FIELD_LABELS, parseProfileText, type FieldKey, type ParseResult } from '../lib/parseProfile'

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

// 单行文本字段：路径 -> 标签
const TEXT_FIELDS: { label: string; key: keyof CharacterProfile }[] = [
  ['名字', 'name'],
  ['日文假名', 'jp'],
  ['别名 / 称号', 'alias'],
  ['立绘图片 URL（静态/GIF，留空用 emoji）', 'portrait'],
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