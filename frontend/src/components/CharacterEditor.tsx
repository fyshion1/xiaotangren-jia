import { useState } from 'react'
import type { CharacterProfile } from '../data/characters'

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

  const set = (key: keyof CharacterProfile, value: string | string[]) => setForm((f) => ({ ...f, [key]: value }))

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
      <div className="my-4 w-full max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-bold">
            编辑资料 · {initial.name}
            <span className="ml-2 text-[12px] font-normal text-[var(--text-3)]">所有词条可随时改，保存后立即生效</span>
          </h2>
          <button onClick={onClose} className="rounded-lg px-2.5 py-1 text-[var(--text-3)] hover:bg-[var(--surface-2)]">
            ✕
          </button>
        </div>

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