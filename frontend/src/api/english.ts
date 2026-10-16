// 英语学习（feature `english_study`）：词库 / 伪随机复习队列 / 例句插图 / 成绩分析 / 语法练习。
//
// ⚠ 这个功能**不在本体内**（注册表里 folder='english-study'），它的数据和逻辑在一个独立项目里
// （`features/english-study/`），自己起一个只绑回环的小服务（默认 8766）。所以这里的请求全部打到
// `/english/api/…`，由 Vite 的代理转发过去 —— 见 `vite.config.ts` 里那条 `/english` 规则。
//
// 服务没起时这些请求会 502/连接失败：面板自己会按注册表把 serve 拉起来（见 EnglishStudyPanel 的
// 自动启动）—— 拉不起来才落到「服务没连上」那块提示。
//
// 三件事仍然复用**本体**的已有能力（这些是同一台机器上的另一个端口，不是这个功能的）：
//   · 例句插图 → /api/images/generate（结果落附件库，目录固定成 `english-vocab`）
//   · 发音     → /api/voice/tts（edge 晓晓）
//   · 传图     → /api/storage/attachments（附件管道）
// 人格 / 模型 / 密钥全在大脑那边 —— 这个功能只传 character_id（§9.6）。

const BASE = '/english'

async function asJson<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(BASE + path, init)
  } catch {
    // fetch 直接抛 = 连不上（服务没起，或代理那头 502）。
    throw new Error('连不上英语学习的服务（127.0.0.1:8766）。')
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
      // Vite 代理连不上 8766 时回的是 500（不是 502），所以整个 5xx 都算「服务没在跑」。
      throw new Error('英语学习的服务没在跑（代理连不上 127.0.0.1:8766）。')
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
  /** 谁答的（服务端补的，省得前端再查一次名册）。 */
  character_name?: string
  /** 追问串的 id —— 同一串问答共用一个，空 = 单发的老问题。 */
  conversation_id?: string
  /** 这是这一串里的第几轮（从 0 数）。 */
  turn_index?: number
  created_at: string
}

/** 从追问里总结出来的一条笔记（存下来以后好翻）。 */
export type VocabNote = {
  id: string
  word_id: string
  word: string
  title: string
  body: string
  /** 这条笔记是从哪几轮问答总结出来的。 */
  source_ids: string[]
  character_id: string
  created_at: string
  /** 总结时用了几轮问答（服务端算的）。 */
  turns?: number
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
  grammar: GrammarStats
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
  grammar: GrammarStats
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

// ── 语法（第二期）──

export type GrammarStatus = 'todo' | 'doing' | 'done'

export type GrammarNode = {
  id: string
  title: string
  /** 所属章节（「二、时态」这种）。 */
  chapter: string
  /** 上一层节点的标题（章下第一层为空）。 */
  parent: string
  /** true = 是章标题，不能出题。 */
  is_chapter: boolean
  /** 大纲自带的一句说明（多数没有）。 */
  note: string
  status: GrammarStatus
  /** 自己写的备注（照片索引 / 视频号都行）。 */
  my_note: string
}

export type GrammarStats = {
  practiced: number
  right: number
  half: number
  wrong: number
  done_nodes: number
  doing_nodes: number
  accuracy: number
}

export type GrammarTree = {
  nodes: GrammarNode[]
  stats: GrammarStats & { total_nodes: number; done_of: number }
}

/** 练习形式：中译英 / 填空 / 改写 / 造句。 */
export type GrammarKind = 'translate' | 'blank' | 'rewrite' | 'make'

export type GrammarExercise = {
  node_id: string
  node_title: string
  chapter: string
  kind: GrammarKind
  kind_label: string
  prompt: string
  hint: string
  reference: string
}

export type GrammarVerdict = 'right' | 'half' | 'wrong'

export type GrammarGrade = {
  id: string
  node_id: string
  node_title: string
  kind: GrammarKind
  prompt: string
  answer: string
  verdict: GrammarVerdict
  /** 两三句点评（判不出来时这里放模型的原文）。 */
  comment: string
  errors: { wrong: string; right: string; why: string }[]
  better: string
  created_at: string
}

/** 服务状态：计数 + 大脑通不通 + 小窝设置里那几项（§9.6.5）。 */
export const fetchVocabHealth = () => asJson<{
  ok: boolean
  db: string
  counts: VocabStats
  brain: boolean
  characters: { id: string; name: string; emoji?: string }[]
  batch: number
  coach_enabled: boolean
  filter_tag: string
  grammar: GrammarStats
  settings: string
}>('/api/health')

// ---- 总览 / 词表 ----

export async function fetchVocabOverview(): Promise<VocabOverview> {
  return asJson<VocabOverview>('/api/overview')
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
  return asJson(`/api/words?${q}`)
}

/** 单个词 —— **只有这一条路带例句和问答**（列表接口为了轻不带，见 english/api.py::h_get_word）。
 *
 * 展开某张词卡要看的例句 / 问答都从这儿拿：卡片上那份是列表接口给的快照，
 * 写完例句它不会变 —— 这就是老版本「点了写例句没反应」的根。
 */
export const fetchVocabWord = (id: string) =>
  asJson<VocabWord>(`/api/words/${encodeURIComponent(id)}`)

export async function createVocabWord(body: {
  word: string
  meaning?: string
  pos?: string
  phonetic?: string
  tag?: string
  note?: string
}): Promise<VocabWord> {
  return asJson<VocabWord>('/api/words', json(body))
}

export async function patchVocabWord(id: string, patch: Partial<VocabWord>): Promise<VocabWord> {
  return asJson<VocabWord>(`/api/words/${encodeURIComponent(id)}`, { ...json(patch), method: 'PATCH' })
}

export async function deleteVocabWord(id: string): Promise<void> {
  await asJson(`/api/words/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---- 复习队列 ----

/**
 * 取一屏复习队列。**伪随机顺序**（`seed` 决定这一轮的牌面），不是按字母顺下去。
 *
 * 排除项在这一侧记着（只有浏览器知道这个会话里发生过什么）：
 * · `seen` / `known` —— 出过的、点了「认识」的，下次不要再出现；
 * · `redrill` —— 答过「模糊 / 忘了」的要能回来，后端会插到队首。
 *
 * 用 POST 是因为那几串 id 背到后面会上千个，query string 塞不下。
 */
export async function fetchVocabQueue(opts: {
  limit?: number
  tag?: string
  /** 这一轮的牌面：同一个 seed 翻来覆去都是同一个顺序。换新的一轮就换一个。 */
  seed?: string
  seen?: string[]
  known?: string[]
  redrill?: string[]
} = {}): Promise<{ items: VocabWord[]; remaining: number; pool_size: number; stats: VocabStats }> {
  return asJson('/api/queue', json({
    limit: opts.limit ?? 50,
    tag: opts.tag ?? '',
    seed: opts.seed ?? '',
    seen: opts.seen ?? [],
    known: opts.known ?? [],
    redrill: opts.redrill ?? [],
  }))
}

/** 一次作答复盘。result 三档 = 认识 / 模糊 / 忘了，后端据此重排复习间隔。 */
export async function reviewVocabWord(
  wordId: string,
  result: 'known' | 'fuzzy' | 'forgot',
  opts: { mode?: string; elapsedMs?: number } = {},
): Promise<{ word: VocabWord; due_at: string }> {
  return asJson('/api/review', json({
    word_id: wordId,
    result,
    mode: opts.mode ?? 'recognize',
    elapsed_ms: Math.max(0, Math.round(opts.elapsedMs ?? 0)),
  }))
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
  return asJson<VocabExample>(`/api/words/${encodeURIComponent(wordId)}/examples`, json(body))
}

export async function deleteVocabExample(id: string): Promise<void> {
  await asJson(`/api/examples/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 请一位小糖人给这个词写几句有她味道的例句（写好直接落库）。 */
export async function generateVocabExamples(
  wordId: string,
  characterId: string,
  count = 3,
): Promise<{ items: { en: string; zh: string }[]; saved: VocabExample[]; character_id: string }> {
  return asJson(`/api/words/${encodeURIComponent(wordId)}/examples/generate`,
    json({ character_id: characterId, count, save: true }))
}

/** 就这个词问小糖人（语法 / 用法 / 辨析）。答完留档。
 *
 * 传了 `conversationId` 就是**接着这一串往下问**：服务端会把前面几轮拼进上下文，
 * 她就不会重复讲过的。不传 = 单发一个新问题。
 */
export async function askVocabQuestion(
  wordId: string,
  question: string,
  characterId: string,
  conversationId = '',
): Promise<VocabQuestion & { character_name: string; turns?: number }> {
  return asJson(`/api/words/${encodeURIComponent(wordId)}/ask`,
    json({ question, character_id: characterId, conversation_id: conversationId }))
}

/** 把一串追问总结成一条笔记存下来（走严格 JSON，不套人格）。
 *
 * `questionIds` 只传这一串里的那几条；不传 = 这个词的所有问答。
 */
export async function summarizeAsk(
  wordId: string,
  opts: { questionIds?: string[]; characterId?: string } = {},
): Promise<VocabNote> {
  return asJson(`/api/words/${encodeURIComponent(wordId)}/ask/summarize`,
    json({ question_ids: opts.questionIds, character_id: opts.characterId }))
}

/** 存下来的笔记（可只取某个词的）。 */
export const fetchVocabNotes = (wordId?: string, limit = 100) =>
  asJson<{ items: VocabNote[] }>(
    `/api/notes?${new URLSearchParams({
      ...(wordId ? { word_id: wordId } : {}), limit: String(limit),
    })}`)

export const deleteVocabNote = (noteId: string) =>
  asJson<{ ok: boolean; id: string }>(`/api/notes/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
  })

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
  return asJson<VocabExam>('/api/exams', json(body))
}

export async function deleteVocabExam(id: string): Promise<void> {
  await asJson(`/api/exams/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function fetchVocabAnalysis(days = 30, limit = 10): Promise<VocabAnalysis> {
  return asJson<VocabAnalysis>(`/api/analysis?days=${days}&limit=${limit}`)
}

// ---- 导入旧词表 ----

/**
 * 传一张词表。**先 dryRun 看一眼猜得对不对**（`columns` 是「哪列认成了什么」），
 * 认错了把列号传回来重导。
 *
 * 为什么要 base64：这个功能的服务是标准库 `http.server`，不想为 multipart 引依赖 ——
 * 前端把文件读成 base64 放进 JSON 里传过去就行。
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
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读这个文件失败'))
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      resolve(dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl)
    }
    reader.readAsDataURL(file)
  })
  return asJson<ImportResult>('/api/import', json({
    file_b64: base64,
    filename: file.name,
    tag: opts.tag ?? '',
    source: opts.source ?? '',
    dry_run: !!opts.dryRun,
    has_header: opts.hasHeader,
    columns: opts.columns,
  }))
}

// ---- 语法：目录树 / 进度 ----

export const fetchGrammarTree = () => asJson<GrammarTree>('/api/grammar/tree')

/** 标记一个语法点：学会了 / 在学 / 没开始，以及自己写备注。 */
export const patchGrammarNode = (nodeId: string, patch: { status?: GrammarStatus; note?: string }) =>
  asJson<GrammarNode>(`/api/grammar/nodes/${encodeURIComponent(nodeId)}`,
    { ...json(patch), method: 'PATCH' })

// ---- 语法：出题 / 批改 / 问 ----

/** 出一道题（题干 + 参考答案由 AI 现写，每次不一样）。 */
export const makeGrammarExercise = (body: {
  node_id: string
  kind: GrammarKind
  character_id?: string
}) => asJson<GrammarExercise>('/api/grammar/exercise', json(body))

/** 批改一份作答。四种练习共用这一条 —— 差别只在题干，判据一样。 */
export const gradeGrammarAnswer = (body: {
  node_id: string
  kind: GrammarKind
  prompt: string
  answer: string
  node_title?: string
}) => asJson<GrammarGrade>('/api/grammar/grade', json(body))

/** 就一个语法点问小糖人（讲解 / 辨析 / 「为什么」都行）。答完留档。 */
export const explainGrammarNode = (body: {
  node_id: string
  question?: string
  character_id?: string
}) => asJson<VocabQuestion & { node_id: string; node_title: string }>(
  '/api/grammar/explain', json(body))

export const fetchGrammarPractice = (nodeId?: string, limit = 50) =>
  asJson<{ items: GrammarGrade[]; stats: GrammarStats }>(
    `/api/grammar/practice?${new URLSearchParams({
      ...(nodeId ? { node_id: nodeId } : {}), limit: String(limit),
    })}`)