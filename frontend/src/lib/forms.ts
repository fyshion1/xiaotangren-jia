// 形态（§17）前端工具：把「基础档案 + 形态覆盖项」解析成一张完整的角色档案。
//
// 存储约定（对齐后端 services/prompt/forms.py）：
//   - 基础形态直接用顶层平铺字段（现有那份档案就是基础形态）；
//   - 其余形态只存覆盖项 `forms[i].fields`，缺失的键沿用基础形态；
//   - `activeFormId` 缺省 = BASE_FORM_ID。
//
// 角色 id 永远不变 —— 换形态不动单聊会话历史（`single-<charId>`）与个人记忆（按 char_id 分桶）。
import { BASE_FORM_ID, type CharacterForm, type CharacterProfile } from '../data/characters'

export { BASE_FORM_ID }

export type ResolvedForm = {
  id: string
  name: string
  /** 解析后的完整档案（除 id / name 外全部字段都已回退好）。 */
  profile: CharacterProfile
}

/** 基础形态的显示名。 */
export function baseFormName(p: CharacterProfile): string {
  return p.baseFormName?.trim() || '基础形态'
}

/** 全部形态，基础形态恒在第一位。 */
export function listForms(p: CharacterProfile): CharacterForm[] {
  const base: CharacterForm = { id: BASE_FORM_ID, name: baseFormName(p), fields: {} }
  return [base, ...(p.forms ?? [])]
}

/** 当前激活的形态 id（缺省 / 指向不存在的形态时回退基础形态）。 */
export function activeFormId(p: CharacterProfile): string {
  const id = p.activeFormId
  if (!id || (id !== BASE_FORM_ID && !(p.forms ?? []).some((f) => f.id === id))) return BASE_FORM_ID
  return id
}

/** 把形态覆盖项并进基础档案，得到一个「完整的她」。 */
export function resolveForm(p: CharacterProfile, formId?: string): ResolvedForm {
  const id = formId ?? activeFormId(p)
  const base: CharacterForm = { id: BASE_FORM_ID, name: baseFormName(p), fields: {} }
  const form = listForms(p).find((f) => f.id === id) ?? base
  // 覆盖字段永远不含身份字段（类型上已排除 id/name），这里再剥一次防御历史脏数据
  const { id: _ignoredId, name: _ignoredName, ...over } = form.fields as Record<string, unknown>
  void _ignoredId
  void _ignoredName
  return {
    id: form.id,
    name: form.name,
    profile: { ...p, ...over, id: p.id, name: p.name, activeFormId: form.id },
  }
}
