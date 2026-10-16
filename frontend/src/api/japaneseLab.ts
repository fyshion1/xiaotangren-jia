// 日语实验室（feature `japanese_lab`）：词库 / 复习 / 例句插图 / 成绩分析。
//
// ⚠ 这个功能**不在本体内**（注册表里 folder='japanese-lab'），它的数据和逻辑在一个独立项目里
// （`features/japanese-lab/`），自己起一个只绑回环的小服务（默认 8765）。所以这里的请求全部打到
// `/jplab/api/…`，由 Vite 的代理转发过去 —— 见 `vite.config.ts` 里那条 `/jplab` 规则。
//
// 服务没起时这些请求会 502/连接失败：面板自己会按注册表把 serve 拉起来（见 JapaneseLabPanel 的
// 自动启动）—— 拉不起来才落到「实验室没连上」那块提示。
// 只走用户自己的学习库，人格 / 模型 / 密钥全在大脑那边（功能只传 character_id，§9.6）。

const BASE = '/jplab'

async function asJson<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(BASE + path, init)
  } catch {
    // fetch 直接抛 = 连不上（服务没起，或代理那头 502）。
    throw new Error('连不上日语实验室的服务（127.0.0.1:8765）。')
  }
  if (!resp.ok) {
    let detail = ''
    try {
      const got = await resp.json()
      detail = got?.error ?? got?.detail ?? ''
    } catch {
      /* 不是 JSON（比如代理的 502 页面） */
    }
    if (!detail && resp.status >= 500) {
      // Vite 代理连不上 8765 时回的是 500（不是 502），所以整个 5xx 都算「服务没在跑」。
      throw new Error('日语实验室的服务没在跑（代理连不上 127.0.0.1:8765）。')
    }
    throw new Error(detail || `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// ── 类型（字段名跟功能自己的库对齐，不另起一套）──

export type JpLevel = 'N5' | 'N4' | 'N3' | 'N2' | 'N1'

export type JpWord = {
  id: number
  term: string
  reading: string
  meaning: string
  pos: string
  level: string
  tags: string
  source: string
  note: string
  /** 下次该复习的日子（YYYY-MM-DD）。 */
  due: string
  interval_days: number
  ease: number
  reps: number
  lapses: number
  last_grade: string
  last_at: string
  created_at: string
}

/** 一档复习结果：再来一次 / 有点模糊 / 记住了 / 太简单。 */
export type JpGrade = 'again' | 'hard' | 'good' | 'easy'

export type JpAsset = {
  id: number
  url: string
  thumb: string
  origin: string
  path: string
  caption: string
  /** 能直接当 <img src> 用的地址（功能已经补好大脑的域名前缀）。 */
  src: string
  thumb_src: string
}

export type JpExample = {
  id: number
  word_id: number
  jp: string
  zh: string
  note: string
  asset_id: number | null
  /** 1 = 自己写的；0 = 小糖人给的草稿（改过再算自己的）。 */
  mine: number
  created_at: string
  asset: JpAsset | null
  asset_src: string
  asset_thumb_src: string
}

export type JpScore = {
  id: number
  taken_on: string
  name: string
  kind: string
  level: string
  /** total | vocab | grammar | reading | listening */
  section: string
  score: number | null
  full: number | null
  note: string
  analysis: string
  analysis_at: string
  created_at: string
}

export type JpScoreOverview = {
  exams: { taken_on: string; name: string; level: string; kind: string
           sections: Record<string, { score: number | null; full: number | null }> }[]
  latest: Record<string, { taken_on: string; score: number | null; full: number | null; name: string }>
  /** 最近一次里不到七成的项（只列事实，不解读）。 */
  weak: { section: string; rate: number }[]
  count: number
}

export type JpCounts = { total: number; by_level: Record<string, number>; due: number; learned: number }

export type JpProgress = {
  counts: JpCounts
  series: { day: string; c: number }[]
  recent: { at: string; grade: string; term: string; reading: string }[]
  streak: number
  last_import: string
  /** 语法单独一份 —— 它的复习流水不和单词混着算打卡。 */
  grammar: {
    counts: JpGrammarCounts
    series: { day: string; c: number }[]
    recent: { at: string; grade: string; point: string; book: string; lesson: number }[]
    streak: number
  }
}

/** 一张语法卡：一个语法点 = 一张卡（讲解 + 例句 + 练习 + 自己的 SRS）。 */
export type JpGrammar = {
  id: number
  /** 初级上 / 初级下 / 中级上 / 中级下 / 高级上 / 高级下。 */
  book: string
  lesson: number
  unit: number
  point: string
  title: string
  level: string
  /** 「说什么 / 怎么用 / 什么坑」三段讲解，让小糖人分三口气讲。 */
  meaning: string
  usage: string
  pitfall: string
  examples: { jp: string; zh?: string }[]
  drills: { q: string; hint?: string; answer?: string }[]
  tags: string
  due: string
  interval_days: number
  ease: number
  reps: number
  lapses: number
  last_grade: string
  last_at: string
  created_at: string
}

export type JpGrammarCounts = {
  total: number
  /** 按册分（顺序是教材顺序，不是字母序）。 */
  by_book: Record<string, number>
  due: number
  learned: number
}

export type JpGrammarOutline = {
  total: number
  by_book: Record<string, number>
  lesson_cards: number
  path: string
  sample: { book: string; unit: number; lesson: number; title: string; point: string }[]
}

export type JpImportRow = {
  term: string
  reading: string
  meaning: string
  pos: string
  level: string
  tags: string
  source_row: number
}

export type JpImportStats = {
  tables: number
  paragraphs: number
  rows: number
  header: Record<string, number>
  /** false = 没认出表头，列是按顺序**猜**的 —— 预览里要提醒一句。 */
  header_found: boolean
  with_reading: number
  with_meaning: number
  levels: Record<string, number>
}

export type JpSource = { path: string; name: string; suffix: string; size: number; folder: string }

export type JpConfig = {
  config: Record<string, unknown>
  effective: Record<string, unknown>
  characters: { id: string; name: string; emoji?: string }[]
  brain_ok: boolean
  default_character: string
}

// ── 服务状态 / 配置 ──

/** 服务状态。`levels` / `daily_new` / `coach_enabled` 是小窝设置里那几项（§9.6.5），
 *  前端拿它当初始值 —— 另两项（谁陪你、成绩谁看）在后端直接用，不用前端管。 */
export const fetchJpLabHealth = () => asJson<{
  ok: boolean
  version: string
  db: string
  counts: JpCounts
  brain: boolean
  settings: string
  levels: string[]
  daily_new: number
  coach_enabled: boolean
  /** 语法卡计数（服务是后加的字段 —— 老服务没有，前端按「可能是 undefined」用）。 */
  grammar_counts?: JpGrammarCounts
}>('/api/health')

export const fetchJpLabConfig = () => asJson<JpConfig>('/api/config')

// ── 单词 ──

export const fetchJpWords = (opts: {
  level?: string; q?: string; due?: boolean; limit?: number; offset?: number; order?: string
} = {}) => {
  const qs = new URLSearchParams()
  if (opts.level) qs.set('level', opts.level)
  if (opts.q) qs.set('q', opts.q)
  if (opts.due) qs.set('due', '1')
  if (opts.limit) qs.set('limit', String(opts.limit))
  if (opts.offset) qs.set('offset', String(opts.offset))
  if (opts.order) qs.set('order', opts.order)
  const tail = qs.toString()
  return asJson<{ words: JpWord[]; counts: JpCounts }>(`/api/words${tail ? `?${tail}` : ''}`)
}

export const fetchJpWord = (id: number) =>
  asJson<{ word: JpWord; examples: JpExample[] }>(`/api/words/${id}`)

export const createJpWord = (body: Partial<JpWord> & { term: string }) =>
  asJson<{ id: number; created: boolean }>('/api/words', json(body))

export const patchJpWord = (id: number, body: Partial<JpWord>) =>
  asJson<{ ok: boolean }>(`/api/words/${id}`, { ...json(body), method: 'PATCH' })

export const deleteJpWord = (id: number) =>
  asJson<{ ok: boolean }>(`/api/words/${id}`, { method: 'DELETE' })

/** 复习一次，写回 SRS 排期，返回这次之后的下次到期日。 */
export const gradeJpWord = (id: number, grade: JpGrade) =>
  asJson<{ due: string; interval_days: number; reps: number; lapses: number }>(
    `/api/words/${id}/grade`, json({ grade }))

/** 让她讲这个词（一口气一段：说什么 / 怎么用 / 什么坑）。 */
export const explainJpWord = (id: number, characterId = '') =>
  asJson<{ character_id: string; explain: { intro?: string; usage?: string; pitfall?: string } }>(
    `/api/words/${id}/explain`, json({ character_id: characterId }))

/** ⚠ 拿到的是**草稿**（mine=0）—— 存的时候才决定算不算自己的例句。 */
export const draftJpExamples = (id: number, characterId = '', count = 3) =>
  asJson<{ character_id: string; drafts: { jp: string; zh: string; note: string }[] }>(
    `/api/words/${id}/draft`, json({ character_id: characterId, count }))

export const addJpExample = (wordId: number, body: {
  jp: string; zh?: string; note?: string; asset_id?: number | null; mine?: boolean
}) => asJson<{ id: number }>(`/api/words/${wordId}/examples`, json(body))

export const patchJpExample = (id: number, body: Partial<JpExample>) =>
  asJson<{ ok: boolean }>(`/api/examples/${id}`, { ...json(body), method: 'PATCH' })

export const deleteJpExample = (id: number) =>
  asJson<{ ok: boolean }>(`/api/examples/${id}`, { method: 'DELETE' })

// ── 问小糖人（语法 / 用法 / 辨析）──

export const askJpCoach = (question: string, opts: { characterId?: string; context?: string } = {}) =>
  asJson<{ character_id: string; answer: string }>('/api/ask', json({
    question, character_id: opts.characterId ?? '', context: opts.context ?? '',
  }))

// ── 成绩 ──

export const fetchJpScores = () =>
  asJson<{ scores: JpScore[]; overview: JpScoreOverview }>('/api/scores')

export const addJpScore = (body: {
  taken_on: string; name?: string; kind?: string; level?: string
  section?: string; score?: number | null; full?: number | null; note?: string
}) => asJson<{ id: number }>('/api/scores', json(body))

export const deleteJpScore = (id: number) =>
  asJson<{ ok: boolean }>(`/api/scores/${id}`, { method: 'DELETE' })

/** 让小糖人写分析。第一次算、之后读缓存；`force` 重写，`mode='rule'` 不花钱。 */
export const analyzeJpScores = (scoreId: number, opts: {
  characterId?: string; force?: boolean; mode?: 'llm' | 'rule'
} = {}) => asJson<{ analysis: string; cached: boolean; mode?: string; character_id?: string }>(
  `/api/scores/${scoreId}/analyze`,
  json({ character_id: opts.characterId ?? '', force: !!opts.force, mode: opts.mode ?? '' }))

// ── 插图（走大脑的附件管道；大脑不通时功能自己兜底，返回值里 via 说清了走的哪条路）──

export const fetchJpAssets = () => asJson<{ assets: JpAsset[] }>('/api/assets')

export const uploadJpAsset = (file: File, opts: { caption?: string; tag?: string } = {}) =>
  new Promise<{ id: number; src: string; thumb_src: string; via: 'brain' | 'local' }>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读这个文件失败'))
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const base64 = dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl
      void asJson<{ id: number; src: string; thumb_src: string; via: 'brain' | 'local' }>(
        '/api/assets',
        json({ data: base64, filename: file.name, caption: opts.caption ?? '', tag: opts.tag ?? '' }),
      ).then(resolve).catch(reject)
    }
    reader.readAsDataURL(file)
  })

export const deleteJpAsset = (id: number) =>
  asJson<{ ok: boolean }>(`/api/assets/${id}`, { method: 'DELETE' })

// ── 导入旧单词表 ──

/** 扫「个人数据库」里的日语资料 —— 只列出来，不读内容。 */
export const fetchJpImportSources = () => asJson<{ sources: JpSource[] }>('/api/import/sources')

/** 预览：解析一份表，**一个字都不写库**。确认了再调 importJpRows。 */
export const previewJpImport = (body: {
  source?: string; filename?: string; data?: string; level?: string
}) => asJson<{ rows: JpImportRow[]; stats: JpImportStats; filename: string; hint: string }>(
  '/api/import/preview', json(body))

export const importJpRows = (rows: JpImportRow[], source: string) =>
  asJson<{ ok: boolean; created: number; updated: number; skipped: number; counts: JpCounts }>(
    '/api/import/rows', json({ rows, source }))

// ── 语法卡（新标日 初级/中级/高级）──
//
// 和单词那套**平行但独立**：各自的表、各自的 SRS。语法考的是「会不会用」，单词考的是
// 「记没记住词」—— 混在一个复习队列里两头都不顺手（功能那边的 store.py 顶上也写了）。

/** 列语法卡。`book` 留空 = 全部；`due` 只要今天该复习的；默认按教材顺序排。 */
export const fetchJpGrammar = (opts: {
  book?: string; lesson?: number; q?: string; due?: boolean
  limit?: number; offset?: number; order?: string
} = {}) => {
  const qs = new URLSearchParams()
  if (opts.book) qs.set('book', opts.book)
  if (opts.lesson) qs.set('lesson', String(opts.lesson))
  if (opts.q) qs.set('q', opts.q)
  if (opts.due) qs.set('due', '1')
  if (opts.limit) qs.set('limit', String(opts.limit))
  if (opts.offset) qs.set('offset', String(opts.offset))
  if (opts.order) qs.set('order', opts.order)
  const tail = qs.toString()
  return asJson<{ grammar: JpGrammar[]; counts: JpGrammarCounts }>(
    `/api/grammar${tail ? `?${tail}` : ''}`)
}

export const fetchJpGrammarCounts = () => asJson<JpGrammarCounts>('/api/grammar/counts')

export const fetchJpGrammarCard = (id: number) =>
  asJson<{ grammar: JpGrammar }>(`/api/grammar/${id}`)

export const createJpGrammar = (body: Partial<JpGrammar> & { point: string; book: string }) =>
  asJson<{ id: number; created: boolean }>('/api/grammar', json(body))

export const patchJpGrammar = (id: number, body: Partial<JpGrammar>) =>
  asJson<{ ok: boolean }>(`/api/grammar/${id}`, { ...json(body), method: 'PATCH' })

export const deleteJpGrammar = (id: number) =>
  asJson<{ ok: boolean }>(`/api/grammar/${id}`, { method: 'DELETE' })

/** 复习一张语法卡（和单词同一套四档，但间隔拉得更长 —— 语法会用了不容易忘）。 */
export const gradeJpGrammar = (id: number, grade: JpGrade) =>
  asJson<{ due: string; interval_days: number; reps: number; lapses: number }>(
    `/api/grammar/${id}/grade`, json({ grade }))

/** 让她讲这条语法（三口气：说什么 / 怎么用 / 什么坑）。讲完会写回卡片，下次不用再问。 */
export const explainJpGrammar = (id: number, characterId = '') =>
  asJson<{ character_id: string; explain: { meaning?: string; usage?: string; pitfall?: string } }>(
    `/api/grammar/${id}/explain`, json({ character_id: characterId }))

/** ⚠ 练习**草稿** —— 优先造句题，存不存由你定。 */
export const draftJpGrammarDrills = (id: number, characterId = '', count = 3) =>
  asJson<{ character_id: string; drafts: { q: string; hint: string; answer: string }[] }>(
    `/api/grammar/${id}/drills`, json({ character_id: characterId, count }))

/** 自己用这条语法造一句，让她当场批。**不写库** —— 批语是当场看的。 */
export const checkJpSentence = (id: number, sentence: string, characterId = '') =>
  asJson<{ character_id: string; answer: string }>(
    `/api/grammar/${id}/check`, json({ sentence, character_id: characterId }))

/** 大纲（`语法大纲.md`）里有多少张卡 —— **不写库**，先看一眼再导。 */
export const fetchJpGrammarOutline = () => asJson<JpGrammarOutline>('/api/grammar/outline')

/** 把大纲导成语法卡。只补空字段 —— 讲过的、改过的不冲掉；重复点是安全的。 */
export const importJpGrammarOutline = () =>
  asJson<{ ok: boolean; created: number; updated: number; total_in_outline: number
           counts: JpGrammarCounts }>('/api/grammar/outline', json({}))

// ── 进度 / 导出 ──

export const fetchJpProgress = () => asJson<JpProgress>('/api/progress')

export const exportJpLab = () => asJson<{ json: string }>('/api/export')