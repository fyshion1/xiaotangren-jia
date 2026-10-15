// 英语学习（feature `english_study`）：词库 / 复习队列 / 例句插图 / 成绩分析。
//
// 这个功能在本体内（注册表里 folder=""），所以直接调 /api/english/*，不走功能适配器那一层。
// 三件事复用了已有能力，不另起炉灶：
//   · 例句让小糖人写、语法问她 → 后端转发小窝大脑（/api/nest/chat 那份配置）
//   · 插图 → 走已有的 /api/images/generate，结果直接落附件库
//   · 发音 → 走已有的 /api/voice/tts（edge 晓晓）
//
// 插图的附件目录固定成 `english-vocab`（后端 `ATTACHMENT_SESSION` 给的就是这个名字），
// 别让生图落到聊天会话的目录里去 —— 删聊天记录会连插图一起带走。

async function asJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    let detail = ''
    try {
      detail = (await resp.json())?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

export type VocabExample = {
  id: string
  word_id: string
  text: string
  translation: string
  /** 哪位小糖人写的（留空 = 自己写的）。 */
  speaker: string
  /** 附件库里的引用 URL（插图原图），不是 base64。 */
  image: string
  image_thumb: string
  source: 'manual' | 'ai'
  created_at: string
}

export type VocabWord = {
  id: string
  word: string
  pos: string
  meaning: string
  phonetic: string
  /** 自己的分类：四级 / 六级 / 生词本…（导入时给，或后面手填）。 */
  tag: string
  /** 来自哪张表（导入时记下的文件名）。 */
  source: string
  note: string
  /** 0 新词 / 1 认识 / 2 模糊 / 3 熟练 */
  stage: number
  ease: number
  interval_days: number
  due_at: string
  reps: number
  lapses: number
  last_result: string
  created_at: string
  updated_at: string
  examples?: VocabExample[]
  questions?: VocabQuestion[]
}

export type VocabQuestion = {
  id: string
  word_id: string
  word: string
  question: string
  answer: string
  character_id: string
  created_at: string
}

export type VocabStats = {
  total: number
  due: number
  fresh: number
  solid: number
  reps: number
  lapses: number
  answered: number
  with_example: number
}

export type QuizSummary = {
  answered: number
  known: number
  fuzzy: number
  forgot: number
  avg_ms: number
  days_studied: number
}

export type VocabTag = { tag: string; count: number; due: number }

export type VocabExam = {
  id: string
  kind: 'quiz' | 'cet4' | 'cet6' | 'mock' | 'other'
  title: string
  score: number | null
  max_score: number | null
  total: number
  correct: number
  accuracy: number | null
  detail: Record<string, unknown>
  taken_at: string
  note: string
  created_at: string
}

export type VocabOverview = {
  stats: VocabStats
  quiz: QuizSummary
  tags: VocabTag[]
  /** 插图 / 生图落到哪个附件目录（前端调生图时要用）。 */
  attachment_session: string
  exams: VocabExam[]
}

export type WeakWord = {
  word: string
  wrong: number
  fuzzy: number
  seen: number
  miss_score: number
  accuracy: number
  avg_ms: number
  ease: number | null
  stage: number | null
  meaning: string
  tag: string
  pos: string
  word_id: string
}

export type VocabAnalysis = {
  window_days: number
  overview: VocabStats & QuizSummary & { recent_answered: number; accuracy: number }
  buckets: { fresh: number; learning: number; known: number; solid: number }
  weak_words: WeakWord[]
  weak_tags: { tag: string; seen: number; known: number; forgot: number; accuracy: number }[]
  slow_words: WeakWord[]
  daily: { date: string; answered: number; known: number; forgot: number; accuracy: number }[]
  exams: VocabExam[]
}

export type ImportResult = {
  dry_run: boolean
  columns: {
    word: number
    meaning: number
    pos: number
    phonetic: number
    tag: number
    header: string[] | null
    has_header: boolean
    format: string
  }
  parsed: number
  created?: number
  filled?: number
  skipped: number
  sample: { word: string; meaning: string; pos: string; phonetic: string; tag: string; source: string }[]
  skipped_sample: string[]
  total_now?: number
}

// ---- 总览 / 词表 ----

export async function fetchVocabOverview(): Promise<VocabOverview> {
  return asJson<VocabOverview>('/api/english/overview')
}

export async function fetchVocabWords(opts: {
  tag?: string
  stage?: number
  keyword?: string
  dueOnly?: boolean
  order?: 'due' | 'new' | 'alpha' | 'recent'
  limit?: number
  offset?: number
} = {}): Promise<{ items: VocabWord[]; total: number; offset: number; limit: number }> {
  const q = new URLSearchParams()
  if (opts.tag) q.set('tag', opts.tag)
  if (opts.stage !== undefined) q.set('stage', String(opts.stage))
  if (opts.keyword) q.set('keyword', opts.keyword)
  if (opts.dueOnly) q.set('due_only', 'true')
  q.set('order', opts.order ?? 'due')
  q.set('limit', String(opts.limit ?? 100))
  q.set('offset', String(opts.offset ?? 0))
  return asJson(`/api/english/words?${q}`)
}

export async function createVocabWord(body: {
  word: string
  meaning?: string
  pos?: string
  phonetic?: string
  tag?: string
  note?: string
}): Promise<VocabWord> {
  return asJson<VocabWord>('/api/english/words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchVocabWord(id: string, patch: Partial<VocabWord>): Promise<VocabWord> {
  return asJson<VocabWord>(`/api/english/words/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function deleteVocabWord(id: string): Promise<void> {
  await asJson(`/api/english/words/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---- 复习队列 ----

export async function fetchVocabQueue(
  limit = 50,
  tag?: string,
  skip = 0,
): Promise<{ items: VocabWord[]; count: number; skip: number; next_skip: number; stats: VocabStats }> {
  const q = new URLSearchParams({ limit: String(limit), skip: String(Math.max(0, skip)) })
  if (tag) q.set('tag', tag)
  return asJson(`/api/english/queue?${q}`)
}

/** 一次作答复盘。result 三档 = 认识 / 模糊 / 忘了，后端据此重排复习间隔。 */
export async function reviewVocabWord(
  wordId: string,
  result: 'known' | 'fuzzy' | 'forgot',
  opts: { mode?: string; elapsedMs?: number } = {},
): Promise<{ word: VocabWord; due_at: string }> {
  return asJson('/api/english/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      word_id: wordId,
      result,
      mode: opts.mode ?? 'recognize',
      elapsed_ms: Math.max(0, Math.round(opts.elapsedMs ?? 0)),
    }),
  })
}

// ---- 例句与插图 ----

export async function addVocabExample(
  wordId: string,
  body: {
    text?: string
    translation?: string
    speaker?: string
    image?: string
    image_thumb?: string
    source?: 'manual' | 'ai'
  },
): Promise<VocabExample> {
  return asJson<VocabExample>(`/api/english/words/${encodeURIComponent(wordId)}/examples`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteVocabExample(id: string): Promise<void> {
  await asJson(`/api/english/examples/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 请一位小糖人给这个词写几句有她味道的例句（写好直接落库）。 */
export async function generateVocabExamples(
  wordId: string,
  characterId: string,
  count = 3,
): Promise<{ items: { en: string; zh: string }[]; saved: VocabExample[]; character_id: string }> {
  return asJson(`/api/english/words/${encodeURIComponent(wordId)}/examples/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character_id: characterId, count, save: true }),
  })
}

/** 就这个词问小糖人（语法 / 用法 / 辨析）。答完留档。 */
export async function askVocabQuestion(
  wordId: string,
  question: string,
  characterId: string,
): Promise<VocabQuestion & { character_name: string }> {
  return asJson(`/api/english/words/${encodeURIComponent(wordId)}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, character_id: characterId }),
  })
}

// ---- 成绩与分析 ----

export async function addVocabExam(body: {
  kind?: string
  title?: string
  score?: number | null
  max_score?: number | null
  total?: number
  correct?: number
  detail?: Record<string, unknown>
  taken_at?: string
  note?: string
}): Promise<VocabExam> {
  return asJson<VocabExam>('/api/english/exams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteVocabExam(id: string): Promise<void> {
  await asJson(`/api/english/exams/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function fetchVocabAnalysis(days = 30, limit = 10): Promise<VocabAnalysis> {
  return asJson<VocabAnalysis>(`/api/english/analysis?days=${days}&limit=${limit}`)
}

// ---- 导入旧词表 ----

/**
 * 传一张词表。**先 dryRun 看一眼猜得对不对**（`columns` 是「哪列认成了什么」），
 * 认错了把列号传回来重导。
 */
export async function importVocabFile(
  file: File,
  opts: {
    tag?: string
    source?: string
    dryRun?: boolean
    hasHeader?: boolean
    columns?: Partial<Record<'word' | 'meaning' | 'pos' | 'phonetic' | 'tag', number>>
  } = {},
): Promise<ImportResult> {
  const fd = new FormData()
  fd.append('file', file, file.name)
  fd.append('tag', opts.tag ?? '')
  fd.append('source', opts.source ?? '')
  fd.append('dry_run', opts.dryRun ? 'true' : 'false')
  if (opts.hasHeader !== undefined) fd.append('has_header', opts.hasHeader ? 'true' : 'false')
  for (const key of ['word', 'meaning', 'pos', 'phonetic', 'tag'] as const) {
    const idx = opts.columns?.[key]
    if (idx !== undefined && idx >= 0) fd.append(`${key}_col`, String(idx))
  }
  return asJson<ImportResult>('/api/english/import', { method: 'POST', body: fd })
}