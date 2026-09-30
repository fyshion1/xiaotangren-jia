// 人设「粘贴模板」解析（§Feature B）。
//
// 在 CharacterEditor 里把《角色设定.md》某一角色那一段整块粘进来（或按「标签：值」逐行手写），
// 前端解析成 CharacterProfile 字段，预览勾选后再填进表单。
// 纯前端：不读文件、不调后端、不动 seed —— 只做「文本 → 字段」的识别。
//
// 两种格式都认：
//   1. md 段落格式：标签行（可含「生日 · 年龄」「身高 / 血型 / 星座」复合标签）后隔空行取值行。
//   2. 「标签：值」逐行：`生日：3 月 14 日` / `性格：温柔、深情`。
import type { CharacterProfile } from '../data/characters'

export type FieldKey = keyof CharacterProfile

// 中文标签 → 字段。解析与预览表共用（预览按这个顺序展示）。
export const PROFILE_FIELD_LABELS: { label: string; key: FieldKey }[] = [
  { label: '名字', key: 'name' },
  { label: '日文假名', key: 'jp' },
  { label: '别名 / 称号', key: 'alias' },
  { label: '立绘图片 URL', key: 'portrait' },
  { label: '关于（角色提示词）', key: 'about' },
  { label: '生日', key: 'birthday' },
  { label: '年龄', key: 'age' },
  { label: '身高', key: 'height' },
  { label: '血型', key: 'bloodType' },
  { label: '星座', key: 'constellation' },
  { label: '性格', key: 'personality' },
  { label: '喜好', key: 'likes' },
  { label: '讨厌', key: 'dislikes' },
  { label: '口头禅', key: 'catchphrase' },
  { label: '体型', key: 'bodyType' },
  { label: '瞳色', key: 'eyeColor' },
  { label: '发型', key: 'hairstyle' },
  { label: '发色', key: 'hairColor' },
  { label: '胸部', key: 'bust' },
  { label: '臀部', key: 'hip' },
  { label: '服装', key: 'clothing' },
  { label: '职业', key: 'occupation' },
  { label: '关系', key: 'relationships' },
  { label: '特殊特征', key: 'specialFeatures' },
  { label: '体重', key: 'weight' },
  { label: '三围', key: 'measurements' },
  { label: '秘密', key: 'secret' },
  { label: '弱点', key: 'weakPoint' },
  { label: '私密小愿望', key: 'privateWish' },
]

export const LABEL_OF: Record<string, string> = Object.fromEntries(
  PROFILE_FIELD_LABELS.map((f) => [f.key, f.label]),
)

const LIST_KEYS: FieldKey[] = ['personality', 'likes', 'dislikes']

// 归一化标签：去空格、去 🔒/🔓 之类后缀标记，便于查表。
function normLabel(s: string): string {
  return s.replace(/\s+/g, '').replace(/[🔒🔓🔐]/g, '')
}

// 反查表：归一化标签 → 字段。一个字段可有多个写法。
const LABEL_MAP: Record<string, FieldKey> = (() => {
  const map: Record<string, FieldKey> = {}
  const add = (key: FieldKey, ...aliases: string[]) => {
    for (const a of aliases) map[normLabel(a)] = key
  }
  add('name', '名字', '姓名')
  add('jp', '日文假名', '假名')
  add('alias', '别名/称号', '别名', '称号')
  add('portrait', '立绘图片URL', '立绘图', '图片URL', '立绘')
  add('about', '关于', '角色提示词', '人设', '角色设定', '关于（角色提示词）')
  add('birthday', '生日')
  add('age', '年龄')
  add('height', '身高')
  add('bloodType', '血型')
  add('constellation', '星座')
  add('personality', '性格')
  add('likes', '喜好', '喜欢')
  add('dislikes', '讨厌')
  add('catchphrase', '口头禅')
  add('bodyType', '体型', '身材')
  add('eyeColor', '瞳色')
  add('hairstyle', '发型')
  add('hairColor', '发色')
  add('bust', '胸部')
  add('hip', '臀部')
  add('clothing', '服装', '衣着')
  add('occupation', '职业')
  add('relationships', '关系')
  add('specialFeatures', '特殊特征')
  add('weight', '体重')
  add('measurements', '三围')
  add('secret', '秘密')
  add('weakPoint', '弱点')
  add('privateWish', '私密小愿望', '小愿望')
  return map
})()

// 段落里出现、但不是词条的行（分组标题 / 状态标记），见到就跳过、不算「没认出来」。
const IGNORE_LINES = new Set(
  ['个人隐私词条', '私密词条', '外貌词条', '基本词条', '其他词条', '私密', '—', '——'].map(normLabel),
)

const SEP = /[·・•/／|丨]/
const VALUE_SEP = /\s*[·・•/／|丨]\s*/ // 复合标签的值分隔符（generic：标签用 /、值用 · 都能切）
const EMPTY_VALUES = /^(暂无|无|没有|未知|-|—|——|n\/a|na|null)$/i

export type ParseResult = {
  fields: Partial<CharacterProfile>
  warnings: string[]
}

// 标签行 → 标签数组；不是标签行返回 null。
// 例：「生日 · 年龄」→ ['生日','年龄']；「别名 / 称号」整体是一个已知标签 → ['别名 / 称号']。
function splitLabelLine(line: string): string[] | null {
  const raw = line.trim()
  if (!raw || raw.length > 60) return null
  if (LABEL_MAP[normLabel(raw)]) return [raw]
  if (!SEP.test(raw)) return null
  const parts = raw.split(SEP).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return null
  if (parts.every((p) => LABEL_MAP[normLabel(p)])) return parts
  return null
}

function genericSeparator(line: string): RegExp {
  if (line.includes('·')) return /\s*·\s*/
  if (line.includes('・')) return /\s*・\s*/
  if (line.includes('/')) return /\s*\/\s*/
  if (line.includes('／')) return /\s*／\s*/
  return /\s*[·・/／]\s*/
}

// 复合标签的值切分：先试标签自身用的分隔符，切成 n 段；切不出 n 段就用通用分隔符。
function splitCompound(valueLine: string, labelLine: string, n: number): string[] {
  const by = (re: RegExp) => valueLine.split(re).map((s) => s.trim()).filter(Boolean)
  const direct = by(genericSeparator(labelLine))
  if (direct.length === n) return direct
  const generic = by(VALUE_SEP)
  if (generic.length === n) return generic
  return direct.length ? direct : [valueLine.trim()]
}

function toList(value: string): string[] {
  return value
    .split(/[,，、/／]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function assign(
  fields: Partial<CharacterProfile>,
  warn: (msg: string) => void,
  key: FieldKey,
  rawValue: string,
) {
  const value = rawValue.trim()
  if (EMPTY_VALUES.test(value)) {
    warn(`「${LABEL_OF[key] ?? key}」是空的（原文写的是「${value}」），已跳过`)
    return
  }
  if (LIST_KEYS.includes(key)) {
    const list = toList(value)
    if (list.length) (fields[key] as string[]) = list
    return
  }
  ;(fields as Record<string, string>)[key] = value
}

  // 预筛：正文里的括号补充说明（如 md 里「标题（芳月诗音/…）」）不该被当成标签行。
  function looksLikeNoise(line: string): boolean {
    const t = line.trim()
    if (!t) return true
    if (/^[#＃🌸🎒🐾🍠✨📦🔒🔓*_\-—]+/.test(t)) return true
    if (/^（.*）$/.test(t) || /^\(.*\)$/.test(t)) return true
    return false
  }

// 像不像「人设词条文本」：至少得有 2 行是「标签 + 后随值行」或「标签：值」的结构，
// 才认为这是角色卡而不是随便贴的一段自然语言（自然语言不该冒一堆「没认出来」的警告）。
function hasFieldLikeStructure(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let hits = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^[^:：=]{1,20}\s*[:：=]\s*\S/.test(line)) {
      hits++
    } else if (splitLabelLine(line)) {
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length) hits++
    }
    if (hits >= 2) return true
  }
  return false
}

export function parseProfileText(text: string): ParseResult {
  const fields: Partial<CharacterProfile> = {}
  const warnings: string[] = []
  const seen = new Set<FieldKey>()
  const allowWarnings = hasFieldLikeStructure(text)
  const warn = (msg: string) => {
    if (allowWarnings) warnings.push(msg)
  }
  const put = (key: FieldKey, value: string) => {
    if (seen.has(key)) return
    seen.add(key)
    assign(fields, warn, key, value)
  }

  // 素材生产附录（角色设定.md 384 行之后）与后面几个角色的块都不要。
  let body = text.replace(/\r\n?/g, '\n')
  const appendix = body.search(/^#+\s*📦|^#+\s*素材生产/m)
  if (appendix >= 0) body = body.slice(0, appendix)
  // 多角色时只取第一块（用户一次粘一个角色）。
  const blocks = body.split(/^\s*---\s*$/m)
  const firstBlock = blocks.find((b) => b.trim()) ?? body

  const lines = firstBlock.split('\n')
  let seenLabel = false
  let gotAbout = false
  let prevNonEmpty = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    // 记录上一非空行：连续两行「像词条名」时，前一行只是角色块标题，跳过。
    const prev = prevNonEmpty
    prevNonEmpty = line

    // 1) 「标签：值」逐行
    const kv = line.match(/^([^:：=]{1,20})\s*[:：=]\s*(.*)$/)
    if (kv) {
      const key = LABEL_MAP[normLabel(kv[1])]
      if (key) {
        put(key, kv[2])
        seenLabel = true
        continue
      }
      // 「：」后面还有内容、但标签不认得 → 提醒，别静默丢
      if (kv[2].trim()) {
        warn(`没认出来的标签：「${kv[1].trim()}」`)
        continue
      }
    }

    // 2) md 段落：标签行 + 空行 + 值行
    const labels = splitLabelLine(line)
    if (labels) {
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length) {
        const valueLine = lines[j].trim()
        const parts = labels.length > 1 ? splitCompound(valueLine, line, labels.length) : [valueLine]
        labels.forEach((lb, idx) => {
          const key = LABEL_MAP[normLabel(lb)]
          if (key) put(key, parts[idx] ?? valueLine)
        })
        seenLabel = true
        i = j
        continue
      }
    }

    // 3) 首个「未打标签的长段落」= 角色提示词（about，喂给模型的核心）
    if (!gotAbout && !seenLabel && line.length >= 50 && !looksLikeNoise(line)) {
      put('about', line)
      seenLabel = true
      gotAbout = true
      continue
    }

    // 4) 看起来像标签行但没认出来 → 提醒（先排除角色块标题下的裸名字行）
    //    md 里标题行（🌸 1. 大诗音（…））下面常跟一行裸名字「大诗音」，那不是词条名。
    const headingLike = (s: string) => /^[#＃🌸🎒🐾🍠✨📦🔒🔓*_\-—]/.test(s) || /^\d+[.、)]/.test(s)
    const prevAlsoTitle =
      headingLike(prev) ||
      (!!prev && prev.length <= 30 && !LABEL_MAP[normLabel(prev)] && !/[。！？!?；;，,：:、·/／]/.test(prev))
    if (
      !prevAlsoTitle &&
      !IGNORE_LINES.has(normLabel(line)) &&
      !looksLikeNoise(line) &&
      line.length <= 14 &&
      !/[。！？!?；;，,]$/.test(line) &&
      !SEP.test(line)
    ) {
      let k = i + 1
      while (k < lines.length && !lines[k].trim()) k++
      if (k < lines.length) warn(`没认出来的标签：「${line}」`)
    }
  }

  if (!Object.keys(fields).length) {
    // 兜底：粘进来的整块都不像词条（例如附录里那种「## C. 🥇 大诗音」的素材条目），
    // 那就别硬塞进某个字段，提示用户一次粘一个角色的「人设」段落。
    warn('没识别出人设词条 —— 请一次粘贴一个角色的人设段落，或按「标签：值」逐行写')
  }
  return { fields, warnings }
}
