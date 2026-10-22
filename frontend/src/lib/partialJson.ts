// 流式中途解析：模型边吐边显示，词条也是边走边填的。
//
// 和后端 `services/card_import.py::parse_fields_partial` 对齐：半截 JSON 先补上
// 没收口的 `" ] }` 再解析；「键写全了但值没写完」的那个键丢掉 —— 没写完的值宁可不填。
// 这里只给**界面预览**用，最终落库以 `done` 事件里的 `fields` 为准。

import type { CharacterProfile } from '../data/characters'

/** 与后端 EXTRACT_FIELDS 的键一致（多出来的键这里一律不要）。 */
const KEYS = [
  'jp', 'alias', 'birthday', 'age', 'height', 'bloodType', 'constellation', 'occupation',
  'personality', 'likes', 'dislikes', 'catchphrase', 'bodyType', 'eyeColor', 'hairstyle',
  'hairColor', 'bust', 'hip', 'clothing', 'relationships', 'specialFeatures', 'weight',
  'measurements', 'secret', 'weakPoint', 'privateWish',
] as const
const LIST_KEYS = new Set(['personality', 'likes', 'dislikes'])
const EMPTY = /^(无|没有|未知|不明确|未提及|none|n\/?a|null|-|—)+$/i

/** 去掉 ```json 围栏，从第一个 `{` 截到最后（后面可能有解释文字）。 */
function stripFences(raw: string): string {
  const start = raw.indexOf('{')
  if (start < 0) return ''
  const fence = raw.indexOf('```', start + 1)
  return raw.slice(start, fence >= 0 ? fence : undefined)
}

/** 补上没收口的引号和括号；在字符串里就再补一个 `"`。 */
function balanced(text: string): string {
  let inStr = false
  let esc = false
  const stack: string[] = []
  for (const ch of text) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let out = ''
  const ch = text[text.length - 1]
  if (ch !== '{' && ch !== '[') out = text.replace(/,\s*$/, '')
  if (inStr) out += '"'
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  return out
}

/** 可用作「丢最后一个键」的截断点：每个 `,` 后面，或者 `{` 后面。 */
function boundaries(text: string): number[] {
  const points: number[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === ',') points.push(i + 1)
  }
  return points.reverse()
}

function tryParse(text: string): Record<string, unknown> | null {
  const attempts = [text, ...boundaries(text).map((cut) => text.slice(0, cut).replace(/,\s*$/, ''))]
  for (const t of attempts) {
    try {
      const obj = JSON.parse(balanced(t)) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>
    } catch {
      /* 下一个截断点 */
    }
  }
  return null
}

/** 半截 / 整段抽取文本 → 能用的词条（键集合与后端一致，空的一概不填）。 */
export function parseExtracted(raw: string): Partial<CharacterProfile> {
  const cleaned = stripFences(raw)
  if (!cleaned.trim()) return {}
  const obj = tryParse(cleaned)
  if (!obj) return {}
  const out: Record<string, unknown> = {}
  for (const key of KEYS) {
    const value = obj[key]
    if (LIST_KEYS.has(key)) {
      let items: string[] = []
      if (Array.isArray(value)) items = value.map((v) => String(v).trim()).filter(Boolean)
      else if (typeof value === 'string' && value.trim()) items = value.split(/[,，、/／]/).map((s) => s.trim()).filter(Boolean)
      if (items.length) out[key] = items.slice(0, 8)
    } else if (typeof value === 'string') {
      const text = value.trim().replace(/[。]$/, '')
      if (text && !EMPTY.test(text)) out[key] = text
    }
  }
  return out as Partial<CharacterProfile>
}
