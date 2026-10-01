// 生图外观提示词拼装（《项目要求》§7）。
//
// 目标：不必每次手打「粉发紫瞳女仆装」，直接从当前角色的**当前形态**取外貌词条拼一句。
// 依赖 §17 形态机制 —— 换形态 = 换外观，这里跟着形态走，复用 lib/forms.ts 的 resolveForm。
//
// 设计约束：
//   - 拼出来的东西落在**独立的可编辑 textarea** 里，不是隐藏变换：用户随时能改、能删。
//   - **脏跟踪**：以 `${charId}:${formId}` 为键。键变了（换角色 / 换形态）→ 重新拼；
//     键没变 → 绝不动用户手改的内容（否则打字打到一半被覆盖，很难受）。
//   - 词条为空的不占位、不出现在结果里。
//
// 中文 → 英文/标签映射（提示词词典）**不在本轮**，所以这里输出的是中文描述；
// 字典做完后在这里追加英文标签即可（见《项目要求》§7 的「留待下一轮」）。
import { resolveForm } from './forms'
import type { CharacterProfile } from '../data/characters'

/** 参与拼装的外观词条（顺序 = 输出顺序）。未列出的词条（性格/关系等）不进生图提示词。 */
const APPEARANCE_FIELDS: Array<{ label: string; key: keyof CharacterProfile }> = [
  { label: '', key: 'bodyType' }, // 体型（「纤细」「丰满」这类，单独成词就够）
  { label: '身高', key: 'height' },
  { label: '发色', key: 'hairColor' },
  { label: '发型', key: 'hairstyle' },
  { label: '瞳色', key: 'eyeColor' },
  { label: '胸部', key: 'bust' },
  { label: '臀部', key: 'hip' },
  { label: '', key: 'clothing' }, // 服装（「女仆装」这类，不必加前缀）
  { label: '', key: 'specialFeatures' }, // 特殊特征（耳钉 / 兽耳 / 呆毛…）
]

/** 形态的稳定标识，用作脏跟踪的键。 */
export function formKey(charId: string, formId: string): string {
  return `${charId}:${formId}`
}

function rawValue(profile: CharacterProfile, key: keyof CharacterProfile): string {
  const v = profile[key]
  if (Array.isArray(v)) return v.filter(Boolean).join('、')
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 从角色的**当前形态**拼一条外观描述。
 * 例：`纤细，身高 158cm，粉色长发，紫瞳，女仆装，左耳星形耳钉`
 */
export function buildAppearancePrompt(profile: CharacterProfile, formId?: string): string {
  const resolved = resolveForm(profile, formId)
  const parts: string[] = []
  for (const { label, key } of APPEARANCE_FIELDS) {
    const value = rawValue(resolved.profile, key)
    if (!value) continue
    parts.push(label ? `${label} ${value}` : value)
  }
  return parts.join('，')
}

/** 拼装结果对应的形态名，用于在界面上告诉用户「这段是按哪个形态拼的」。 */
export function appearanceFormName(profile: CharacterProfile, formId?: string): string {
  return resolveForm(profile, formId).name
}