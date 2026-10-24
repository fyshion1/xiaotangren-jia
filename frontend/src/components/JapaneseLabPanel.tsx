// 糖人小窝 · 日语实验室面板（feature `japanese_lab`）。
//
// 这是个**独立项目**（`features/japanese-lab/`），不在本体里：它自己起一个只绑回环的小服务
// （默认 8765），本面板的请求全走 `/jplab/api/…`，由 Vite 代理转过去。所以：
//   · 服务没起 → **面板自己按注册表把它拉起来**（见下面 autoStart）：前端只报功能 id + 注册表里
//     声明的子命令名 `serve`，命令串完全由后端拼 —— 「前端不许传任意命令」这条边界不破。
//   · 人格 / 模型 / 密钥全在大脑那边 —— 这个面板只传 `character_id`（§9.6），一句人设都不存。
//   · 插图走**本体的附件管道**（去重 + 缩略图），不在功能里另建图片目录（§9.6.4）。
//
// 对应对用户承诺的这几条：
//   ① 导入旧单词表 → 「导入」页：先扫「个人数据库」里的日语资料 / 也可以直接传文件，
//                     **先预览**（它会告诉你认出了哪些列），确认了才入库
//   ② 例句 + 插图 → 词卡里：让她写例句草稿 / 自己写 / 传插图；不懂的语法就在下面那个框里问她
//   ③ 成绩与薄弱点 → 「成绩」页：记分 + **让小糖人写分析**（规则版兜底，不花钱）
//   ④ 复习         → 首页抽卡：四档作答（再来/模糊/记住/太简单）直接改下次到期日
//   ⑤ 追问与笔记    → 词卡 / 语法卡上问完可以**接着追问**（前几轮原样带过去，她接得上话）；
//                     聊完点「✍️ 让她总结」收成一段笔记，满意了「📌 记下来」存进「追问笔记」页。
//                     **随口问的不落盘** —— 只有点了记下来的才进库，所以那页翻到的都是想留的。
//   ⑥ 大纲         → 语法页最下面的「📖 大纲」：册 → 单元 → 课 → 语法点，和姐妹项目
//                     （english-study）一个套路，摊开看「六册一共要学什么」。
//                     ⚠ 大纲是**内容源**（`语法大纲.md`），改它不用改代码；卡片只是照它建的。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addJpExample, addJpScore, analyzeJpScores, askJpCoach, createJpWord, deleteJpExample,
  deleteJpScore, deleteJpWord, deleteJpThread, draftJpExamples, explainJpWord, exportJpLab,
  checkJpSentence, draftJpGrammarDrills, explainJpGrammar, fetchJpThread, fetchJpThreads,
  fetchJpGrammar, fetchJpGrammarOutline, fetchJpGrammarOutlineTree, fetchJpImportSources,
  fetchJpLabConfig, fetchJpLabHealth,
  fetchJpProgress, fetchJpScores, fetchJpWord, fetchJpWords, gradeJpGrammar, gradeJpWord,
  importJpGrammarOutline, importJpRows, patchJpExample, patchJpThread, patchJpWord,
  previewJpImport, saveJpThread, summarizeDraftJpThread, summarizeJpThread, uploadJpAsset,
  type JpCounts, type JpExample, type JpGrade, type JpGrammar, type JpGrammarCounts,
  type JpGrammarOutlineTree, type JpImportRow, type JpImportStats, type JpOutlineNode,
  type JpProgress,
  type JpScore, type JpScoreOverview,
  type JpSource, type JpThread, type JpTurn, type JpWord,
} from '../api/japaneseLab'
import { fetchNestRunStatus, runNestFeature } from '../api/client'
import NestSettingsPanel from './NestSettingsPanel'

type Tab = 'review' | 'words' | 'grammar' | 'import' | 'scores' | 'notes'
type Roster = { id: string; name: string; emoji?: string }

const TABS: { id: Tab; label: string }[] = [
  { id: 'review', label: '🔁 复习' },
  { id: 'words', label: '📚 词表' },
  { id: 'grammar', label: '📐 语法' },
  { id: 'import', label: '📥 导入' },
  { id: 'scores', label: '📊 成绩' },
  { id: 'notes', label: '📝 追问笔记' },
]

const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1']

// 四档作答 —— 顺序和手感对齐背单词的直觉：从「想不起来」到「太轻松」。
const GRADES: { id: JpGrade; label: string; hint: string; cls: string }[] = [
  { id: 'again', label: '忘了', hint: '明天重来', cls: 'grade-again' },
  { id: 'hard', label: '模糊', hint: '间隔慢点涨', cls: 'grade-hard' },
  { id: 'good', label: '记住了', hint: '按节奏拉长', cls: 'grade-good' },
  { id: 'easy', label: '太简单', hint: '跳得快点', cls: 'grade-easy' },
]

const SECTION_LABEL: Record<string, string> = {
  total: '总分', vocab: '词汇', grammar: '语法', reading: '阅读', listening: '听力',
}

/** 到期日 → 「今天该看 / 明天 / 3 天后 / 9月1日」。 */
function dueText(due: string): string {
  if (!due) return '随时可以看'
  const t = Date.parse(due.slice(0, 10) + 'T00:00:00')
  if (Number.isNaN(t)) return due.slice(0, 10)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((t - today.getTime()) / 86400000)
  if (days <= 0) return '今天该看'
  if (days === 1) return '明天'
  if (days < 30) return `${days} 天后`
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读这个文件失败'))
    reader.onload = () => {
      const url = String(reader.result || '')
      resolve(url.includes(',') ? url.split(',', 2)[1] : url)
    }
    reader.readAsDataURL(file)
  })
}

function fmtSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

// ── 小挂件 ──

function Err({ text }: { text: string }) {
  if (!text) return null
  return (
    <p className="mb-2 rounded-lg bg-[var(--pink-soft)] px-3 py-1.5 text-[12px] leading-relaxed text-[var(--pink-deep)]">
      {text}
    </p>
  )
}

function RosterPicker({ roster, value, onChange }: {
  roster: Roster[]; value: string; onChange: (id: string) => void
}) {
  if (roster.length <= 1) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {roster.map((c) => (
        <button key={c.id} type="button" className={`form-chip ${value === c.id ? 'on' : ''}`}
          onClick={() => onChange(c.id)}>{c.emoji ? `${c.emoji} ` : ''}{c.name}</button>
      ))}
    </div>
  )
}

// ── 问小糖人：一问 → 追问 → 总结 → 存下来 ──
//
// 「追问」和「新开一问」的区别只在**要不要把前几轮带上**（`turns`）：
//   不带 → 她当新话题从头答（老行为，一个字没改）；
//   带上 → 服务端拼成 us/她交替的对话，她接着上一句说，指代（「这个」「那它呢」）也接得住。
//
// 落盘时机（重要）：**聊的时候不进库**，只在内存里攒这一屏。点「📌 记下来」才 POST。
// 这样「随口问两句」不占地方，留着的都是真打算以后翻的 —— 也正是「方便以后查看」的那批。
//
// 总结：点「✍️ 让她总结」先看没存的草稿总结（不好就接着问，没代价）；存了之后在「追问笔记」
// 里还能再总结一次（写回库里那栏）。她总结得不合意，那栏可以直接手改。
function FollowUpBox({ roster, coachOn, context, compact = false, onSaved }: {
  roster: Roster[]
  /** 小窝设置里「让她讲词和答疑」开着没 —— 关了就藏输入框（后端也会拦）。 */
  coachOn: boolean
  /** 她答话时贴着的上下文（当前这个词 / 这条语法）。整段追问都用同一个。 */
  context: string
  /** 无卡片包着的场合（语法页）少点内边距。 */
  compact?: boolean
  onSaved?: (t: JpThread) => void
}) {
  const [charId, setCharId] = useState('')
  const [question, setQuestion] = useState('')
  // 这一屏攒着的问答 —— **只在内存里**，点了「记下来」才进库。
  const [turns, setTurns] = useState<JpTurn[]>([])
  const [draftSummary, setDraftSummary] = useState('')
  const [savedId, setSavedId] = useState<number | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const activeChar = charId || roster[0]?.id || ''
  const activeName = roster.find((c) => c.id === activeChar)?.name ?? '小糖人'

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag); setErr('')
    try { await fn() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  // 发送：带上**这一屏之前所有轮**（这就是「追问」），她答完把这轮 push 进去。
  const send = () => run('ask', async () => {
    const q = question.trim()
    if (!q) throw new Error('先写要问什么')
    const got = await askJpCoach(q, { characterId: activeChar, context, turns })
    setTurns((list) => [...list, { q, a: got.answer }])
    setQuestion('')
    // 又聊了新的一轮 → 之前那份草稿总结就过期了，清掉免得存下对不上的东西。
    setDraftSummary('')
  })

  const summarize = () => run('sum', async () => {
    if (!turns.length) throw new Error('先问两句再总结')
    const got = await summarizeDraftJpThread({ turns, characterId: activeChar, context })
    setDraftSummary(got.summary)
  })

  const save = () => run('save', async () => {
    if (!turns.length) throw new Error('还没有聊出什么')
    const got = await saveJpThread({ turns, characterId: activeChar, context, summary: draftSummary })
    setSavedId(got.thread.id)
    onSaved?.(got.thread)
  })

  const clear = () => { setTurns([]); setDraftSummary(''); setSavedId(null); setErr('') }

  if (!coachOn) return null

  return (
    <div className={compact ? '' : 'mb-3'}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="eyebrow">不懂就问她（语法 / 用法 / 辨析都行）</span>
        {turns.length > 0 && (
          <span className="text-[11px] text-[var(--text-3)]">
            已经聊了 {turns.length} 轮 · 下面接着问就是追问
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <input className="input min-w-0 flex-1" value={question}
          placeholder={turns.length ? '接着问：那它和……的区别呢？' : '比如：は 和 が 到底怎么选？'}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send() }} />
        <button className="btn sm shrink-0" disabled={!!busy || !question.trim()} onClick={() => void send()}>
          {busy === 'ask' ? '她在想…' : turns.length ? '追问' : '问她'}
        </button>
      </div>

      {turns.length > 0 && (
        <div className="mt-2 space-y-2">
          {turns.map((t, i) => (
            <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
              <p className="text-[12px] text-[var(--text-3)]">
                {i === 0 ? '你问：' : `追问 ${i}：`}{t.q}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
                <b className="text-[var(--pink-deep)]">{activeName}：</b>{t.a}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* 收尾：总结 + 存 + 清（只有聊过才出现） */}
      {turns.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="btn ghost sm" disabled={!!busy} onClick={() => void summarize()}>
            {busy === 'sum' ? '她正在收拢…' : draftSummary ? '🔁 重新总结' : '✍️ 让她总结'}
          </button>
          <button className="btn sm" disabled={!!busy} onClick={() => void save()}>
            {busy === 'save' ? '存…' : savedId ? '再存一份' : '📌 记下来'}
          </button>
          <button className="btn ghost sm" disabled={!!busy} onClick={clear}>🗑 清掉这屏</button>
          <RosterPicker roster={roster} value={charId} onChange={setCharId} />
        </div>
      )}

      {draftSummary && (
        <div className="mt-2 rounded-xl border border-[color-mix(in_srgb,var(--pink)_30%,var(--border))] bg-[var(--pink-soft)] p-3">
          <p className="eyebrow mb-1">她收拢的笔记（还没存）</p>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">{draftSummary}</p>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">
            觉得不对就接着追问，再让她总结一遍；满意了再点「📌 记下来」。
          </p>
        </div>
      )}

      {savedId !== null && (
        <p className="mt-2 text-[12px] text-[var(--mint)]">
          ✅ 存好了（笔记 #{savedId}）—— 去「📝 追问笔记」页就能翻到，那儿还能让她再总结一次或加星。
        </p>
      )}

      <Err text={err} />
    </div>
  )
}

// ── 追问笔记：存下来的那些问答 ──

function ThreadDetail({ id, roster, onChanged, onClose }: {
  id: number
  roster: Roster[]
  onChanged: () => void
  onClose: () => void
}) {
  const [thread, setThread] = useState<JpThread | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => setThread((await fetchJpThread(id)).thread), [id])

  useEffect(() => { void load().catch((e) => setErr(e instanceof Error ? e.message : String(e))) }, [load])

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag); setErr('')
    try { await fn(); await load(); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  if (!thread) return <div className="p-3 text-[12px] text-[var(--text-3)]">{err || '读笔记…'}</div>
  const who = roster.find((c) => c.id === thread.character_id)?.name ?? '小糖人'

  return (
    <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-[15px]">{thread.starred ? '⭐ ' : ''}{thread.title}</b>
        <span className="text-[11px] text-[var(--text-3)]">
          {thread.turn_count} 轮 · {thread.updated_at.slice(0, 16).replace('T', ' ')}
        </span>
        <button className="btn ghost sm ml-auto" disabled={!!busy}
          onClick={() => void run('star', async () => { await patchJpThread(thread.id, { starred: !thread.starred }) })}>
          {thread.starred ? '取消加星' : '⭐ 加星'}
        </button>
        <button className="btn ghost sm" onClick={onClose}>收起</button>
      </div>
      {thread.context && (
        <p className="mb-2 text-[11px] text-[var(--text-3)]">当时在看：{thread.context}</p>
      )}

      {/* 总结在这一栏 —— 没总结过就明说，按钮也摆在最显眼处 */}
      <div className="mb-3 rounded-xl border border-[color-mix(in_srgb,var(--pink)_30%,var(--border))] bg-[var(--pink-soft)] p-3">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="eyebrow">她收拢的笔记</span>
          {thread.summary_at && (
            <span className="text-[11px] text-[var(--text-3)]">{thread.summary_at.slice(0, 16).replace('T', ' ')} 写的</span>
          )}
          <button className="btn ghost sm ml-auto" disabled={!!busy}
            onClick={() => void run('sum', async () => { await summarizeJpThread(thread.id, thread.character_id) })}>
            {busy === 'sum' ? '她正在收拢…' : thread.summary ? '🔁 重新总结' : '✍️ 让她总结'}
          </button>
          <button className="btn ghost sm" disabled={!!busy}
            onClick={() => setEditing(editing === null ? (thread.summary || '') : null)}>
            {editing === null ? '✏️ 自己改' : '不改了'}
          </button>
        </div>
        {editing === null ? (
          thread.summary
            ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{thread.summary}</p>
            : <p className="text-[12px] text-[var(--text-3)]">还没总结 —— 点右边那个按钮让她收拢一段。</p>
        ) : (
          <div>
            <textarea className="textarea" rows={4} value={editing} onChange={(e) => setEditing(e.target.value)} />
            <div className="mt-1 flex gap-2">
              <button className="btn sm" disabled={!!busy}
                onClick={() => void run('edit', async () => {
                  await patchJpThread(thread.id, { summary: editing })
                  setEditing(null)
                })}>存这段</button>
              <button className="btn ghost sm" onClick={() => setEditing(null)}>算了</button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {thread.turns?.map((t, i) => (
          <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-[12px] text-[var(--text-3)]">{i === 0 ? '你问：' : `追问 ${i}：`}{t.q}</p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">
              <b className="text-[var(--pink-deep)]">{who}：</b>{t.a}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className="input min-w-0 flex-1" defaultValue={thread.title} placeholder="改个标题"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== thread.title) void run('title', async () => { await patchJpThread(thread.id, { title: v }) }) }} />
        <button className="btn ghost sm" disabled={!!busy}
          onClick={() => void run('del', async () => { if (window.confirm(`删掉「${thread.title}」这篇笔记？`)) { await deleteJpThread(thread.id); onClose() } })}>
          删掉
        </button>
      </div>
      <Err text={err} />
    </div>
  )
}

function NotesTab({ roster, coachOn }: { roster: Roster[]; coachOn: boolean }) {
  const [threads, setThreads] = useState<JpThread[]>([])
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async (kw: string) => {
    setLoading(true); setErr('')
    try { setThreads((await fetchJpThreads(kw)).threads) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load('') }, [load])

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input className="input min-w-0 flex-1" placeholder="找笔记：搜问题、正文、总结里都行"
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void load(q) }} />
        <button className="btn sm" onClick={() => void load(q)}>搜</button>
        {q && <button className="btn ghost sm" onClick={() => { setQ(''); void load('') }}>清空</button>}
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-[var(--text-2)]">
        这儿是你在词卡 / 语法卡上追问完、点了「📌 记下来」的那些。
        <b>随口问的不在这儿</b> —— 那些聊完就散了，不占地方。
      </p>

      {loading ? (
        <p className="text-[12px] text-[var(--text-3)]">读笔记…</p>
      ) : threads.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-[13px] text-[var(--text-3)]">
          还没有存过笔记。去词卡 / 语法卡上问她一句，再追着问两轮，点「📌 记下来」就出现在这儿了。
        </p>
      ) : (
        <div className="space-y-2">
          {threads.map((t) => (
            <div key={t.id}>
              <button type="button" onClick={() => setOpenId(openId === t.id ? null : t.id)}
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left">
                <div className="flex flex-wrap items-baseline gap-2">
                  <b className="text-[13px]">{t.starred ? '⭐ ' : ''}{t.title || '（没写标题）'}</b>
                  {t.summary && <span className="chip">总结过</span>}
                  <span className="ml-auto text-[11px] text-[var(--text-3)]">
                    {t.turn_count} 轮 · {t.updated_at.slice(0, 10)}
                  </span>
                </div>
                {t.head && <p className="mt-0.5 truncate text-[11px] text-[var(--text-3)]">你问：{t.head}</p>}
                {t.summary && (
                  <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--text-2)]">{t.summary}</p>
                )}
              </button>
              {openId === t.id && (
                <div className="mt-2">
                  <ThreadDetail id={t.id} roster={roster} onChanged={() => void load(q)} onClose={() => setOpenId(null)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!coachOn && (
        <p className="mt-2 text-[11px] text-[var(--text-3)]">
          「让她讲词和答疑」现在关着 —— 看已有笔记没问题，但总结要她去说，得先去小窝设置里打开。
        </p>
      )}
      <Err text={err} />
    </div>
  )
}

// ── 词卡详情：例句 / 插图 / 讲词 / 问她 / 备注 ──

function WordDetail({ wordId, roster, coachOn, onChanged, onClose }: {
  wordId: number
  roster: Roster[]
  /** 小窝设置里「让她讲词和答疑」开着没 —— 关了就藏按钮（后端也会拦）。 */
  coachOn: boolean
  onChanged: () => void
  onClose: () => void
}) {
  const [word, setWord] = useState<JpWord | null>(null)
  const [examples, setExamples] = useState<JpExample[]>([])
  const [charId, setCharId] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  // 她「分几口气」讲出来的三段（说什么 / 怎么用 / 什么坑）
  const [explain, setExplain] = useState<{ intro?: string; usage?: string; pitfall?: string } | null>(null)
  const [drafts, setDrafts] = useState<{ jp: string; zh: string; note: string }[]>([])
  const [form, setForm] = useState({ jp: '', zh: '', note: '' })
  const [meta, setMeta] = useState({ meaning: '', pos: '', level: 'N5', tags: '', note: '' })
  // 点「配张图」时记下挂到哪条 —— 上传完要用；不记的话永远挂到第一条上。
  const [attachTo, setAttachTo] = useState<number | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)

  const pickFile = (exampleId?: number) => { setAttachTo(exampleId); fileRef.current?.click() }

  const activeChar = charId || roster[0]?.id || ''
  const activeName = roster.find((c) => c.id === activeChar)?.name ?? '小糖人'

  const load = useCallback(async () => {
    const got = await fetchJpWord(wordId)
    setWord(got.word)
    setExamples(got.examples)
    setMeta({
      meaning: got.word.meaning, pos: got.word.pos, level: got.word.level || 'N5',
      tags: got.word.tags, note: got.word.note,
    })
  }, [wordId])

  useEffect(() => {
    void load().catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [load])

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag); setErr('')
    try { await fn(); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const addExample = () => run('ex', async () => {
    if (!form.jp.trim()) throw new Error('例句不能空着')
    await addJpExample(wordId, { jp: form.jp, zh: form.zh, note: form.note })
    setForm({ jp: '', zh: '', note: '' })
    await load()
  })

  // 她的草稿：**带 mine=false 存进来**，说明是参考，不算「自己写的例句」。
  const keepDraft = (d: { jp: string; zh: string; note: string }) => run('keep', async () => {
    await addJpExample(wordId, { jp: d.jp, zh: d.zh, note: d.note, mine: false })
    setDrafts((list) => list.filter((x) => x.jp !== d.jp))
    await load()
  })

  /** 认作自己的例句 —— 存下来时才改 mine，改过一遍才记得住。 */
  const claim = (ex: JpExample) => run('claim', async () => {
    await patchJpExample(ex.id, { mine: 1 })
    await load()
  })

  /** 把一张（已经进过附件库的）图挂到某条例句上。`assetId` 是附件管道回的 id。 */
  const attachImage = (assetId: number, exampleId?: number) => run('img', async () => {
    const target = exampleId ?? examples[0]?.id
    if (target) {
      await patchJpExample(target, { asset_id: assetId })
    } else {
      // 一条例句都还没有：建一条空例句专门挂图（和英语那边一个做法，免得多一套「图库」概念）
      await addJpExample(wordId, { jp: '', asset_id: assetId, mine: false })
    }
    await load()
  })

  const upload = (file: File, exampleId?: number) => run('up', async () => {
    const saved = await uploadJpAsset(file, { tag: word?.term })
    await attachImage(saved.id, exampleId)
  })

  const explainWord = () => run('explain', async () => {
    if (!activeChar) throw new Error('还没有小糖人 —— 先去介绍页建一位')
    const got = await explainJpWord(wordId, activeChar)
    setExplain(got.explain)
  })

  const draft = () => run('draft', async () => {
    if (!activeChar) throw new Error('还没有小糖人 —— 先去介绍页建一位')
    const got = await draftJpExamples(wordId, activeChar, 3)
    setDrafts(got.drafts)
    if (got.drafts.length === 0) throw new Error(`${activeName}这次没写出草稿，再点一次试试`)
  })

  const saveMeta = () => run('meta', async () => {
    await patchJpWord(wordId, meta)
    await load()
  })

  if (!word) return <div className="mt-2 p-4 text-[12px] text-[var(--text-3)]">读词卡…</div>

  // 她答话时贴着的上下文：这个词本身 + 第一条例句。整段追问都用同一个（中途不换词卡）。
  const askContext = [word.term, word.reading, word.meaning, examples[0]?.jp].filter(Boolean).join(' / ')

  return (
    <div className="mt-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-4">
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <b className="text-[22px] text-[var(--text)]">{word.term}</b>
            {word.reading && <span className="text-[14px] text-[var(--text-3)]">{word.reading}</span>}
            <span className="chip">{word.level}</span>
          </div>
          <p className="mt-1 text-[12px] text-[var(--text-3)]">
            {[word.pos, word.tags || '未分类', word.source && `来自 ${word.source}`].filter(Boolean).join(' · ')}
            {' · '}下次 {dueText(word.due)} · 学过 {word.reps} 次 / 忘过 {word.lapses} 次
          </p>
        </div>
        <button className="btn ghost sm shrink-0" onClick={onClose}>收起</button>
      </div>

      <Err text={err} />

      {/* 释义 / 词性 / 级别 / 标签 —— 直接改，失焦就存 */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow">释义</span>
          <input className="input mt-1" value={meta.meaning} placeholder="中文意思"
            onChange={(e) => setMeta({ ...meta, meaning: e.target.value })} onBlur={() => void saveMeta()} />
        </label>
        <label className="block">
          <span className="eyebrow">词性</span>
          <input className="input mt-1" value={meta.pos} placeholder="名词 / 一类动词…"
            onChange={(e) => setMeta({ ...meta, pos: e.target.value })} onBlur={() => void saveMeta()} />
        </label>
        <label className="block">
          <span className="eyebrow">级别</span>
          <select className="input mt-1" value={meta.level}
            onChange={(e) => { setMeta({ ...meta, level: e.target.value }); void run('meta', async () => { await patchJpWord(wordId, { level: e.target.value }) }) }}>
            {LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">标签</span>
          <input className="input mt-1" value={meta.tags} placeholder="新标日第一课…"
            onChange={(e) => setMeta({ ...meta, tags: e.target.value })} onBlur={() => void saveMeta()} />
        </label>
      </div>

      {/* 让她讲这个词（小窝设置里能整体关掉 —— 关了就整块不出现，省得点了报错） */}
      {coachOn && (
      <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="eyebrow">让她讲这个词</span>
          <button className="btn ghost sm" disabled={!!busy} onClick={() => void explainWord()}>
            {busy === 'explain' ? '她正在想…' : `💬 让${activeName}说两句`}
          </button>
          <RosterPicker roster={roster} value={activeChar} onChange={setCharId} />
        </div>
        {explain ? (
          <div className="space-y-1.5">
            {explain.intro && <p className="text-[13px] leading-relaxed text-[var(--text)]">{explain.intro}</p>}
            {explain.usage && (
              <p className="text-[13px] leading-relaxed text-[var(--text)]">
                <span className="text-[var(--text-3)]">这么说：</span>{explain.usage}
              </p>
            )}
            {explain.pitfall && (
              <p className="text-[13px] leading-relaxed text-[var(--text-2)]">
                <span className="text-[var(--text-3)]">别踩：</span>{explain.pitfall}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[12px] text-[var(--text-3)]">
            她会分几句话说清「是什么意思 / 怎么用 / 哪里容易错」—— 说不出来就是那口气没接上，不是编的。
          </p>
        )}
      </div>
      )}

      {/* 例句 + 插图 */}
      <div className="mb-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="eyebrow">例句与插图</span>
          {coachOn && (
            <button className="btn ghost sm" disabled={!!busy} onClick={() => void draft()}>
              {busy === 'draft' ? '她正在写…' : `✍️ 让${activeName}写草稿`}
            </button>
          )}
          <button className="btn ghost sm" disabled={!!busy} onClick={() => pickFile(examples[0]?.id)}>
            {busy === 'up' ? '上传中…' : '🖼 传插图'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f, attachTo) }} />
        </div>

        {/* 她的草稿：收下也标成「参考」，改过才算自己的 */}
        {drafts.length > 0 && (
          <ul className="mb-2 space-y-1.5">
            {drafts.map((d) => (
              <li key={d.jp} className="flex items-start gap-2 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] text-[var(--text)]">{d.jp}</p>
                  {d.zh && <p className="text-[12px] text-[var(--text-2)]">{d.zh}</p>}
                  <p className="mt-0.5 text-[11px] text-[var(--text-3)]">
                    {activeName}的草稿 —— 自己改写一遍再算数
                  </p>
                </div>
                <button className="btn ghost sm shrink-0" disabled={!!busy}
                  onClick={() => void keepDraft(d)}>收下</button>
              </li>
            ))}
          </ul>
        )}

        {examples.length === 0 ? (
          <p className="text-[12px] text-[var(--text-3)]">
            还没有例句。自己写一句身边的事，或者让她先给个草稿 —— 用自己的句子记，词才留得住。
          </p>
        ) : (
          <ul className="space-y-2">
            {examples.map((ex) => (
              <li key={ex.id} className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                {ex.asset_thumb_src || ex.asset_src ? (
                  <img src={ex.asset_thumb_src || ex.asset_src} alt="" loading="lazy"
                    className="h-20 w-20 shrink-0 rounded-lg object-cover" />
                ) : null}
                <div className="min-w-0 flex-1">
                  {ex.jp && <p className="text-[14px] leading-relaxed text-[var(--text)]">{ex.jp}</p>}
                  {ex.zh && <p className="text-[12px] text-[var(--text-2)]">{ex.zh}</p>}
                  {ex.note && <p className="mt-0.5 text-[11px] text-[var(--text-3)]">{ex.note}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-3)]">
                    {ex.mine
                      ? <span className="chip">自己写的</span>
                      : <span>她的参考</span>}
                    {!ex.mine && (
                      <button className="underline" disabled={!!busy} onClick={() => void claim(ex)}>
                        改成自己写的
                      </button>
                    )}
                    <button className="underline" disabled={!!busy} onClick={() => pickFile(ex.id)}>
                      {ex.asset_id ? '换张图' : '配张图'}
                    </button>
                    <button className="underline" disabled={!!busy}
                      onClick={() => void run('del', async () => { await deleteJpExample(ex.id); await load() })}>删</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 space-y-1.5">
          <input className="input" placeholder="自己写一条例句…" value={form.jp}
            onChange={(e) => setForm({ ...form, jp: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') void addExample() }} />
          <div className="flex gap-2">
            <input className="input" placeholder="中文（可空）" value={form.zh}
              onChange={(e) => setForm({ ...form, zh: e.target.value })} />
            <input className="input" placeholder="想记的点（可空）" value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <button className="btn sm shrink-0" disabled={!!busy || !form.jp.trim()}
              onClick={() => void addExample()}>加例句</button>
          </div>
        </div>
      </div>

      {/* 问她（同上：关掉了就整块不出现）—— 现在是「一问 → 追问 → 总结 → 存」那一整块 */}
      <FollowUpBox roster={roster} coachOn={coachOn} context={askContext} />

      {/* 自己的备注 */}
      <div>
        <span className="eyebrow mb-1 block">我自己的备注</span>
        <textarea className="textarea" rows={2} value={meta.note}
          onChange={(e) => setMeta({ ...meta, note: e.target.value })}
          placeholder="记点自己容易错的地方…" onBlur={() => void saveMeta()} />
      </div>
    </div>
  )
}

// ── 复习：抽卡 ──

function ReviewTab({ roster, coachOn, onChanged, counts, startLevels, dailyNew }: {
  roster: Roster[]
  coachOn: boolean
  onChanged: () => void
  counts: JpCounts | null
  /** 小窝设置里「现在学哪几级」—— 开面板就照它开抽，不用每次手点。 */
  startLevels: string[]
  dailyNew: number
}) {
  const [queue, setQueue] = useState<JpWord[]>([])
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [levels, setLevels] = useState<string[]>(startLevels.length ? startLevels : ['N5'])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const [lastGrade, setLastGrade] = useState<string>('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (lv: string[], due: boolean) => {
    setLoading(true); setErr('')
    try {
      const got = await fetchJpWords({ level: lv.join(','), due, order: 'due', limit: 200 })
      setQueue(got.words); setIndex(0); setRevealed(false)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(levels, true) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // 「刷新」时把设置里的级别也重新读一遍 —— 在小窝里改完「现在学哪几级」不用重开页面。
  useEffect(() => { setLevels(startLevels.length ? startLevels : ['N5']) },
    [startLevels.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const current = queue[index]

  const grade = async (g: JpGrade) => {
    if (!current) return
    setBusy(g); setErr('')
    try {
      const got = await gradeJpWord(current.id, g)
      setLastGrade(`${current.term} → ${dueText(got.due)}`)
      setIndex((i) => i + 1); setRevealed(false)
      onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const toggleLevel = (lv: string) => {
    const next = levels.includes(lv) ? levels.filter((x) => x !== lv) : [...levels, lv]
    const safe = next.length ? next : [lv]
    setLevels(safe)
    void load(safe, true)
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="eyebrow">只抽这几级</span>
        <span className="text-[11px] text-[var(--text-3)]">（初始值来自小窝设置「现在学哪几级」）</span>
        {LEVELS.map((lv) => (
          <button key={lv} type="button" className={`form-chip ${levels.includes(lv) ? 'on' : ''}`}
            onClick={() => toggleLevel(lv)}>{lv}</button>
        ))}
        <button className="btn ghost sm" onClick={() => void load(levels, true)}>🔄 刷新队列</button>
        <button className="btn ghost sm" onClick={() => void load(levels, false)}>看看全部</button>
      </div>

      <Err text={err} />

      {loading ? (
        <p className="text-[13px] text-[var(--text-3)]">翻库中…</p>
      ) : !current ? (
        <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-6 text-center">
          <p className="text-[15px] font-bold">这一轮抽完了 🎉</p>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">
            {counts?.total
              ? `库里一共 ${counts.total} 个词，现在没到期的了。明天再来，或者去「📥 导入」加点新词。`
              : '库还是空的 —— 先去「📥 导入」把旧单词表导进来。'}
          </p>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">
            选题量由小窝设置里的「每天背几个新词」管（现在是 {dailyNew} 个）—— 不在这一页偷偷加，免得你以为漏了。
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-6">
          <div className="mb-3 flex items-center justify-between text-[11px] text-[var(--text-3)]">
            <span>第 {index + 1} / {queue.length} 张 · {current.level} · 该看：{dueText(current.due)}</span>
            {lastGrade && <span>上一张：{lastGrade}</span>}
          </div>

          {/* 正面：只有词形。想不起来就看假名，想起来就直接答。 */}
          <div className="py-6 text-center">
            <p className="text-[38px] font-extrabold leading-tight tracking-wide text-[var(--text)]">{current.term}</p>
            {revealed ? (
              <div className="mt-3 space-y-1">
                {current.reading && <p className="text-[17px] text-[var(--text-2)]">{current.reading}</p>}
                {current.meaning && <p className="text-[15px] text-[var(--text)]">{current.meaning}</p>}
                <p className="text-[12px] text-[var(--text-3)]">
                  {[current.pos, current.tags].filter(Boolean).join(' · ')}
                </p>
                {current.note && <p className="text-[12px] text-[var(--pink-deep)]">备注：{current.note}</p>}
              </div>
            ) : (
              <button className="btn ghost sm mt-4" onClick={() => setRevealed(true)}>🙈 看答案</button>
            )}
          </div>

          {/* 四档作答：直接改下次到期日 */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {GRADES.map((g) => (
              <button key={g.id} className={`btn sm ${g.id === 'good' ? '' : 'ghost'}`}
                disabled={!!busy} onClick={() => void grade(g.id)}>
                {busy === g.id ? '…' : `${g.label}`}
              </button>
            ))}
          </div>
          <p className="mt-2 text-center text-[11px] text-[var(--text-3)]">
            忘了 → 明天重来 · 模糊 → 慢慢拉长 · 记住了 / 太简单 → 越隔越久
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-[12px]">
            <button className="underline text-[var(--text-2)]"
              onClick={() => setDetailId(detailId === current.id ? null : current.id)}>
              {detailId === current.id ? '收起词卡' : '展开词卡（例句 / 插图 / 问她）'}
            </button>
            <button className="underline text-[var(--text-3)]" onClick={() => { setIndex((i) => i + 1); setRevealed(false) }}>
              先跳过这张
            </button>
          </div>

          {detailId === current.id && (
            <WordDetail wordId={current.id} roster={roster} coachOn={coachOn}
              onChanged={onChanged} onClose={() => setDetailId(null)} />
          )}
        </div>
      )}
    </div>
  )
}

// ── 词表 ──

function WordsTab({ roster, coachOn, onChanged, counts }: {
  roster: Roster[]; coachOn: boolean; onChanged: () => void; counts: JpCounts | null
}) {
  const [words, setWords] = useState<JpWord[]>([])
  const [q, setQ] = useState('')
  const [level, setLevel] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ term: '', reading: '', meaning: '', pos: '', level: 'N5', tags: '' })
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (kw: string, lv: string) => {
    setLoading(true); setErr('')
    try {
      const got = await fetchJpWords({ q: kw, level: lv, limit: 200, order: 'recent' })
      setWords(got.words)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load('', '') }, [load])

  const add = async () => {
    setBusy('add'); setErr('')
    try {
      if (!form.term.trim()) throw new Error('词形不能空着')
      await createJpWord({ ...form, source: 'manual' })
      setForm({ term: '', reading: '', meaning: '', pos: '', level: form.level, tags: form.tags })
      setAdding(false)
      await load(q, level)
      onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const remove = async (w: JpWord) => {
    if (!window.confirm(`删掉「${w.term}」？它的例句和复习记录也一起删。`)) return
    try { await deleteJpWord(w.id); setDetailId(null); await load(q, level); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-[240px]" placeholder="搜词形 / 假名 / 释义…" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void load(q, level) }} />
        <select className="input max-w-[110px]" value={level}
          onChange={(e) => { setLevel(e.target.value); void load(q, e.target.value) }}>
          <option value="">全部级别</option>
          {LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
        </select>
        <button className="btn ghost sm" onClick={() => void load(q, level)}>搜</button>
        <button className="btn sm ml-auto" onClick={() => setAdding((v) => !v)}>
          {adding ? '收起' : '＋ 加一个词'}
        </button>
      </div>

      {counts && (
        <p className="mb-2 text-[12px] text-[var(--text-3)]">
          共 {counts.total} 个 · 学过 {counts.learned} 个 · 今天该看 {counts.due} 个 ·{' '}
          {LEVELS.filter((lv) => counts.by_level[lv]).map((lv) => `${lv} ${counts.by_level[lv]}`).join(' / ')}
        </p>
      )}

      {adding && (
        <div className="mb-3 grid gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3 sm:grid-cols-3">
          <input className="input" placeholder="词形（汉字 / 假名）" value={form.term}
            onChange={(e) => setForm({ ...form, term: e.target.value })} />
          <input className="input" placeholder="假名读法" value={form.reading}
            onChange={(e) => setForm({ ...form, reading: e.target.value })} />
          <input className="input" placeholder="中文释义" value={form.meaning}
            onChange={(e) => setForm({ ...form, meaning: e.target.value })} />
          <input className="input" placeholder="词性" value={form.pos}
            onChange={(e) => setForm({ ...form, pos: e.target.value })} />
          <select className="input" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
            {LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
          </select>
          <input className="input" placeholder="标签（第几课…）" value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          <button className="btn sm sm:col-span-3" disabled={busy === 'add'} onClick={() => void add()}>
            {busy === 'add' ? '存…' : '存进词库'}
          </button>
        </div>
      )}

      <Err text={err} />

      {loading ? (
        <p className="text-[13px] text-[var(--text-3)]">读词库…</p>
      ) : words.length === 0 ? (
        <p className="text-[13px] text-[var(--text-3)]">
          没找到词。换关键词试试，或者去「📥 导入」把旧单词表导进来。
        </p>
      ) : (
        <ul className="space-y-1.5">
          {words.map((w) => (
            <li key={w.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="flex items-center gap-3 px-3 py-2">
                <button className="min-w-0 flex-1 text-left"
                  onClick={() => setDetailId(detailId === w.id ? null : w.id)}>
                  <span className="text-[15px] font-bold text-[var(--text)]">{w.term}</span>
                  {w.reading && <span className="ml-2 text-[12px] text-[var(--text-3)]">{w.reading}</span>}
                  {w.meaning && <span className="ml-2 text-[12px] text-[var(--text-2)]">{w.meaning}</span>}
                </button>
                <span className="chip shrink-0">{w.level}</span>
                <span className="shrink-0 text-[11px] text-[var(--text-3)]">{dueText(w.due)}</span>
                <button className="shrink-0 text-[11px] text-[var(--text-3)] underline"
                  onClick={() => void remove(w)}>删</button>
              </div>
              {detailId === w.id && (
                <div className="px-3 pb-3">
                  <WordDetail wordId={w.id} roster={roster} coachOn={coachOn}
                    onChanged={onChanged} onClose={() => setDetailId(null)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── 导入：先预览，认了才入库 ──

function ImportTab({ onDone, defaultLevel }: { onDone: () => void; defaultLevel: string }) {
  const [sources, setSources] = useState<JpSource[]>([])
  const [rows, setRows] = useState<JpImportRow[]>([])
  const [stats, setStats] = useState<JpImportStats | null>(null)
  const [filename, setFilename] = useState('')
  const [level, setLevel] = useState(defaultLevel)
  const [sourceLabel, setSourceLabel] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const scan = useCallback(async () => {
    setBusy('scan'); setErr('')
    try { setSources((await fetchJpImportSources()).sources) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }, [])

  useEffect(() => { void scan() }, [scan])

  const preview = async (body: { source?: string; filename?: string; data?: string }, label: string) => {
    setBusy('preview'); setErr(''); setDone('')
    try {
      const got = await previewJpImport({ ...body, level })
      setRows(got.rows); setStats(got.stats); setFilename(got.filename); setSourceLabel(label)
      if (got.rows.length === 0) {
        setErr('这份表里没解析出词 —— 可能它不是单词表（课文 / 语法笔记），或者格式不支持。')
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const pick = (file: File) => {
    void (async () => {
      try {
        const data = await fileToBase64(file)
        await preview({ filename: file.name, data }, file.name)
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    })()
  }

  const commit = async () => {
    if (!rows.length) return
    setBusy('commit'); setErr('')
    try {
      const got = await importJpRows(rows, sourceLabel || filename || 'import')
      setDone(`入库完成：新加 ${got.created} 个，更新 ${got.updated} 个${got.skipped ? `，跳过 ${got.skipped}` : ''}。`
        + `现在库里一共 ${got.counts.total} 个词。`)
      setRows([]); setStats(null)
      onDone()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const editRow = (i: number, patch: Partial<JpImportRow>) =>
    setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const dropRow = (i: number) => setRows((list) => list.filter((_, j) => j !== i))

  return (
    <div>
      <div className="mb-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <p className="text-[13px] leading-relaxed text-[var(--text-2)]">
          以前攒的单词表不用重录。**先预览**：它会告诉你认出了哪几列（认不出就按「词形 / 假名 / 释义 / 词性」的顺序猜，
          猜的时候我会说明），你改完、删掉不想收的行，才真的入库。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="eyebrow">没写级别就用这个</span>
          {LEVELS.map((lv) => (
            <button key={lv} type="button" className={`form-chip ${level === lv ? 'on' : ''}`}
              onClick={() => setLevel(lv)}>{lv}</button>
          ))}
          <button className="btn ghost sm ml-auto" disabled={busy === 'scan'} onClick={() => void scan()}>
            {busy === 'scan' ? '扫…' : '🔍 找「个人数据库」里的日语资料'}
          </button>
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            {busy === 'preview' ? '解析中…' : '📄 传一份表'}
          </button>
          <input ref={fileRef} type="file" accept=".docx,.xlsx,.csv,.tsv,.txt,.md" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pick(f) }} />
        </div>
      </div>

      <Err text={err} />
      {done && (
        <p className="mb-2 rounded-lg bg-[var(--pink-soft)] px-3 py-1.5 text-[12px] text-[var(--pink-deep)]">{done}</p>
      )}

      {sources.length > 0 && (
        <div className="mb-3">
          <span className="eyebrow mb-1 block">找到这些（点一下就预览，不读内容）</span>
          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li key={s.path} className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-[var(--text)]">{s.name}</p>
                  <p className="truncate text-[11px] text-[var(--text-3)]">{s.folder} · {fmtSize(s.size)}</p>
                </div>
                <button className="btn ghost sm shrink-0" disabled={!!busy}
                  onClick={() => void preview({ source: s.path }, s.name)}>预览</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stats && (
        <div className="mb-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--text-2)]">
          <b className="text-[var(--text)]">{filename}</b>：解析出 {stats.rows} 行
          （有假名 {stats.with_reading}，有释义 {stats.with_meaning}）
          {stats.header_found
            ? <> · 表头认出来了：{Object.entries(stats.header).map(([k, v]) => `${k}=第${v + 1}列`).join('、')}</>
            : <> · <span className="text-[var(--pink-deep)]">没看出表头，列是按顺序猜的</span> ——
                不对的话在下面直接把内容改掉，或者删掉这几行</>}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <span className="eyebrow">收下这 {rows.length} 行</span>
            <button className="btn sm" disabled={busy === 'commit'} onClick={() => void commit()}>
              {busy === 'commit' ? '写入中…' : '✅ 确认导入'}
            </button>
            <button className="btn ghost sm" onClick={() => { setRows([]); setStats(null) }}>取消</button>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-[var(--surface)] text-left text-[11px] text-[var(--text-3)]">
                <tr>
                  <th className="p-1">词形</th><th className="p-1">假名</th><th className="p-1">释义</th>
                  <th className="p-1">词性</th><th className="p-1">级别</th><th className="p-1">标签</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    {(['term', 'reading', 'meaning', 'pos'] as const).map((field) => (
                      <td key={field} className="p-1">
                        <input className="input !py-1 !text-[12px]" value={r[field]}
                          onChange={(e) => editRow(i, { [field]: e.target.value })} />
                      </td>
                    ))}
                    <td className="p-1">
                      <select className="input !py-1 !text-[12px]" value={r.level}
                        onChange={(e) => editRow(i, { level: e.target.value })}>
                        {LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
                      </select>
                    </td>
                    <td className="p-1">
                      <input className="input !py-1 !text-[12px]" value={r.tags}
                        onChange={(e) => editRow(i, { tags: e.target.value })} />
                    </td>
                    <td className="p-1">
                      <button className="text-[11px] text-[var(--text-3)] underline" onClick={() => dropRow(i)}>去掉</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── 成绩：记分 + 让小糖人写分析 ──

function ScoresTab({ roster, onChanged }: { roster: Roster[]; onChanged: () => void }) {
  const [scores, setScores] = useState<JpScore[]>([])
  const [overview, setOverview] = useState<JpScoreOverview | null>(null)
  const [analysis, setAnalysis] = useState('')
  const [analysisId, setAnalysisId] = useState<number | null>(null)
  const [charId, setCharId] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({
    taken_on: new Date().toISOString().slice(0, 10),
    name: '', kind: 'mock', level: 'N5', section: 'total', score: '', full: '', note: '',
  })

  const activeChar = charId || roster[0]?.id || ''
  const activeName = roster.find((c) => c.id === activeChar)?.name ?? '小糖人'

  const load = useCallback(async () => {
    setErr('')
    try {
      const got = await fetchJpScores()
      setScores(got.scores); setOverview(got.overview)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  const add = async () => {
    setBusy('add'); setErr('')
    try {
      if (!form.taken_on) throw new Error('要有日期')
      await addJpScore({
        ...form,
        score: form.score === '' ? null : Number(form.score),
        full: form.full === '' ? null : Number(form.full),
      })
      setForm({ ...form, name: '', score: '', full: '', note: '' })
      setAdding(false)
      await load(); onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const analyze = (sid: number, force = false) => {
    void (async () => {
      setBusy(force ? 'force' : 'analyze'); setErr('')
      try {
        const got = await analyzeJpScores(sid, { characterId: activeChar, force })
        setAnalysis(got.analysis); setAnalysisId(sid)
        await load()
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
      finally { setBusy('') }
    })()
  }

  const remove = async (s: JpScore) => {
    if (!window.confirm(`删掉 ${s.taken_on} 这条 ${SECTION_LABEL[s.section] ?? s.section} 成绩？`)) return
    try { await deleteJpScore(s.id); await load(); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn sm" onClick={() => setAdding((v) => !v)}>
          {adding ? '收起' : '＋ 记一条成绩'}
        </button>
        <RosterPicker roster={roster} value={activeChar} onChange={setCharId} />
      </div>

      {adding && (
        <div className="mb-3 grid gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3 sm:grid-cols-4">
          <label className="block">
            <span className="eyebrow">哪天</span>
            <input type="date" className="input mt-1" value={form.taken_on}
              onChange={(e) => setForm({ ...form, taken_on: e.target.value })} />
          </label>
          <label className="block">
            <span className="eyebrow">哪场</span>
            <input className="input mt-1" placeholder="JLPT N4 / 校内模考" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="block">
            <span className="eyebrow">级别</span>
            <select className="input mt-1" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
              {LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow">哪一项</span>
            <select className="input mt-1" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}>
              {Object.entries(SECTION_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="eyebrow">得分</span>
            <input className="input mt-1" inputMode="decimal" placeholder="90" value={form.score}
              onChange={(e) => setForm({ ...form, score: e.target.value })} />
          </label>
          <label className="block">
            <span className="eyebrow">满分</span>
            <input className="input mt-1" inputMode="decimal" placeholder="120" value={form.full}
              onChange={(e) => setForm({ ...form, full: e.target.value })} />
          </label>
          <label className="block sm:col-span-2">
            <span className="eyebrow">这次哪里崩了（自己记一句）</span>
            <input className="input mt-1" placeholder="听力走神 / 单词记不住" value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <button className="btn sm sm:col-span-4" disabled={busy === 'add'} onClick={() => void add()}>
            {busy === 'add' ? '存…' : '记下来'}
          </button>
          <p className="text-[11px] text-[var(--text-3)] sm:col-span-4">
            一场考试的各单项各记一条（总分 + 词汇 + 听力…），分析才看得出是哪块拖后腿。
          </p>
        </div>
      )}

      <Err text={err} />

      {/* 走势：只摆事实，解读交给小糖人 */}
      {overview && overview.exams.length > 0 && (
        <div className="mb-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="eyebrow">走势（事实）</span>
            {overview.weak.length > 0 && (
              <span className="text-[11px] text-[var(--pink-deep)]">
                最近一次不到七成：{overview.weak.map((w) => `${SECTION_LABEL[w.section] ?? w.section} ${Math.round(w.rate * 100)}%`).join('、')}
              </span>
            )}
          </div>
          <div className="space-y-1">
            {overview.exams.slice(-6).map((ex) => (
              <div key={`${ex.taken_on}|${ex.name}`} className="text-[12px] text-[var(--text-2)]">
                <b className="text-[var(--text)]">{ex.taken_on}</b>
                <span className="ml-2">{ex.name || '（没写名字）'}{ex.level ? ` · ${ex.level}` : ''}</span>
                <span className="ml-2 text-[var(--text-3)]">
                  {Object.entries(ex.sections).map(([sec, got]) =>
                    `${SECTION_LABEL[sec] ?? sec} ${got.score ?? '-'}${got.full ? `/${got.full}` : ''}`).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 她写的分析 */}
      <div className="mb-3 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="eyebrow">让小糖人写分析</span>
          {scores.length > 0 && (
            <button className="btn ghost sm" disabled={!!busy} onClick={() => {
              // 写在这个人身上：优先他刚看过的那条，否则拿最新一条（分析存那条上）。
              const target = analysisId ?? scores[0].id
              analyze(target, !!analysisId)
            }}>
              {busy === 'force' ? '重写中…' : analysisId ? '✍️ 重写一份' : '✍️ 写一份'}
            </button>
          )}
        </div>
        <p className="mb-2 text-[11px] text-[var(--text-3)]">
          她会先看走势、再点出最弱的一块、最后给你一个今天就能做的练法。
          （也可以在某条成绩后面点「让她分析」，那份会存下来，下次直接读。）
        </p>
        {analysis ? (
          <div className="whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px] leading-relaxed text-[var(--text)]">
            <b className="text-[var(--pink-deep)]">{activeName}：</b>
            {analysis}
          </div>
        ) : (
          <p className="text-[12px] text-[var(--text-3)]">还没写过 —— 先记两条成绩，她才有东西看。</p>
        )}
      </div>

      {/* 记录明细 */}
      {scores.length === 0 ? (
        <p className="text-[13px] text-[var(--text-3)]">还没记过成绩。</p>
      ) : (
        <ul className="space-y-1.5">
          {scores.map((s) => (
            <li key={s.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <b className="text-[var(--text)]">{s.taken_on}</b>
                <span className="text-[var(--text-2)]">{s.name || '（没写名字）'}</span>
                <span className="chip">{SECTION_LABEL[s.section] ?? s.section}</span>
                <span className="text-[var(--text)]">{s.score ?? '-'}{s.full ? ` / ${s.full}` : ''}</span>
                {s.note && <span className="text-[11px] text-[var(--text-3)]">{s.note}</span>}
                <button className="ml-auto text-[11px] underline text-[var(--text-2)]" disabled={!!busy}
                  onClick={() => analyze(s.id)}>
                  {s.analysis ? '看分析' : `让${activeName}分析`}
                </button>
                <button className="text-[11px] underline text-[var(--text-3)]" onClick={() => void remove(s)}>删</button>
              </div>
              {analysisId === s.id && analysis && (
                <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-2)]">{analysis}</p>
              )}
              {s.analysis && analysisId !== s.id && (
                <p className="mt-1 line-clamp-2 text-[11px] text-[var(--text-3)]">{s.analysis}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── 主面板 ──

// ── 语法卡（新标日 初级 / 中级 / 高级）──
//
// 「快速学语法 + 练句子」那条线。一个语法点 = 一张卡：
//   ① 让她讲（三口气：说什么 / 怎么用 / 什么坑）—— 讲完写回卡片，下次打开直接看
//   ② 出练习（造句为主，选择题容易蒙对）
//   ③ **自己造一句让她批** —— 这一步才是「会用了」，也是学语法最值钱的环节
//   ④ 四档复习，间隔比单词拉得长（语法会用了不容易忘，忘了就是真没懂）
//
// 顺序**跟着教材**：初上 → 初下 → 中上 → 中下 → 高上 → 高下。第 14 课之前不考て形，
// 第 41 课之前不考被动 —— 这是大纲里写死的规矩，也是「跟着课本学」的意义。

const BOOKS = ['初级上', '初级下', '中级上', '中级下', '高级上', '高级下']

// ── 大纲（📖）──
//
// 和姐妹项目（english-study 的语法面板）一个套路：按章折叠，章头写「学会了几个 / 一共几个」。
// 区别在于那边的知识点树是 `data/grammar_outline.json`，这边是**人写的 `语法大纲.md`** ——
// 所以这儿只负责**摊开看**，不记「学到哪」（记了也是第二个进度，会和卡片的 SRS 打架）。
//
// 「学会了几个」是**库里现有卡片**算的（`counts`），不是大纲自己的数 ——
// 卡片没建之前那一栏就显示「还没建」，一眼能看出「大纲有、库里没有」。

function OutlineNodeRow({ node }: { node: JpOutlineNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5">
      <p className="text-[13px] leading-snug text-[var(--text)]">{node.point}</p>
      {node.tags && <p className="mt-px text-[11.5px] text-[var(--text-3)]">{node.tags}</p>}
    </div>
  )
}

function OutlineTab({ revision, onChanged }: { revision: number; onChanged: () => void }) {
  const [tree, setTree] = useState<JpGrammarOutlineTree | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try { setTree(await fetchJpGrammarOutlineTree()) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  // 复习那边改了卡（讲过了 / 换了册）就跟着重拉一次 —— 「学会了几个」是库里算的。
  useEffect(() => { void load() }, [load, revision])

  const doImport = async () => {
    setImporting(true); setErr(''); setNote('')
    try {
      const got = await importJpGrammarOutline()
      setNote(`大纲 ${got.total_in_outline} 张 —— 新加 ${got.created} 张，更新 ${got.updated} 张。`)
      onChanged()
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setImporting(false) }
  }

  if (loading && !tree) return <p className="text-[13px] text-[var(--text-3)]">翻大纲中…</p>
  if (!tree) return <Err text={err || '读不到大纲（语法大纲.md）'} />

  const made = tree.counts.by_book

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-[var(--text-2)]">
        这是《新标日》六册的**知识目录**（大纲 = 内容的唯一真相源，写在功能目录的
        <code className="mx-1">语法大纲.md</code>里）—— 按 <b>册 → 单元 → 课 → 语法点</b> 摊开，
        一路看到 N1。顺序就是教材顺序：第 14 课之前不考て形、第 41 课之前不考被动。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button className={`form-chip ${!loading ? 'on' : ''}`} onClick={() => void load()}>
          🔄 重新翻一遍
        </button>
        <button className="btn ghost sm" disabled={importing} onClick={() => void doImport()}>
          {importing ? '导入中…' : '📥 按大纲生成卡片'}
        </button>
        <span className="text-[11px] text-[var(--text-3)]">
          大纲 {tree.total} 张 · 库里 {tree.counts.total} 张（点了才会建卡，建完讲解现讲）
        </span>
      </div>

      <Err text={err} />
      {note && (
        <p className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-[12px] leading-relaxed text-[var(--text-2)]">
          {note}
        </p>
      )}

      {tree.books.map((book) => {
        const got = made[book.book] ?? 0
        return (
          <details key={book.book}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <summary className="cursor-pointer text-[14px] font-bold text-[var(--text)]">
              {book.book}
              <span className="ml-2 text-[11px] font-normal text-[var(--text-3)]">
                {book.count} 个语法点 · {book.units.length} 个单元
                {got ? `　已建卡 ${got} 张` : '　还没建卡'}
              </span>
            </summary>

            <div className="mt-2 space-y-2">
              {book.units.map((unit) => (
                <details key={unit.unit}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5">
                  <summary className="cursor-pointer text-[13px] font-bold text-[var(--text-2)]">
                    {unit.unit ? `第 ${unit.unit} 单元` : '（没分单元）'}
                    <span className="ml-2 text-[11px] font-normal text-[var(--text-3)]">
                      {unit.lessons.length} 课 · {unit.count} 个语法点
                    </span>
                  </summary>

                  <div className="mt-2 space-y-2">
                    {unit.lessons.map((lesson) => (
                      <div key={`${unit.unit}-${lesson.lesson}`}>
                        <p className="mb-1 text-[12.5px] font-bold text-[var(--pink-deep)]">
                          {lesson.lesson ? `第 ${lesson.lesson} 课` : '单元块'}
                          {lesson.title && <span className="ml-1.5 font-normal text-[var(--text-2)]">{lesson.title}</span>}
                          <span className="ml-1.5 font-normal text-[var(--text-3)]">
                            {lesson.nodes.length} 个点
                          </span>
                        </p>
                        <div className="space-y-1">
                          {lesson.nodes.map((node) => (
                            <OutlineNodeRow key={node.point} node={node} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </details>
        )
      })}
    </div>
  )
}

function GrammarTab({ roster, coachOn, onChanged, counts }: {
  roster: Roster[]; coachOn: boolean; onChanged: () => void; counts: JpGrammarCounts | null
}) {
  const [cards, setCards] = useState<JpGrammar[]>([])
  const [index, setIndex] = useState(0)
  const [books, setBooks] = useState<string[]>([])
  const [dueOnly, setDueOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [who, setWho] = useState('')
  const [explain, setExplain] = useState<{ meaning?: string; usage?: string; pitfall?: string } | null>(null)
  const [drills, setDrills] = useState<{ q: string; hint: string; answer: string }[]>([])
  const [shown, setShown] = useState<Record<number, boolean>>({})
  const [sentence, setSentence] = useState('')
  const [verdict, setVerdict] = useState('')
  const [lastGrade, setLastGrade] = useState('')
  const [importing, setImporting] = useState(false)

  const load = useCallback(async (bookList: string[], due: boolean) => {
    setLoading(true); setErr('')
    try {
      const got = await fetchJpGrammar({
        book: bookList.join(','), due, order: due ? 'due' : 'lesson', limit: 500,
      })
      setCards(got.grammar); setIndex(0)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(books, dueOnly) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // 换卡就把上一张的讲解 / 练习 / 批语清干净 —— 别让上一张的内容挂在下一张卡上。
  const current = cards[index]
  useEffect(() => {
    setExplain(null); setDrills([]); setSentence(''); setVerdict(''); setErr('')
    setShown({})
  }, [current?.id])

  const toggleBook = (b: string) => {
    const next = books.includes(b) ? books.filter((x) => x !== b) : [...books, b]
    const safe = next.length ? next : [b]
    setBooks(safe)
    void load(safe, dueOnly)
  }

  /** 库里还没语法卡时：先看一眼大纲有多少张，再导。**两步都不写库**（第二步才写）。 */
  const doImport = async () => {
    setImporting(true); setErr(''); setNote('')
    try {
      const peek = await fetchJpGrammarOutline()
      const got = await importJpGrammarOutline()
      setNote(`大纲里 ${peek.total} 张卡（${Object.entries(got.counts.by_book)
        .map(([b, c]) => `${b} ${c}`).join(' · ')}）—— 新加 ${got.created} 张，更新 ${got.updated} 张。`)
      onChanged()
      await load(books, dueOnly)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setImporting(false) }
  }

  const doExplain = async () => {
    if (!current) return
    setBusy('explain'); setErr('')
    try {
      const got = await explainJpGrammar(current.id, who)
      setExplain(got.explain)
      // 她说完就写回库了 —— 本地这份也跟着补上，不用重拉。
      setCards((list) => list.map((c) => (c.id === current.id ? { ...c, ...got.explain } : c)))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const doDrills = async () => {
    if (!current) return
    setBusy('drills'); setErr('')
    try {
      const got = await draftJpGrammarDrills(current.id, who, 3)
      setDrills(got.drafts)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const doCheck = async () => {
    if (!current || !sentence.trim()) return
    setBusy('check'); setErr(''); setVerdict('')
    try {
      const got = await checkJpSentence(current.id, sentence.trim(), who)
      setVerdict(got.answer)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const grade = async (g: JpGrade) => {
    if (!current) return
    setBusy(g); setErr('')
    try {
      const got = await gradeJpGrammar(current.id, g)
      setLastGrade(`${current.point} → ${dueText(got.due)}`)
      setIndex((i) => i + 1)
      onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  // 讲解三段：库里存了的直接显示，没存的才要她现场讲。
  const shownExplain = {
    meaning: current?.meaning || explain?.meaning || '',
    usage: current?.usage || explain?.usage || '',
    pitfall: current?.pitfall || explain?.pitfall || '',
  }
  const hasExplain = !!(shownExplain.meaning || shownExplain.usage || shownExplain.pitfall)

  // 卡片被讲过 / 复习过之后要通知外面刷新（「学会了几个」是库里算的），
  // 但那两件事都不改卡片**列表** —— 列表没变就不该带动下面那整棵大纲重拉。
  const revision = useMemo(
    () => cards.reduce((sum, c) => sum + c.reps + (c.meaning ? 1 : 0), 0),
    [cards],
  )

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="eyebrow">学哪几册</span>
        <span className="text-[11px] text-[var(--text-3)]">（不点 = 六册全看；顺序就是教材顺序）</span>
        {BOOKS.map((b) => (
          <button key={b} type="button" className={`form-chip ${books.includes(b) ? 'on' : ''}`}
            onClick={() => toggleBook(b)}>{b}</button>
        ))}
        <button className={`form-chip ${dueOnly ? 'on' : ''}`}
          onClick={() => { setDueOnly((v) => !v); void load(books, !dueOnly) }}>
          只看该复习的
        </button>
        <button className="btn ghost sm" onClick={() => void load(books, dueOnly)}>🔄 刷新</button>
        <button className="btn ghost sm" disabled={importing} onClick={() => void doImport()}>
          {importing ? '导入中…' : '📥 按大纲生成卡片'}
        </button>
      </div>

      <Err text={err} />
      {note && (
        <p className="mb-2 rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-[12px] leading-relaxed text-[var(--text-2)]">
          {note}
        </p>
      )}

      {loading ? (
        <p className="text-[13px] text-[var(--text-3)]">翻库中…</p>
      ) : !current ? (
        <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-6 text-center">
          <p className="text-[15px] font-bold">
            {counts?.total ? '这一轮过完了 🎉' : '还没有语法卡'}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-2)]">
            {counts?.total
              ? `库里一共 ${counts.total} 张语法卡，这会儿没到期的了（或者这一册被你滤掉了）。`
              : '大纲（语法大纲.md）已经把新标日六册的语法点整理成目录了 —— 点上面「📥 按大纲生成卡片」照着建，建完讲解现讲、练习现出。'}
          </p>
          {!counts?.total && (
            <button className="btn sm mt-3" disabled={importing} onClick={() => void doImport()}>
              {importing ? '导入中…' : '📥 按大纲生成卡片'}
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-3)]">
            <span>
              第 {index + 1} / {cards.length} 张 · 该看：{dueText(current.due)}
              {current.reps > 0 && ` · 已复习 ${current.reps} 次`}
            </span>
            {lastGrade && <span>上一张：{lastGrade}</span>}
          </div>

          {/* 卡头：教材位置 + 语法点 */}
          <div className="mb-3">
            <p className="text-[11px] text-[var(--text-3)]">
              {current.book}{current.lesson ? ` · 第${current.lesson}课` : ''}
              {current.title ? `　${current.title}` : ''}
              {current.level ? ` · ${current.level}` : ''}
            </p>
            <p className="mt-1 text-[22px] font-extrabold leading-snug tracking-wide">{current.point}</p>
            {current.tags && <p className="mt-0.5 text-[11px] text-[var(--text-3)]">📌 {current.tags}</p>}
          </div>

          {/* 讲解：说什么 / 怎么用 / 什么坑 */}
          {hasExplain ? (
            <div className="space-y-2">
              {([['meaning', '说什么'], ['usage', '怎么用'], ['pitfall', '什么坑']] as const).map(([k, label]) => (
                shownExplain[k] ? (
                  <div key={k} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                    <p className="mb-0.5 text-[11px] font-bold text-[var(--pink-deep)]">{label}</p>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{shownExplain[k]}</p>
                  </div>
                ) : null
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-[var(--text-3)]">
              这张卡还没讲解 —— 让她分三口气讲一遍（说什么 / 怎么用 / 什么坑），讲完就存在卡上了。
            </p>
          )}

          {coachOn && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className="btn sm" disabled={!!busy} onClick={() => void doExplain()}>
                {busy === 'explain' ? '她正在想…' : hasExplain ? '🔁 让她重讲一遍' : '💬 让她讲这条'}
              </button>
              <button className="btn ghost sm" disabled={!!busy} onClick={() => void doDrills()}>
                {busy === 'drills' ? '出题中…' : '✏️ 出几道练习'}
              </button>
              <RosterPicker roster={roster} value={who} onChange={setWho} />
            </div>
          )}

          {/* 她出的练习：先自己做，答案点开才看（选择题蒙对了不算数） */}
          {drills.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="eyebrow">练习（先自己写，再看答案）</p>
              {drills.map((d, i) => (
                <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  <p className="text-[13px] leading-relaxed">{i + 1}. {d.q}</p>
                  {d.hint && <p className="mt-0.5 text-[11px] text-[var(--text-3)]">提示：{d.hint}</p>}
                  <button className="mt-1 text-[11px] underline text-[var(--text-2)]"
                    onClick={() => setShown((s) => ({ ...s, [i]: !s[i] }))}>
                    {shown[i] ? '收起答案' : '看答案'}
                  </button>
                  {shown[i] && d.answer && (
                    <p className="mt-1 text-[13px] text-[var(--pink-deep)]">{d.answer}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 造句：学语法最值钱的一步 —— 自己造一句她批 */}
          {coachOn && (
            <div className="mt-3 rounded-xl border border-[var(--pink)] bg-[var(--surface)] px-3 py-2">
              <p className="mb-1 text-[12px] font-bold text-[var(--pink-deep)]">自己用这条语法造一句，让她批</p>
              <div className="flex gap-2">
                <input className="input min-w-0 flex-1" value={sentence} placeholder="用这条语法写一句日文…"
                  onChange={(e) => setSentence(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doCheck() }} />
                <button className="btn sm" disabled={!!busy || !sentence.trim()} onClick={() => void doCheck()}>
                  {busy === 'check' ? '批改中…' : '让她批'}
                </button>
              </div>
              {verdict && (
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">{verdict}</p>
              )}
            </div>
          )}

          {/* 追问：讲完这条语法还有没弄明白的，就在这儿接着问 —— 和词卡那块是同一个盒子。
              换一张卡时 key 会变，追问不会串到下一张卡上（`current.id` 做 key）。
              coachOn 关着时整块不出现（连外面这层边框也不留个空壳）。 */}
          {coachOn && (
            <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <FollowUpBox key={current.id} roster={roster} coachOn={coachOn} compact
                context={[current.point, current.title, current.meaning].filter(Boolean).join(' / ')} />
            </div>
          )}

          {/* 四档复习：和单词同一套手感，但间隔拉得更长 */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {GRADES.map((g) => (
              <button key={g.id} className={`btn sm ${g.id === 'good' ? '' : 'ghost'}`}
                disabled={!!busy} onClick={() => void grade(g.id)}>
                {busy === g.id ? '…' : g.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-center text-[11px] text-[var(--text-3)]">
            「会用了」再点记住 / 太简单 —— 语法卡的间隔比单词长（记住了起步 3 天）
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button className="btn ghost sm" disabled={index <= 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}>← 上一张</button>
            <button className="btn ghost sm" onClick={() => setIndex((i) => i + 1)}>
              先跳过这张 →
            </button>
          </div>
        </div>
      )}

      {/* 大纲（📖）—— 摊开看「六册要学什么」。大纲是**内容源**（`语法大纲.md`），
          卡片只是照它建的；所以这儿只看看，改内容去改那份 md。 */}
      {cards.length > 0 && (
        <section className="mt-6 border-t border-[var(--border)] pt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="eyebrow">📖 大纲</span>
            <span className="text-[11px] text-[var(--text-3)]">
              《新标日》六册的知识目录 —— 册 → 单元 → 课 → 语法点，一路看到 N1
            </span>
          </div>
          <OutlineTab revision={revision} onChanged={onChanged} />
        </section>
      )}
    </div>
  )
}

export default function JapaneseLabPanel() {
  const [tab, setTab] = useState<Tab>('review')
  const [counts, setCounts] = useState<JpCounts | null>(null)
  /** 语法卡单独一份计数 —— 语法那一栏的「还剩几张」用它，不和单词混着算。 */
  const [grammarCounts, setGrammarCounts] = useState<JpGrammarCounts | null>(null)
  const [progress, setProgress] = useState<JpProgress | null>(null)
  const [roster, setRoster] = useState<Roster[]>([])
  const [brainOk, setBrainOk] = useState(false)
  const [down, setDown] = useState('')
  const [tick, setTick] = useState(0)
  /** 后台正在把它拉起来（没用 ref，因为要在界面上显示「正在拉起来…」）。 */
  const [booting, setBooting] = useState(false)
  // 小窝设置（§9.6.5）：学哪几级 / 每天几个新词 / 要不要让她讲词。开面板时从服务端读一次。
  const [coachOn, setCoachOn] = useState(true)
  const [startLevels, setStartLevels] = useState<string[]>(['N5'])
  const [dailyNew, setDailyNew] = useState(10)
  /** 「自动拉起服务」这件事最多做一次（见 autoStart）；手动刷新会把闸放开重来。 */
  const autoStarted = useRef(false)

  // 点「刷新 / 再试一次」= 重新走一遍（顺便把「自动拉起只做一次」的闸放开 —— 上次没起来，
  // 手动再点一下就该真的再拉一次，不是又白等一遍）。
  const refresh = useCallback(() => {
    autoStarted.current = false
    setTick((v) => v + 1)
  }, [])

  // ── 服务没起？面板自己按注册表把它拉起来 ────────────────────────────────
  // 以前是「自己跑去下面『🚀 让功能跑起来』点一下」—— 用户说这不该是他干的活。
  // 前端能做的只有两件**白名单内**的事：查运行状态、按注册表声明的子命令名启动。
  // 命令串（python -m jplab serve --port 8765 …）完全由后端注册表拼，前端碰不到（§9.6 安全边界）。

  const autoStart = useCallback(async () => {
    // 立刻切到「正在拉起来…」—— 别先闪一帧「没连上」再变，看着像出错。
    setBooting(true)
    // 先问小窝后端：它在跑吗？问不到（后端自己没起）就别白等 —— 前端什么也拉不起来。
    const status = await fetchNestRunStatus('japanese_lab').catch(() => null)
    if (!status) { setBooting(false); return }
    try {
      // 已经在跑就别再起一个（后端对重复启动会 409）；端口可能还在起来，等一下也还是要的。
      if (!status.running) {
        // 注册表里 serve 是 background: True —— 后端立刻回 pid，不阻塞。
        await runNestFeature('japanese_lab', { command: 'serve' }).catch(() => {})
      }
      // 端口起来还要一两秒：等一会儿再重试健康检查，别立刻又报「没连上」。
      await new Promise((r) => setTimeout(r, 1800))
    } finally {
      setBooting(false)
    }
  }, [])

  // 加载一遍：健康检查 → 进度 / 配置。失败就抛，交给下面那个 effect 决定怎么报。
  const load = useCallback(async () => {
    const health = await fetchJpLabHealth()
    setCounts(health.counts); setBrainOk(health.brain); setDown('')
    setCoachOn(health.coach_enabled ?? true)
    setStartLevels(health.levels?.length ? health.levels : ['N5'])
    setDailyNew(health.daily_new ?? 10)
    const [prog, cfg] = await Promise.all([fetchJpProgress(), fetchJpLabConfig()])
    setProgress(prog); setCounts(prog.counts); setRoster(cfg.characters ?? [])
    // 语法计数两份来源都兜着：老服务只回 health 那份，新服务 progress 里也有。
    setGrammarCounts(prog.grammar?.counts ?? health.grammar_counts ?? null)
  }, [])

  // 服务没起 → **自己拉一次**，拉起来就正常加载；拉完还起不来才报「没连上」。
  useEffect(() => {
    void (async () => {
      try {
        await load()
      } catch (e) {
        // 先把提示挂上 —— 拉起期间那块地方显示「正在拉起来…」，而不是闪一下「库是空的」这种像出错的空态。
        setDown(e instanceof Error ? e.message : String(e))
        if (autoStarted.current) return
        autoStarted.current = true
        await autoStart()
        // 拉起来之后再试一次；还不行就把刚才那句提示留着（说明自动拉没成功）。
        try {
          await load()
        } catch {
          /* 提示已经在上面了 */
        }
      }
    })()
  }, [tick, load, autoStart])

  const exportAll = async () => {
    try {
      const got = await exportJpLab()
      const blob = new Blob([got.json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `jplab-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setDown(e instanceof Error ? e.message : String(e))
    }
  }

  const header = useMemo(() => {
    const bits: string[] = []
    if (counts) bits.push(`词 ${counts.total}`, `今天该看 ${counts.due}`, `学过 ${counts.learned}`)
    if (progress?.streak) bits.push(`连刷 ${progress.streak} 天`)
    return bits.join(' · ')
  }, [counts, progress])

  return (
    <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[20px] font-extrabold tracking-wide">🌸 小糖人日语实验室</h2>
        <span className="text-[11px] text-[var(--text-3)]">独立项目 features/japanese-lab · 数据只在你自己机器上</span>
      </div>

      {down ? (
        <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-5">
          <p className="text-[14px] font-bold text-[var(--pink-deep)]">
            {booting ? '正在把实验室拉起来…' : '实验室没连上'}
          </p>
          {booting ? (
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-2)]">
              刚点开这块就已经替你起了 —— 服务起来要一两秒，稍等一下。
            </p>
          ) : (
            <>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-2)]">{down}</p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-3)]">
                点开这块面板时**已经自动帮你起过一次**了，还连不上就是它起不来（缺依赖 / 端口被占 /
                Python 环境不对）。去本页下面「🛠 设置与工具 → 🚀 让功能跑起来」选中「小糖人日语实验室」，
                那儿能看启动日志、也能手动「打开实验室（常驻）」。
                学习数据存在它自己的 <code>data/jplab.db</code> 里，和家里的库分开放。
              </p>
              <button className="btn ghost sm mt-3" onClick={refresh}>再试一次</button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-2)]">
            <span>{header || '库是空的'}</span>
            <span className={brainOk ? 'text-[var(--mint)]' : 'text-[var(--pink-deep)]'}>
              {brainOk ? '· 大脑通了' : '· 大脑还没配好（讲词 / 分析会退回规则版）'}
            </span>
            {!coachOn && <span className="text-[var(--text-3)]">· 讲词 / 答疑已在设置里关掉</span>}
            <button className="btn ghost sm ml-auto" onClick={refresh}>刷新</button>
            <button className="btn ghost sm" onClick={() => void exportAll()}>导出全部（JSON）</button>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button key={t.id} type="button" className={`form-chip ${tab === t.id ? 'on' : ''}`}
                onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {tab === 'review' && (
            <ReviewTab roster={roster} coachOn={coachOn} onChanged={refresh} counts={counts}
              startLevels={startLevels} dailyNew={dailyNew} />
          )}
          {tab === 'words' && <WordsTab roster={roster} coachOn={coachOn} onChanged={refresh} counts={counts} />}
          {tab === 'grammar' && (
            <GrammarTab roster={roster} coachOn={coachOn} onChanged={refresh} counts={grammarCounts} />
          )}
          {tab === 'import' && <ImportTab onDone={refresh} defaultLevel={startLevels[0] ?? 'N5'} />}
          {tab === 'scores' && <ScoresTab roster={roster} onChanged={refresh} />}
          {tab === 'notes' && <NotesTab roster={roster} coachOn={coachOn} />}

          {!brainOk && (
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-3)]">
              大脑没配好时：背词、导入、记成绩照常（这些都不过大脑）；「讲词 / 答疑 / 让她写分析」会失败或退回规则版。
              去上面的「🧠 小窝大脑 API」里给全局默认填一份就够了。
            </p>
          )}
        </>
      )}

      {/* ---- 自己的设置（Block 二 ②）----
          以前这些开关跟别的功能挤在「🛠 设置与工具 → ⚙ 功能开关」里一起列，得在那排 chip 里挑；
          现在跟着日语实验室待在同一个面板 —— 学什么 / 谁陪你 / 成绩 / 导入都在这里改，不用重启。 */}
      <div className="mt-4 border-t border-[var(--border)] pt-3">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <span className="text-[14px] font-bold text-[var(--text)]">⚙ 日语实验室的设置</span>
          <span className="text-[11px] text-[var(--text-3)]">
            学哪几级 / 每天几个 / 谁来陪你 / 成绩分析 / 导入目录 —— 改完下一轮就用上
          </span>
        </div>
        <NestSettingsPanel onlyId="japanese_lab" bare />
      </div>
    </div>
  )
}