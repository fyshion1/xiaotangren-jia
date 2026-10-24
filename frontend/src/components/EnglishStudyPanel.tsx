// 糖人小窝 · 英语学习面板（feature `english_study`）。
//
// ⚠ 这个功能是**独立项目**（注册表里 folder='english-study'，2026-10-16 从本体内搬出来的），
// 和隔壁日语实验室是姐妹项目：各一套词库、各一个端口（英语 8766）。面板的请求全打到
// `/english/api/…`，由 Vite 代理转发过去 —— 见 `vite.config.ts` 里那条 `/english` 规则。
//
// **点卡片就直接开**：服务没起时面板自己按注册表把它拉起来（见下面的 autoStart），
// 不用先跑去「🚀 让功能跑起来」点一下 —— 那是用户明确说过不该他干的活。
//
// 五件事，对应当初提的几条：
//   ① 导入旧单词表   → 「词表」页右上「导入旧词表」：先试读（看它把哪列认成了什么），认对了再导
//   ② 例句 + 插图    → 每个词的详情卡里：让小糖人写例句 / 自己写 / 上传插图 / 生成插图；
//                      不懂的语法就在下面那个问句框里问她（带上下文，她会讲给你听）
//   ③ 成绩与薄弱点   → 「分析」页：易忘词 / 拖后腿的分类 / 慢反应 + 逐日曲线 + 成绩记录
//   ④ 复习           → 首页队列，**伪随机顺序**，三档作答（认识/模糊/忘了）直接改复习间隔
//   ⑤ 语法           → 「语法」页：英语兔讲解的目录树（勾进度）+ 中译英/填空/改写/造句，
//                      **出题和批改都交给 AI**，不懂的点直接问她
//
// 仍然复用**本体**的已有能力（都在 8000 那个服务上，不是这个功能的）：
// 发音走 /api/voice/tts（edge 晓晓），插图走 /api/images/generate，
// 例句的附件也落在附件库（`english-vocab` 目录）—— 都不另起一套（§9.6.4）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addVocabExample, addVocabExam, askVocabQuestion, createVocabWord, deleteVocabExample,
  deleteVocabNote, deleteVocabWord, deleteVocabExam, explainGrammarNode, fetchGrammarTree,
  fetchVocabAnalysis, fetchVocabHealth, fetchVocabNotes, fetchVocabOverview, fetchVocabQueue,
  fetchVocabWord, fetchVocabWords, generateVocabExamples,
  gradeGrammarAnswer, importVocabFile, makeGrammarExercise, patchGrammarNode, patchVocabWord,
  reviewVocabWord, summarizeAsk,
  type GrammarExercise, type GrammarGrade, type GrammarKind, type GrammarNode, type GrammarTree,
  type ImportResult, type VocabAnalysis, type VocabExam, type VocabExample, type VocabNote,
  type VocabOverview, type VocabQuestion, type VocabWord,
} from '../api/english'
import { fetchCharacters, fetchNestRunStatus, runNestFeature } from '../api/client'
import { generateImages } from '../api/imagegen'
import { buildAppearancePrompt } from '../lib/comfyPrompt'
import { uploadAttachmentsBatch } from '../api/storage'
import type { CharacterProfile } from '../data/characters'
import NestSettingsPanel from './NestSettingsPanel'

type Tab = 'review' | 'words' | 'grammar' | 'analysis'

const TABS: { id: Tab; label: string }[] = [
  { id: 'review', label: '🔁 复习' },
  { id: 'words', label: '📚 词表' },
  { id: 'grammar', label: '📐 语法' },
  { id: 'analysis', label: '📊 分析' },
]

const STAGE_LABEL = ['新词', '认识', '模糊', '熟练']
const STAGE_CLASS = ['', 'text-[var(--sky)]', 'text-[var(--pink-deep)]', 'text-[var(--mint)]']

/** 一屏放多少个。复习和词表都是这个数 —— 50 个够背一轮，页面也不至于太长。 */
const QUEUE_SIZE = 50

/** 到期日 → 「今天 / 明天 / 3 天后 / 9月1日」这种人话。 */
function dueText(due: string): string {
  if (!due) return ''
  const t = Date.parse(due.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return due.slice(0, 10)
  const days = Math.round((t - Date.now()) / 86400000)
  if (days <= 0) return '今天该复习'
  if (days === 1) return '明天'
  if (days < 30) return `${days} 天后`
  return `${new Date(t).getMonth() + 1}月${new Date(t).getDate()}日`
}

// ── 发音（复用聊天页那条 TTS 口子，音色沿用用户的偏好：edge 晓晓）──

function useSpeak() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [speaking, setSpeaking] = useState('')
  const [err, setErr] = useState('')

  const stop = useCallback(() => {
    const a = audioRef.current
    if (a) {
      a.pause()
      a.onended = null
      a.onerror = null
      try { a.src = '' } catch { /* ignore */ }
      audioRef.current = null
    }
    setSpeaking('')
  }, [])

  const speak = useCallback(async (text: string, key: string) => {
    const t = (text || '').trim()
    if (!t) return
    if (speaking === key) { stop(); return }
    stop()
    setSpeaking(key)
    setErr('')
    try {
      const resp = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural' }),
      })
      if (!resp.ok) {
        const d = await resp.json().catch(() => null)
        setErr(d?.detail ?? `TTS HTTP ${resp.status}`)
        setSpeaking('')
        return
      }
      const url = URL.createObjectURL(await resp.blob())
      const a = new Audio(url)
      const done = () => { URL.revokeObjectURL(url); audioRef.current = null; setSpeaking('') }
      a.onended = done
      a.onerror = done
      audioRef.current = a
      await a.play().catch((e) => { setErr(`播放失败：${e?.message ?? e}`); done() })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSpeaking('')
    }
  }, [speaking, stop])

  return { speak, stop, speaking, err }
}

// ── 单词详情（例句 / 插图 / 问她）──

/** 这个面板里要用到的例句和问答。列表接口不带这两样（几十张卡全带上太重），
 *  是展开某张卡时单独拉的 —— 所以「写完例句看不见」这种毛病要么出在这里没拉到，
 *  要么出在拉完没往详情里灌。 */
type WordDetailData = { examples: VocabExample[]; questions: VocabQuestion[] }

function WordDetail({
  word, characters, refreshKey, onChanged, onClose,
}: {
  word: VocabWord
  characters: CharacterProfile[]
  /** 外面数据变一次就加一 —— 详情里跟着重拉。 */
  refreshKey: number
  onChanged: () => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [translation, setTranslation] = useState('')
  const [question, setQuestion] = useState('')
  // 让她写例句 / 问她 都默认用名册第一位；用户点过就在这次展开里记住。
  const [charId, setCharId] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [answers, setAnswers] = useState<{ q: string; a: string; who: string }[]>([])
  const [note, setNote] = useState(word.note)
  // 这张卡自己的例句 / 问答 / 笔记。**不信外面传来的 `word`** —— 那是个快照，
  // 写完例句它不会变（老版本的「点了没反应」就是这么来的）。改了就在这儿重拉。
  const [data, setData] = useState<WordDetailData>({ examples: [], questions: [] })
  // 追问串：第一问开一串，后面几问共用这个 id，服务端才会把前几轮拼进上下文。
  const [convId, setConvId] = useState('')
  const [notes, setNotes] = useState<VocabNote[]>([])
  const [showNotes, setShowNotes] = useState(false)
  const speak = useSpeak()
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setNote(word.note) }, [word.id, word.note])

  // 打开 / 换词 / 外面说「数据变了」时，重拉这一份。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const full = await fetchVocabWord(word.id)
        if (!alive) return
        const qs = full.questions ?? []
        setData({ examples: full.examples ?? [], questions: qs })
        // 老问答没有 conversation_id（单发时代的）；再接就是新的一串。
        const head = qs.find((q) => q.conversation_id)
        setConvId(head?.conversation_id ?? '')
      } catch { /* 拉不到就空着，写例句照样能用 */ }
    })()
    return () => { alive = false }
  }, [word.id, refreshKey])

  // 这个词存过的笔记。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const got = await fetchVocabNotes(word.id)
        if (alive) setNotes(got.items)
      } catch { /* 笔记拉不到不影响别的 */ }
    })()
    return () => { alive = false }
  }, [word.id, refreshKey])

  // 派生出来的当前角色：用户没点过就用名册第一位。不 setState，免得渲染里改状态。
  const activeChar = charId || characters[0]?.id || ''
  const activeName = characters.find((c) => c.id === activeChar)?.name ?? '小糖人'
  // 这一串追问的轮次（老的单发问答不算进来，免得总结时把陈年旧账一起炒了）。
  const convAsks = data.questions.filter((q) => q.conversation_id && q.conversation_id === convId)

  const reload = async () => {
    const full = await fetchVocabWord(word.id)
    const qs = full.questions ?? []
    setData({ examples: full.examples ?? [], questions: qs })
  }

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag)
    setErr('')
    try { await fn(); await reload(); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const genExamples = () => run('gen', async () => {
    if (!activeChar) throw new Error('还没有小糖人可写例句 —— 先去介绍页建一位')
    await generateVocabExamples(word.id, activeChar, 3)
  })

  const saveExample = () => run('ex', async () => {
    if (!text.trim()) throw new Error('例句不能空着')
    await addVocabExample(word.id, { text, translation, source: 'manual' })
    setText(''); setTranslation('')
  })

  const uploadImage = (file: File) => run('img', async () => {
    const batch = await uploadAttachmentsBatch('english-vocab', [file])
    const first = batch.saved[0]
    if (!first) throw new Error(batch.errors[0]?.error ?? '上传失败')
    await attachImage(first.orig, first.thumb)
  })

  // 插图挂到「最后一条例句」上；一条例句都没有就先建一条空例句来挂图。
  // 上传和生成共用这段 —— 免得两条路径挂图的行为不一样。
  const attachImage = (orig: string, thumb: string) => {
    const last = data.examples[data.examples.length - 1]
    return addVocabExample(word.id, last
      ? { text: last.text, translation: last.translation, image: orig, image_thumb: thumb }
      : { text: '', image: orig, image_thumb: thumb })
  }

  // 生成插图：拿她的外貌词条 + 这条例句当场景，画一张这张词卡的图。
  // 用哪张图看「模型设置 §7」里选的引擎 —— 引擎没配好后端会点名缺什么，原话透出来。
  const genImage = () => run('genimg', async () => {
    const profile = characters.find((c) => c.id === activeChar)
    if (!profile) throw new Error('还没有小糖人 —— 先去介绍页建一位，再让她画插图')
    const scene = data.examples[data.examples.length - 1]?.text?.trim()
    const prompt = [
      buildAppearancePrompt(profile),
      scene ? `场景：${scene}` : `围绕「${word.word}」的一个日常场景`,
      '单词卡插图，柔和暖色，画面干净',
    ].filter(Boolean).join('，')
    const imgs = await generateImages({ prompt, session_id: 'english-vocab', n: 1 })
    const first = imgs[0]
    if (!first) throw new Error('生图返回为空，请检查后端生图引擎配置')
    await attachImage(first.orig, first.thumb)
  })

  // 问她 / 追问：同一串共用 `convId`，服务端会把前几轮带上，她就不会车轱辘话。
  // **第一问的串号在前端生成** —— 服务端只认「你给的这一串」，它自己不会新造一个，
  // 所以等它回一个串号是等不到的（老写法就是空着回来，追问也就接不上了）。
  const ask = () => run('ask', async () => {
    const q = question.trim()
    if (!q) throw new Error('先写要问什么')
    const thread = convId || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const saved = await askVocabQuestion(word.id, q, activeChar, thread)
    if (!convId) setConvId(thread)
    setAnswers((list) => [{ q, a: saved.answer, who: saved.character_name }, ...list])
    setQuestion('')
  })

  // 把这串追问总结成一条能复习的笔记存下来。
  const summarize = () => run('sum', async () => {
    if (!convAsks.length && !data.questions.length) throw new Error('还没有问过她，没东西可总结')
    const ids = convAsks.length
      ? convAsks.map((q) => q.id)
      : data.questions.map((q) => q.id)
    const saved = await summarizeAsk(word.id, { questionIds: ids, characterId: activeChar })
    setNotes((list) => [saved, ...list])
  })

  return (
    <div className="mt-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-4">
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <b className="text-[20px] text-[var(--text)]">{word.word}</b>
            {word.phonetic && <span className="text-[13px] text-[var(--text-3)]">{word.phonetic}</span>}
            <button className="btn ghost sm" onClick={() => void speak.speak(word.word, word.id)}>
              {speak.speaking === word.id ? '⏹ 停' : '🔊 读音'}
            </button>
          </div>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">
            {word.pos && <span className="chip">{word.pos}</span>}
            {word.meaning || <span className="text-[var(--text-3)]">（还没填释义）</span>}
          </p>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">
            {word.tag || '未分类'} · {STAGE_LABEL[word.stage] ?? '新词'} · 下次 {dueText(word.due_at)} ·
            学过 {word.reps} 次 / 忘过 {word.lapses} 次
          </p>
        </div>
        <button className="btn ghost sm shrink-0" onClick={onClose}>收起</button>
      </div>

      {err && <p className="mb-2 rounded-lg bg-[var(--pink-soft)] px-3 py-1.5 text-[12px] text-[var(--pink-deep)]">{err}</p>}
      {speak.err && <p className="mb-2 text-[12px] text-[var(--pink-deep)]">{speak.err}</p>}

      {/* 例句 + 插图 */}
      <div className="mb-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="eyebrow">例句与插图</span>
          <button className="btn ghost sm" disabled={!!busy} onClick={() => void genExamples()}>
            {busy === 'gen' ? '她正在写…' : `✍️ 让${activeName}写例句`}
          </button>
          <button className="btn ghost sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy === 'img' ? '上传中…' : '🖼 上传插图'}
          </button>
          <button className="btn ghost sm" disabled={!!busy} onClick={() => void genImage()}>
            {busy === 'genimg' ? '画着呢…' : `🎨 让${activeName}画插图`}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadImage(f) }} />
        </div>

        {data.examples.length === 0 ? (
          <p className="text-[12px] text-[var(--text-3)]">
            还没有例句。让她写几句 —— 她会用自己的日常造句，比课本例句好记。
          </p>
        ) : (
          <ul className="space-y-2">
            {data.examples.map((ex) => (
              <li key={ex.id} className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                {ex.image_thumb || ex.image ? (
                  <img src={ex.image_thumb || ex.image} alt="" loading="lazy"
                    className="h-20 w-20 shrink-0 rounded-lg object-cover" />
                ) : null}
                <div className="min-w-0 flex-1">
                  {ex.text && <p className="text-[14px] leading-relaxed text-[var(--text)]">{ex.text}</p>}
                  {ex.translation && <p className="text-[12px] text-[var(--text-2)]">{ex.translation}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-3)]">
                    {ex.speaker ? (
                      <span className="chip">{characters.find((c) => c.id === ex.speaker)?.name ?? ex.speaker} 写的</span>
                    ) : ex.source === 'manual' ? <span>自己写的</span> : null}
                    {ex.text && (
                      <button className="underline" onClick={() => void speak.speak(ex.text, ex.id)}>
                        {speak.speaking === ex.id ? '停止' : '读一遍'}
                      </button>
                    )}
                    <button className="underline" disabled={!!busy}
                      onClick={() => void run('del', async () => { await deleteVocabExample(ex.id) })}>删</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* 自己写一条 */}
        <div className="mt-2 space-y-1.5">
          <input className="input" placeholder="自己写一条例句…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <input className="input" placeholder="中文翻译（可空）" value={translation} onChange={(e) => setTranslation(e.target.value)} />
            <button className="btn sm shrink-0" disabled={!!busy || !text.trim()} onClick={() => void saveExample()}>加例句</button>
          </div>
        </div>
      </div>

      {/* 问她 */}
      <div className="mb-3">
        <span className="eyebrow mb-1 block">不懂就问她（语法 / 用法 / 辨析都行）</span>
        <div className="flex gap-2">
          <input className="input" placeholder={`比如：这个词和另外一个有什么区别？`}
            value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void ask() }} />
          <button className="btn sm shrink-0" disabled={!!busy || !question.trim()} onClick={() => void ask()}>
            {busy === 'ask' ? '她在想…' : '问她'}
          </button>
        </div>
        {characters.length > 1 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {characters.map((c) => (
              <button key={c.id} className={`form-chip ${activeChar === c.id ? 'on' : ''}`}
                onClick={() => setCharId(c.id)}>{c.name}</button>
            ))}
          </div>
        )}
        {answers.map((a, i) => (
          <div key={i} className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-[12px] text-[var(--text-3)]">你问：{a.q}</p>
            <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--text)]">
              <b className="text-[var(--pink-deep)]">{a.who}：</b>{a.a}
            </p>
          </div>
        ))}
        {data.questions.length > 0 && answers.length === 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] text-[var(--text-3)]">
              以前问过 {data.questions.length} 次
            </summary>
            <div className="mt-1.5 space-y-2">
              {data.questions.map((q) => (
                <div key={q.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                  <p className="text-[12px] text-[var(--text-3)]">你问：{q.question}</p>
                  <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--text)]">{q.answer}</p>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* 追问 + 总结存档 */}
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
          {convAsks.length > 0 && (
            <span className="text-[11px] text-[var(--text-3)]">这一串已经聊了 {convAsks.length} 轮</span>
          )}
          <button className="btn ghost sm" disabled={!!busy || !data.questions.length}
            onClick={() => void summarize()}>
            {busy === 'sum' ? '整理着呢…' : '📝 总结这串问答存成笔记'}
          </button>
          {convId && (
            <button className="text-[11px] text-[var(--text-3)] underline" disabled={!!busy}
              onClick={() => setConvId('')}>开新的一串</button>
          )}
        </div>
      </div>

      {/* 存下来的笔记 */}
      {notes.length > 0 && (
        <div className="mb-3">
          <button className="eyebrow mb-1 flex items-center gap-1" onClick={() => setShowNotes((v) => !v)}>
            📝 我问出来的笔记（{notes.length}）{showNotes ? '▾' : '▸'}
          </button>
          {showNotes && (
            <div className="space-y-2">
              {notes.map((n) => (
                <div key={n.id} className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] p-3">
                  <div className="flex items-start gap-2">
                    <b className="min-w-0 flex-1 text-[13px] text-[var(--text)]">{n.title}</b>
                    <button className="shrink-0 text-[11px] text-[var(--text-3)] underline" disabled={!!busy}
                      onClick={() => void run('delnote', async () => {
                        if (!window.confirm(`删掉笔记「${n.title}」？`)) return
                        await deleteVocabNote(n.id)
                        setNotes((list) => list.filter((x) => x.id !== n.id))
                      })}>删</button>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-[var(--text-2)]">{n.body}</p>
                  <p className="mt-1 text-[11px] text-[var(--text-3)]">
                    {(n.created_at || '').slice(0, 10)}{n.turns ? ` · 从 ${n.turns} 轮问答里总结的` : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 备注 + 手改释义 */}
      <div>
        <span className="eyebrow mb-1 block">我自己的备注</span>
        <textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="记点自己容易错的地方…"
          onBlur={() => { if (note !== word.note) void run('note', async () => { await patchVocabWord(word.id, { note }) }) }} />
      </div>

      {/* 删掉这个词。作答历史留着 —— 整理词表不该把成绩曲线弄断。 */}
      <div className="mt-3 border-t border-[var(--border)] pt-2 text-right">
        <button className="text-[11px] text-[var(--text-3)] underline" disabled={!!busy}
          onClick={() => {
            if (!window.confirm(`确定把「${word.word}」从词库里删掉？它的例句和问题也一起删，作答历史留着。`)) return
            void run('delword', async () => {
              await deleteVocabWord(word.id)
              onClose()
            })
          }}>
          从词库里删掉这个词
        </button>
      </div>
    </div>
  )
}

// ── 词条卡（复习队列 / 词表共用）──

function WordCard({
  word, characters, expanded, onToggleDetail, onReviewed, onChanged,
}: {
  word: VocabWord
  characters: CharacterProfile[]
  expanded: boolean
  onToggleDetail: () => void
  onReviewed: (r: 'known' | 'fuzzy' | 'forgot', elapsedMs: number) => void
  onChanged: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  // 详情里改完东西（写例句 / 问完 / 删笔记）就让详情重拉一次 —— 外面这张卡也跟着刷新。
  const [tick, setTick] = useState(0)
  const speak = useSpeak()
  // 这一张卡从出现到现在花了多久 —— 作答复盘时一起报上去，用来找「认得但不熟」的词。
  const shownAt = useRef(Date.now())

  useEffect(() => { shownAt.current = Date.now(); setRevealed(false) }, [word.id])

  const changed = useCallback(() => { setTick((t) => t + 1); onChanged() }, [onChanged])

  const answer = (r: 'known' | 'fuzzy' | 'forgot') => {
    onReviewed(r, Date.now() - shownAt.current)
    speak.stop()
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <b className="text-[18px] text-[var(--text)]">{word.word}</b>
            {word.phonetic && <span className="text-[12px] text-[var(--text-3)]">{word.phonetic}</span>}
            <button className="text-[13px]" title="读音" onClick={() => void speak.speak(word.word, word.id)}>
              {speak.speaking === word.id ? '⏹' : '🔊'}
            </button>
            {word.tag && <span className="chip">{word.tag}</span>}
          </div>

          {revealed || expanded ? (
            <div className="mt-1.5">
              <p className="text-[14px] text-[var(--text-2)]">
                {word.pos && <span className="mr-1 font-semibold text-[var(--pink-deep)]">{word.pos}</span>}
                {word.meaning || <span className="text-[var(--text-3)]">（还没填释义）</span>}
              </p>
              {word.note && <p className="mt-1 text-[12px] text-[var(--text-3)]">备注：{word.note}</p>}
              {(word.examples ?? []).length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {(word.examples ?? []).slice(0, 2).map((ex) => (
                    <li key={ex.id} className="flex gap-2">
                      {ex.image_thumb && <img src={ex.image_thumb} alt="" className="h-10 w-10 rounded object-cover" />}
                      <div className="min-w-0">
                        <p className="text-[13px] text-[var(--text)]">{ex.text}</p>
                        {ex.translation && <p className="text-[11px] text-[var(--text-3)]">{ex.translation}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <button className="mt-2 text-[12px] text-[var(--text-3)] underline" onClick={() => setRevealed(true)}>
              想不起来？点一下看释义
            </button>
          )}
        </div>
        <button className="btn ghost sm shrink-0" onClick={onToggleDetail}>
          {expanded ? '收起' : '例句/问她'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn sm" onClick={() => answer('known')}>✓ 认识</button>
        <button className="btn ghost sm" onClick={() => answer('fuzzy')}>～ 模糊</button>
        <button className="btn ghost sm" onClick={() => answer('forgot')}>✗ 忘了</button>
        <span className="ml-auto text-[11px] text-[var(--text-3)]">
          <span className={STAGE_CLASS[word.stage] ?? ''}>{STAGE_LABEL[word.stage] ?? '新词'}</span> · 下次 {dueText(word.due_at)}
        </span>
      </div>

      {expanded && (
        <WordDetail word={word} characters={characters} refreshKey={tick} onChanged={changed} onClose={onToggleDetail} />
      )}
    </div>
  )
}

// ── 导入旧词表 ──

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')

  const pick = async (f: File) => {
    setFile(f); setPreview(null); setErr(''); setNote('')
    setBusy(true)
    try { setPreview(await importVocabFile(f, { tag, dryRun: true })) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const commit = async (cols?: Partial<Record<'word' | 'meaning' | 'pos' | 'phonetic' | 'tag', number>>) => {
    if (!file) return
    setBusy(true); setErr(''); setNote('')
    try {
      const r = await importVocabFile(file, { tag, dryRun: false, columns: cols })
      setNote(`导完了：新增 ${r.created ?? 0} 个词，补全 ${r.filled ?? 0} 个，跳过 ${r.skipped} 行。词库现在共 ${r.total_now ?? '?'} 个词。`)
      setPreview(r)
      onDone()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const colName = (idx: number) => (idx < 0 ? '（没认出来）' : `第 ${idx + 1} 列`)

  return (
    <div className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-[14px]">导入旧词表</b>
        <span className="text-[12px] text-[var(--text-3)]">xlsx / csv / txt 都行；先试读，认对列了再导</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".xlsx,.xlsm,.csv,.txt" className="input max-w-[280px]"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f) }} />
        <input className="input max-w-[180px]" placeholder="归到哪一类（如 四级）" value={tag}
          onChange={(e) => setTag(e.target.value)} />
      </div>

      {busy && <p className="mt-2 text-[12px] text-[var(--text-3)]">读表中…</p>}
      {err && <p className="mt-2 rounded-lg bg-[var(--pink-soft)] px-3 py-1.5 text-[12px] text-[var(--pink-deep)]">{err}</p>}
      {note && <p className="mt-2 rounded-lg bg-[color-mix(in_srgb,var(--mint)_18%,var(--surface))] px-3 py-1.5 text-[12px]">{note}</p>}

      {preview && (
        <div className="mt-3 space-y-2">
          <p className="text-[12px] text-[var(--text-2)]">
            {preview.columns.format === 'xlsx' ? 'Excel' : preview.columns.format.toUpperCase()} ·
            {preview.columns.has_header ? ' 认出了表头' : ' 没有表头（按内容猜的列）'} ·
            读进来 <b>{preview.parsed}</b> 行，跳过 {preview.skipped} 行
          </p>
          <p className="text-[12px] text-[var(--text-3)]">
            单词 = {colName(preview.columns.word)} ·
            释义 = {colName(preview.columns.meaning)} ·
            词性 = {colName(preview.columns.pos)} ·
            音标 = {colName(preview.columns.phonetic)}
          </p>

          {preview.sample.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full text-[12px]">
                <thead className="bg-[var(--surface-2)] text-[var(--text-3)]">
                  <tr><th className="px-2 py-1 text-left">单词</th><th className="px-2 py-1 text-left">词性</th>
                    <th className="px-2 py-1 text-left">释义</th><th className="px-2 py-1 text-left">音标</th></tr>
                </thead>
                <tbody>
                  {preview.sample.map((s, i) => (
                    <tr key={i} className="border-t border-[var(--border)]">
                      <td className="px-2 py-1 font-semibold">{s.word}</td>
                      <td className="px-2 py-1 text-[var(--text-2)]">{s.pos}</td>
                      <td className="px-2 py-1">{s.meaning}</td>
                      <td className="px-2 py-1 text-[var(--text-3)]">{s.phonetic}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.skipped_sample.length > 0 && (
            <p className="text-[11px] text-[var(--text-3)]">
              跳过的行（不像英文单词）：{preview.skipped_sample.join('、')}
            </p>
          )}

          {!preview.dry_run ? (
            <p className="text-[12px] text-[var(--text-2)]">
              已入库：新增 {preview.created ?? 0} · 补全 {preview.filled ?? 0}。
              同一张表再导一次不会重复（已存在的词只补空字段，不覆盖你改过的释义）。
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn sm" disabled={busy} onClick={() => void commit()}>看着对，导入</button>
              <button className="btn ghost sm" disabled={busy}
                onClick={() => void commit({ word: 0, meaning: preview.columns.meaning, pos: preview.columns.pos, phonetic: preview.columns.phonetic })}>
                第一列就是单词（按这个导）
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 语法：目录树 + 练习（第二期）──
//
// 本面板只维护学习大纲和练习，不保存课程原始讲解：
//   · 把大纲渲染成能勾进度的目录（学会了 / 在学 / 没开始 + 自己写备注当照片索引）
//   · 挑一个点，AI 现出一道题 → 你写 → AI 批改（对 / 半对 / 错 + 错在哪 + 更好的说法）
//   · 不懂的点直接问她（走人格那条路，和词卡的「答疑」同一个做法）

const NODE_STATUS: { id: GrammarNode['status']; label: string }[] = [
  { id: 'todo', label: '没开始' },
  { id: 'doing', label: '在学' },
  { id: 'done', label: '学会了' },
]

const KINDS: { id: GrammarKind; label: string; hint: string }[] = [
  { id: 'translate', label: '中译英', hint: '给你一句中文，你写英文' },
  { id: 'blank', label: '填空', hint: '挖掉关键成分，你填' },
  { id: 'rewrite', label: '改写', hint: '按这个语法点改写一句话' },
  { id: 'make', label: '造句', hint: '给你几个词，自己造一句' },
]

const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  right: { label: '✓ 全对', cls: 'text-[var(--mint)]' },
  half: { label: '～ 基本对', cls: 'text-[var(--pink-deep)]' },
  wrong: { label: '✗ 语法点用错了', cls: 'text-[var(--pink-deep)]' },
}

/** 一个没在我们的设置里登记的 status（理论上不会）就当成「没开始」。 */
function cleanStatus(value: string): GrammarNode['status'] {
  return value === 'doing' || value === 'done' ? value : 'todo'
}

function GrammarPanel({ tree, onRefresh }: { tree: GrammarTree | null; onRefresh: () => void }) {
  const nodes = tree?.nodes ?? []
  const stats = tree?.stats
  const [openNode, setOpenNode] = useState('')
  const [status, setStatus] = useState<GrammarNode['status']>('todo')
  const [note, setNote] = useState('')
  const [kind, setKind] = useState<GrammarKind>('translate')
  const [ex, setEx] = useState<GrammarExercise | null>(null)
  const [answer, setAnswer] = useState('')
  const [grade, setGrade] = useState<GrammarGrade | null>(null)
  const [asked, setAsked] = useState<{ q: string; a: string }[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const open = (node: GrammarNode) => {
    if (node.is_chapter) return
    if (openNode === node.id) { setOpenNode(''); return }
    setOpenNode(node.id); setStatus(cleanStatus(node.status)); setNote(node.my_note)
    setEx(null); setGrade(null); setAnswer(''); setQuestion(''); setAsked([]); setErr('')
  }

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag); setErr('')
    try { await fn() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy('') }
  }

  const saveMark = () => run('mark', async () => {
    await patchGrammarNode(openNode, { status, note })
    onRefresh()
  })

  const makeOne = () => run('make', async () => {
    setGrade(null); setAnswer('')
    setEx(await makeGrammarExercise({ node_id: openNode, kind }))
  })

  const sendAnswer = () => run('grade', async () => {
    if (!answer.trim()) throw new Error('先写点什么再交 —— 写错也算数')
    if (!ex) throw new Error('先出一道题')
    const got = await gradeGrammarAnswer({
      node_id: openNode, kind: ex.kind, prompt: ex.prompt, answer, node_title: ex.node_title,
    })
    setGrade(got)
    onRefresh()
  })

  const ask = () => run('ask', async () => {
    const q = question.trim()
    const saved = await explainGrammarNode({ node_id: openNode, question: q })
    setAsked((list) => [{ q: q || `讲讲「${saved.node_title}」`, a: saved.answer }, ...list])
    setQuestion('')
  })

  // 大纲按章分组 —— 161 个节点平铺会淹掉人。
  const chapters = useMemo(() => {
    const out: { title: string; items: GrammarNode[] }[] = []
    for (const n of nodes) {
      if (n.is_chapter) { out.push({ title: n.title, items: [] }); continue }
      if (out.length) out[out.length - 1].items.push(n)
    }
    return out
  }, [nodes])

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[var(--text-3)]">
        这是英语兔讲解的<b>骨架</b>（讲解正文是照片，自己跟着看）—— 这儿管三件事：记你学到哪、
        挑个点出题练、不懂的当场问她。练过的题都交给 AI 批改，错在哪会说出来。
      </p>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { k: '大纲知识点', v: stats?.total_nodes ?? 0, hint: '个' },
          { k: '学会了', v: stats?.done_of ?? 0, hint: `在学 ${stats?.doing_nodes ?? 0}` },
          { k: '练过', v: stats?.practiced ?? 0, hint: '次' },
          { k: '全对率', v: stats?.practiced ? `${Math.round((stats.accuracy ?? 0) * 100)}%` : '—', hint: '批改结果' },
        ].map((c) => (
          <div key={c.k} className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
            <div className="text-[11px] text-[var(--text-3)]">{c.k}</div>
            <div className="text-[22px] font-extrabold leading-tight text-[var(--text)]">{c.v}</div>
            <div className="text-[11px] text-[var(--text-3)]">{c.hint}</div>
          </div>
        ))}
      </div>

      {err && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {err}<button className="ml-2 underline" onClick={() => setErr('')}>知道了</button>
        </div>
      )}

      <div className="space-y-2">
        {chapters.map((ch) => (
          <details key={ch.title} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <summary className="cursor-pointer text-[14px] font-bold text-[var(--text)]">
              {ch.title}
              <span className="ml-2 text-[11px] font-normal text-[var(--text-3)]">
                {ch.items.filter((n) => n.status === 'done').length} / {ch.items.length} 学会了
              </span>
            </summary>
            <div className="mt-2 space-y-1.5">
              {ch.items.map((n) => (
                <div key={n.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
                  <button className="flex w-full items-baseline gap-2 text-left" onClick={() => open(n)}>
                    <span className={`text-[13px] ${n.status === 'done' ? 'text-[var(--mint)]'
                      : n.status === 'doing' ? 'text-[var(--pink-deep)]' : 'text-[var(--text-2)]'}`}>
                      {n.status === 'done' ? '✓' : n.status === 'doing' ? '◐' : '○'}
                    </span>
                    <span className="min-w-0 flex-1 text-[13.5px] text-[var(--text)]">{n.title}</span>
                    {n.parent && <span className="shrink-0 text-[11px] text-[var(--text-3)]">{n.parent}</span>}
                  </button>
                  {n.note && <p className="mt-1 pl-5 text-[11.5px] text-[var(--text-3)]">{n.note}</p>}

                  {openNode === n.id && (
                    <div className="mt-2.5 border-t border-[var(--border)] pt-2.5">
                      {/* 进度 + 自己的备注（照片索引 / 视频号都写这儿） */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {NODE_STATUS.map((s) => (
                          <button key={s.id} className={`form-chip ${status === s.id ? 'on' : ''}`}
                            onClick={() => setStatus(s.id)}>{s.label}</button>
                        ))}
                        <input className="input ml-auto max-w-[240px]" placeholder="备注：照片在哪 / 看到第几集…"
                          value={note} onChange={(e) => setNote(e.target.value)} />
                        <button className="btn sm" disabled={busy === 'mark'} onClick={() => void saveMark()}>
                          {busy === 'mark' ? '记着…' : '记下'}
                        </button>
                      </div>

                      {/* 练一练 */}
                      <div className="mt-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12px] text-[var(--text-3)]">练一句：</span>
                          {KINDS.map((k) => (
                            <button key={k.id} title={k.hint}
                              className={`form-chip ${kind === k.id ? 'on' : ''}`}
                              onClick={() => setKind(k.id)}>{k.label}</button>
                          ))}
                          <button className="btn sm ml-auto" disabled={busy === 'make'}
                            onClick={() => void makeOne()}>
                            {busy === 'make' ? '出题中…' : ex ? '换一题' : '出题'}
                          </button>
                        </div>

                        {ex && (
                          <div className="mt-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] p-3">
                            <p className="text-[13.5px] text-[var(--text)]">{ex.prompt}</p>
                            {ex.hint && <p className="mt-1 text-[11.5px] text-[var(--text-3)]">提示：{ex.hint}</p>}
                            <textarea className="input mt-2 h-[70px] w-full" placeholder="在这儿写你的答案…"
                              value={answer} onChange={(e) => setAnswer(e.target.value)} />
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <button className="btn sm" disabled={busy === 'grade'} onClick={() => void sendAnswer()}>
                                {busy === 'grade' ? '批改中…' : '交给小糖人批改'}
                              </button>
                              {!grade && ex.reference && (
                                <details className="text-[11.5px] text-[var(--text-3)]">
                                  <summary className="cursor-pointer">先看看参考答案</summary>
                                  <span className="text-[var(--text-2)]">{ex.reference}</span>
                                </details>
                              )}
                            </div>

                            {grade && (
                              <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                                <div className={`text-[13px] font-bold ${VERDICT_STYLE[grade.verdict]?.cls ?? ''}`}>
                                  {VERDICT_STYLE[grade.verdict]?.label ?? grade.verdict}
                                </div>
                                {grade.comment && (
                                  <p className="mt-1 whitespace-pre-wrap text-[13px] text-[var(--text-2)]">{grade.comment}</p>
                                )}
                                {grade.errors.length > 0 && (
                                  <ul className="mt-2 space-y-1">
                                    {grade.errors.map((e, i) => (
                                      <li key={i} className="text-[12.5px] text-[var(--text-2)]">
                                        <s className="text-[var(--pink-deep)]">{e.wrong}</s>
                                        {' → '}<b className="text-[var(--mint)]">{e.right}</b>
                                        {e.why && <span className="ml-1 text-[11.5px] text-[var(--text-3)]">（{e.why}）</span>}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {grade.better && (
                                  <p className="mt-2 text-[12.5px] text-[var(--text-2)]">
                                    更好的说法：<span className="text-[var(--text)]">{grade.better}</span>
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 不懂就问她 */}
                      <div className="mt-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input className="input min-w-0 flex-1" placeholder={`就「${n.title}」问她 —— 为什么 / 和另一个的区别…`}
                            value={question} onChange={(e) => setQuestion(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void ask() }} />
                          <button className="btn ghost sm" disabled={busy === 'ask'} onClick={() => void ask()}>
                            {busy === 'ask' ? '她想着…' : '问她'}
                          </button>
                        </div>
                        {asked.length > 0 && (
                          <ul className="mt-2 space-y-2">
                            {asked.map((it, i) => (
                              <li key={i} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5">
                                <p className="text-[12px] text-[var(--text-3)]">你问：{it.q}</p>
                                <p className="mt-1 whitespace-pre-wrap text-[13px] text-[var(--text-2)]">{it.a}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

// ── 主面板 ──

export default function EnglishStudyPanel() {
  const [tab, setTab] = useState<Tab>('review')
  const [overview, setOverview] = useState<VocabOverview | null>(null)
  const [characters, setCharacters] = useState<CharacterProfile[]>([])
  const [queue, setQueue] = useState<VocabWord[]>([])
  const [words, setWords] = useState<VocabWord[]>([])
  const [wordsTotal, setWordsTotal] = useState(0)
  const [filterTag, setFilterTag] = useState('')
  const [keyword, setKeyword] = useState('')
  const [order, setOrder] = useState<'due' | 'new' | 'alpha' | 'recent'>('due')
  const [expanded, setExpanded] = useState('')
  const [analysis, setAnalysis] = useState<VocabAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [newWord, setNewWord] = useState({ word: '', meaning: '', tag: '' })
  const [exam, setExam] = useState({ kind: 'cet4', title: '', score: '', max_score: '710' })
  // 这一轮还剩多少（后端算好给的）。0 = 这一副牌翻完了，该重洗了。
  const [queueRemaining, setQueueRemaining] = useState(0)
  // 翻到第几屏（纯显示用）。
  const [queueScreen, setQueueScreen] = useState(1)

  // 这一轮的「牌面」和记号（全在浏览器这侧，后端不知道谁点过什么）──
  // seed 决定伪随机顺序：同一轮里翻页都用它，顺序固定、不重样；重洗时才换新的。
  const seedRef = useRef('')
  const seenRef = useRef<Set<string>>(new Set())     // 这个会话出过的（不管答没答）
  const knownRef = useRef<Set<string>>(new Set())    // 点了「认识」的 → 不再出
  const redrillRef = useRef<Set<string>>(new Set())  // 点了「模糊/忘了」的 → 插回队首再看
  const newSeed = () => `r${Math.random().toString(36).slice(2, 10)}`

  /** 服务没起时，正在按注册表把它拉起来（界面上显示「正在拉起来…」而不是「没连上」）。 */
  const [booting, setBooting] = useState(false)
  /** 服务确实连不上时的原话（自动拉起也没成功才留着）—— 空 = 正常。 */
  const [down, setDown] = useState('')
  // 语法页：目录树 + 自己的进度（勾了哪些学会了）+ 正在出的那道题。
  const [grammar, setGrammar] = useState<GrammarTree | null>(null)
  const [grammarErr, setGrammarErr] = useState('')
  const [grammarBusy, setGrammarBusy] = useState(false)
  /** 换一个值就重新拉一次目录树（勾进度 / 批改完都要刷新）。 */
  const [grammarTick, setGrammarTick] = useState(0)
  /** 「自动拉起服务」这件事最多做一次（见 autoStart）；手动刷新会把闸放开重来。 */
  const autoStarted = useRef(false)

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  // ── 服务没起？面板自己按注册表把它拉起来 ────────────────────────────────
  // 以前要自己跑去「🚀 让功能跑起来」点一下 —— 用户说这不该是他干的活（日语那边同一套做法）。
  // 前端能做的只有两件**白名单内**的事：查运行状态、按注册表声明的子命令名启动。
  // 命令串（python -m english serve --port 8766 …）完全由后端注册表拼，前端碰不到（§9.6 安全边界）。
  const autoStart = useCallback(async () => {
    // 立刻切到「正在拉起来…」—— 别先闪一帧「没连上」再变，看着像出错。
    setBooting(true)
    // 先问小窝后端：它在跑吗？问不到（后端自己没起）就别白等 —— 前端什么也拉不起来。
    const status = await fetchNestRunStatus('english_study').catch(() => null)
    if (!status) { setBooting(false); return }
    try {
      // 已经在跑就别再起一个（后端对重复启动会 409）；端口可能还在起来，等一下也还是要的。
      if (!status.running) {
        // 注册表里 serve 是 background: True —— 后端立刻回 pid，不阻塞。
        await runNestFeature('english_study', { command: 'serve' }).catch(() => {})
      }
      // 端口起来还要一两秒：等一会儿再重试健康检查，别立刻又报「没连上」。
      await new Promise((r) => setTimeout(r, 1800))
    } finally {
      setBooting(false)
    }
  }, [])

  const loadOverview = useCallback(async () => {
    try { setOverview(await fetchVocabOverview()) } catch { setOverview(null) }
  }, [])

  /** 服务到底活着没 —— 活着就顺手把概览也拉了。返回 false 表示真连不上。 */
  const probe = useCallback(async (): Promise<boolean> => {
    try {
      await fetchVocabHealth()
      setDown('')
      await loadOverview()
      return true
    } catch (e) {
      setDown(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [loadOverview])

  // 开面板：先探一次；探不到就**自己拉一次**，拉起来再探；还不行才把提示留着。
  useEffect(() => {
    void (async () => {
      if (await probe()) return
      if (autoStarted.current) return
      autoStarted.current = true
      await autoStart()
      await probe()
    })()
  }, [probe, autoStart])

  /** 手动「再试一次」：把自动拉起那个闸放开，重走一遍（上次没起来，这次该真的再拉一次）。 */
  const retry = useCallback(() => {
    autoStarted.current = false
    void (async () => {
      if (await probe()) return
      autoStarted.current = true
      await autoStart()
      await probe()
    })()
  }, [probe, autoStart])

  const loadQueue = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetchVocabQueue({
        limit: QUEUE_SIZE, tag: filterTag || undefined, seed: seedRef.current,
        seen: [...seenRef.current], known: [...knownRef.current], redrill: [...redrillRef.current],
      })
      // 取回来就算「出过」了 —— 就算他一个没答，换一轮也不该再看到这一屏。
      for (const w of r.items) seenRef.current.add(w.id)
      setQueue(r.items)
      setQueueRemaining(r.remaining)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [filterTag])

  const loadWords = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetchVocabWords({ tag: filterTag || undefined, keyword, order, limit: 50 })
      setWords(r.items); setWordsTotal(r.total)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [filterTag, keyword, order])

  const loadAnalysis = useCallback(async () => {
    setBusy(true)
    try { setAnalysis(await fetchVocabAnalysis(30, 12)) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { void fetchCharacters().then(setCharacters).catch(() => setCharacters([])) }, [])
  useEffect(() => {
    // 进复习页（含换分类）→ 换一副新牌重开一轮，把上一轮的记号也清掉。
    if (tab !== 'review') return
    seedRef.current = newSeed()
    seenRef.current = new Set(); knownRef.current = new Set(); redrillRef.current = new Set()
    setQueueScreen(1)
    void loadQueue()
  }, [tab, loadQueue])
  useEffect(() => { if (tab === 'words') void loadWords() }, [tab, loadWords])
  useEffect(() => { if (tab === 'analysis') void loadAnalysis() }, [tab, loadAnalysis])
  // 语法：进页面就拉目录树（进度跟着一起回来），顺带拉一下练过的流水。
  useEffect(() => {
    if (tab !== 'grammar') return
    setGrammarBusy(true)
    void fetchGrammarTree()
      .then(setGrammar)
      .catch((e) => setGrammarErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setGrammarBusy(false))
  }, [tab, grammarTick])

  /** 「再洗一轮」：换一副新牌，从头再来。**已经点过「认识」的仍然不会再出现**（那是学习进度，不是轮次）。 */
  const reshuffle = () => {
    if (busy) return
    seedRef.current = newSeed()
    seenRef.current = new Set(); redrillRef.current = new Set()
    setQueueScreen(1)
    void loadQueue()
    flash('重新洗过一轮了 —— 点过「认识」的不会再出现')
  }

  const reviewed = async (word: VocabWord, r: 'known' | 'fuzzy' | 'forgot', elapsedMs = 0) => {
    try {
      // 先记记号再看结果：认识 → 拉黑不再出；模糊/忘了 → 下一次插回队首。
      if (r === 'known') { knownRef.current.add(word.id); redrillRef.current.delete(word.id) }
      else { redrillRef.current.add(word.id) }
      const saved = await reviewVocabWord(word.id, r, { mode: 'recognize', elapsedMs })
      flash(r === 'known' ? '记住了 —— 下次推远一点' : r === 'fuzzy' ? '模糊：间隔缩一半，过两天再来' : '没关系，明天再见它一次')
      setQueue((list) => list.filter((w) => w.id !== word.id))
      void loadOverview()
      return saved
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null }
  }

  const addWord = async () => {
    if (!newWord.word.trim()) return
    try {
      await createVocabWord({ word: newWord.word.trim(), meaning: newWord.meaning, tag: newWord.tag })
      setNewWord({ word: '', meaning: '', tag: newWord.tag })
      flash('加好了')
      void loadWords(); void loadOverview()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const addExam = async () => {
    try {
      await addVocabExam({
        kind: exam.kind, title: exam.title,
        score: exam.score ? Number(exam.score) : null,
        max_score: exam.max_score ? Number(exam.max_score) : null,
        taken_at: new Date().toISOString().slice(0, 10),
      })
      setExam({ ...exam, title: '', score: '' })
      flash('成绩记下了 —— 分析页会一起算进去')
      void loadAnalysis(); void loadOverview()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const stats = overview?.stats
  const tags = useMemo(() => (overview?.tags ?? []).filter((t) => t.tag), [overview])

  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h2 className="text-[20px] font-extrabold tracking-wide">📖 英语学习</h2>
        <span className="text-[13px] text-[var(--text-3)]">
          用你自己的词表背四六级 —— 让她写例句、画插图，不懂就问她，成绩和薄弱点这里算
        </span>
      </div>

      {toast && (
        <div className="mb-3 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {toast}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {err}
          <button className="ml-2 underline" onClick={() => setErr('')}>知道了</button>
        </div>
      )}

      {/* 四个数字 */}
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { k: '词库', v: stats?.total ?? 0, hint: '个词' },
          { k: '今天该复习', v: stats?.due ?? 0, hint: '个到期' },
          { k: '练过', v: overview?.quiz.answered ?? 0, hint: '次作答' },
          { k: '坚持', v: overview?.quiz.days_studied ?? 0, hint: '天有练习' },
        ].map((c) => (
          <div key={c.k} className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
            <div className="text-[11px] text-[var(--text-3)]">{c.k}</div>
            <div className="text-[24px] font-extrabold leading-tight text-[var(--text)]">{c.v}</div>
            <div className="text-[11px] text-[var(--text-3)]">{c.hint}</div>
          </div>
        ))}
      </div>

      {(stats?.total ?? 0) === 0 && (
        <div className="mb-4 rounded-2xl border border-dashed border-[var(--border-strong)] p-4 text-[13px] text-[var(--text-2)]">
          词库还是空的。两张路子：<b>导入旧词表</b>（下面「导入旧词表」按钮，xlsx / csv / txt 都行），
          或者直接<b>手加几个词</b>先试试手感 —— 加完可以让她写例句、画插图。
        </div>
      )}

      {/* 页签 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button key={t.id} className={`form-chip ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button className="btn ghost sm" onClick={() => setShowImport((v) => !v)}>
            {showImport ? '收起导入' : '📥 导入旧词表'}
          </button>
        </span>
      </div>

      {/* 点开卡片就直接能用：起不来才让用户看见 —— 正在拉的时候说的是「等我一下」，不是「坏了」。 */}
      {booting && (
        <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text-3)]">
          正在把英语学习的服务拉起来…（第一次要一两秒）
        </div>
      )}
      {down && !booting && (
        <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {down}
          <button className="ml-2 underline" onClick={retry}>再试一次</button>
        </div>
      )}

      {showImport && (
        <div className="mb-4">
          <ImportPanel onDone={() => { void loadOverview(); void loadWords() }} />
        </div>
      )}

      {tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button className={`form-chip ${filterTag === '' ? 'on' : ''}`} onClick={() => setFilterTag('')}>
            全部 {(stats?.total ?? 0)}
          </button>
          {tags.map((t) => (
            <button key={t.tag} className={`form-chip ${filterTag === t.tag ? 'on' : ''}`}
              onClick={() => setFilterTag(t.tag)}>
              {t.tag} {t.count}{t.due > 0 ? ` · ${t.due} 到期` : ''}
            </button>
          ))}
        </div>
      )}

      {/* 复习 */}
      {tab === 'review' && (
        <div className="space-y-2.5">
          <p className="text-[12px] text-[var(--text-3)]">
            一屏 50 个，顺序是洗过的（不是按字母顺下去）。答「认识」间隔往后推、这轮不再出现；
            答「模糊 / 忘了」的会插回队首再看一眼。三档就行，不用纠结打几分。
          </p>
          {busy && queue.length === 0 && <p className="text-[13px] text-[var(--text-3)]">洗牌中…</p>}
          {!busy && queue.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-5 text-[13px] text-[var(--text-3)]">
              {(stats?.total ?? 0) === 0 ? (
                '还没有词 — 先导入或手加几个。'
              ) : (
                <>
                  <p>
                    {queueRemaining > 0
                      ? '这屏答完了。下一屏还有词 —— 接着看，或者重洗一副牌换个顺序。'
                      : '这一轮都过完了 —— 剩下的不是点了「认识」就是还没到期。想再练一遍就「再洗一轮」。'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {queueRemaining > 0 && (
                      <button className="btn sm"
                        onClick={() => { setQueueScreen((n) => n + 1); void loadQueue() }}>
                        再看下一屏 →
                      </button>
                    )}
                    <button className="btn ghost sm" onClick={reshuffle}>🔀 再洗一轮</button>
                  </div>
                </>
              )}
            </div>
          )}
          {queue.map((w) => (
            <WordCard key={w.id} word={w} characters={characters}
              expanded={expanded === w.id}
              onToggleDetail={() => setExpanded(expanded === w.id ? '' : w.id)}
              onReviewed={(r, ms) => void reviewed(w, r, ms)}
              onChanged={() => { void loadOverview() }} />
          ))}
          {queue.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-[11px] text-[var(--text-3)]">
                第 {queueScreen} 屏 · 这屏还剩 {queue.length} 个 · 后面还有 {queueRemaining} 个
              </span>
              <button className="btn ghost sm" disabled={busy}
                onClick={() => { if (busy) return; setQueueScreen((n) => n + 1); void loadQueue() }}>
                再看下一屏 →
              </button>
              <button className="btn ghost sm" disabled={busy} onClick={reshuffle}>
                {busy ? '洗着呢…' : '🔀 再洗一轮'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 词表 */}
      {tab === 'words' && (
        <div>
          <div className="mb-3 flex flex-wrap gap-2">
            <input className="input max-w-[220px]" placeholder="搜单词或释义…" value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void loadWords() }} />
            <select className="input max-w-[150px]" value={order}
              onChange={(e) => setOrder(e.target.value as typeof order)}>
              <option value="due">按到期排</option>
              <option value="new">新词优先</option>
              <option value="alpha">首字母</option>
              <option value="recent">最近加的</option>
            </select>
            <button className="btn ghost sm" disabled={busy} onClick={() => void loadWords()}>刷新</button>
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <input className="input max-w-[160px]" placeholder="新词（英文）" value={newWord.word}
              onChange={(e) => setNewWord({ ...newWord, word: e.target.value })} />
            <input className="input max-w-[200px]" placeholder="释义" value={newWord.meaning}
              onChange={(e) => setNewWord({ ...newWord, meaning: e.target.value })} />
            <input className="input max-w-[130px]" placeholder="分类（可空）" value={newWord.tag}
              onChange={(e) => setNewWord({ ...newWord, tag: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void addWord() }} />
            <button className="btn sm" disabled={!newWord.word.trim()} onClick={() => void addWord()}>加一个词</button>
          </div>

          <p className="mb-2 text-[12px] text-[var(--text-3)]">
            共 {wordsTotal} 个{filterTag ? `（${filterTag}）` : ''}
            {words.length < wordsTotal ? `，显示前 ${words.length} 个` : ''}
          </p>

          <div className="space-y-2.5">
            {words.map((w) => (
              <WordCard key={w.id} word={w} characters={characters}
                expanded={expanded === w.id}
                onToggleDetail={() => setExpanded(expanded === w.id ? '' : w.id)}
                onReviewed={(r, ms) => void reviewed(w, r, ms)}
                onChanged={() => { void loadWords(); void loadOverview() }} />
            ))}
          </div>
          {words.length === 0 && !busy && (
            <p className="text-[13px] text-[var(--text-3)]">没有匹配的词。</p>
          )}
        </div>
      )}

      {/* 语法 */}
      {tab === 'grammar' && (
        <div>
          {grammarBusy && !grammar && <p className="text-[13px] text-[var(--text-3)]">正在读大纲…</p>}
          {grammarErr && (
            <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
              {grammarErr}
              <button className="ml-2 underline" onClick={() => { setGrammarErr(''); setGrammarTick((n) => n + 1) }}>
                再试一次
              </button>
            </div>
          )}
          {!grammarErr && grammar && (
            <GrammarPanel tree={grammar} onRefresh={() => setGrammarTick((n) => n + 1)} />
          )}
        </div>
      )}

      {/* 分析 */}
      {tab === 'analysis' && (
        <div className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="mb-2 flex items-baseline gap-2">
                <b className="text-[15px]">🧠 最容易忘的词</b>
                <span className="text-[11px] text-[var(--text-3)]">近 30 天错得最多 / 反复模糊</span>
              </div>
              {(analysis?.weak_words ?? []).length === 0 ? (
                <p className="text-[12px] text-[var(--text-3)]">还没攒够数据 —— 去复习几轮就有了。</p>
              ) : (
                <ul className="space-y-1.5">
                  {analysis!.weak_words.map((w) => (
                    <li key={w.word} className="flex items-baseline gap-2 text-[13px]">
                      <b className="min-w-[90px] text-[var(--text)]">{w.word}</b>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-2)]">{w.meaning}</span>
                      <span className="shrink-0 text-[11px] text-[var(--pink-deep)]">
                        忘 {w.wrong} · 模糊 {w.fuzzy} · 正确率 {Math.round(w.accuracy * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="mb-2 flex items-baseline gap-2">
                <b className="text-[15px]">📉 拖后腿的分类</b>
                <span className="text-[11px] text-[var(--text-3)]">正确率最低的那几类</span>
              </div>
              {(analysis?.weak_tags ?? []).length === 0 ? (
                <p className="text-[12px] text-[var(--text-3)]">还没有够 3 次作答的分类。</p>
              ) : (
                <ul className="space-y-1.5">
                  {analysis!.weak_tags.map((t) => (
                    <li key={t.tag} className="flex items-baseline gap-2 text-[13px]">
                      <b className="min-w-[90px] text-[var(--text)]">{t.tag}</b>
                      <span className="min-w-0 flex-1">
                        <span className="inline-block h-1.5 rounded-full bg-[var(--pink)]"
                          style={{ width: `${Math.round(t.accuracy * 100)}%`, minWidth: 4 }} />
                      </span>
                      <span className="shrink-0 text-[11px] text-[var(--text-3)]">
                        {Math.round(t.accuracy * 100)}%（{t.known}/{t.seen}）
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 border-t border-[var(--border)] pt-2">
                <b className="text-[13px]">反应偏慢（认得但不熟）</b>
                {(analysis?.slow_words ?? []).length === 0 ? (
                  <p className="text-[12px] text-[var(--text-3)]">还没有明显慢的词。</p>
                ) : (
                  <p className="mt-1 text-[12px] text-[var(--text-2)]">
                    {analysis!.slow_words.map((w) => `${w.word}（${(w.avg_ms / 1000).toFixed(1)}s）`).join('、')}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* 进度分布 + 逐日曲线 */}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-2 flex items-baseline gap-2">
              <b className="text-[15px]">📈 近 30 天</b>
              <span className="text-[11px] text-[var(--text-3)]">
                练了 {analysis?.overview.recent_answered ?? 0} 次，正确率{' '}
                {Math.round((analysis?.overview.accuracy ?? 0) * 100)}%
              </span>
            </div>
            {(analysis?.daily ?? []).length === 0 ? (
              <p className="text-[12px] text-[var(--text-3)]">这段时间还没练过。</p>
            ) : (
              <div className="flex h-24 items-end gap-1">
                {analysis!.daily.map((d) => {
                  const max = Math.max(...analysis!.daily.map((x) => x.answered), 1)
                  const h = Math.max(4, Math.round((d.answered / max) * 88))
                  return (
                    <div key={d.date} className="flex min-w-[10px] flex-1 flex-col items-center justify-end"
                      title={`${d.date}：${d.answered} 次，正确率 ${Math.round(d.accuracy * 100)}%`}>
                      <div className="w-full rounded-t bg-[var(--pink)]" style={{ height: h }} />
                    </div>
                  )
                })}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-[var(--text-2)]">
              <span>新词 {analysis?.buckets.fresh ?? 0}</span>
              <span>在学 {analysis?.buckets.learning ?? 0}</span>
              <span>认识 {analysis?.buckets.known ?? 0}</span>
              <span>熟练 {analysis?.buckets.solid ?? 0}</span>
            </div>
          </div>

          {/* 成绩 */}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="mb-2 flex items-baseline gap-2">
              <b className="text-[15px]">🎯 成绩</b>
              <span className="text-[11px] text-[var(--text-3)]">四六级真考、模考、真题练习都记这儿</span>
            </div>
            <div className="mb-3 flex flex-wrap gap-2">
              <select className="input max-w-[130px]" value={exam.kind}
                onChange={(e) => setExam({ ...exam, kind: e.target.value })}>
                <option value="cet4">四级</option>
                <option value="cet6">六级</option>
                <option value="mock">模考</option>
                <option value="quiz">练习</option>
                <option value="other">其他</option>
              </select>
              <input className="input max-w-[160px]" placeholder="名称（可空）" value={exam.title}
                onChange={(e) => setExam({ ...exam, title: e.target.value })} />
              <input className="input max-w-[100px]" placeholder="得分" value={exam.score}
                onChange={(e) => setExam({ ...exam, score: e.target.value })} />
              <input className="input max-w-[100px]" placeholder="满分" value={exam.max_score}
                onChange={(e) => setExam({ ...exam, max_score: e.target.value })} />
              <button className="btn sm" disabled={!exam.score} onClick={() => void addExam()}>记一笔</button>
            </div>
            {(analysis?.exams ?? []).length === 0 ? (
              <p className="text-[12px] text-[var(--text-3)]">还没记过成绩。</p>
            ) : (
              <ul className="space-y-1.5">
                {analysis!.exams.map((e: VocabExam) => (
                  <li key={e.id} className="flex items-baseline gap-2 text-[13px]">
                    <span className="text-[11px] text-[var(--text-3)]">{e.taken_at || e.created_at.slice(0, 10)}</span>
                    <b className="text-[var(--text)]">
                      {e.kind === 'cet4' ? '四级' : e.kind === 'cet6' ? '六级'
                        : e.kind === 'mock' ? '模考' : e.kind === 'quiz' ? '练习' : '其他'}
                    </b>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-2)]">{e.title}</span>
                    <span className="shrink-0 font-semibold text-[var(--text)]">
                      {e.score ?? '—'}{e.max_score ? ` / ${e.max_score}` : ''}
                    </span>
                    <button className="shrink-0 text-[11px] text-[var(--text-3)] underline"
                      onClick={() => void deleteVocabExam(e.id).then(() => { void loadAnalysis(); void loadOverview() })}>
                      删
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end">
            <button className="btn ghost sm" disabled={busy} onClick={() => void loadAnalysis()}>重新分析</button>
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] text-[var(--text-3)]">
        插图和小糖人的例句都落在附件库（{overview?.attachment_session ?? 'english-vocab'} 那个目录），
        不在小窝里另存一份 —— 清理附件时它们一起被管。
      </p>

      {/* ---- 自己的设置（Block 二 ②）----
          以前这些开关跟别的功能挤在「🛠 设置与工具 → ⚙ 功能开关」里一起列，得在那排 chip 里挑；
          现在跟着英语学习待在同一个面板 —— 学什么 / 谁陪你 / 导入都在这里改，不用重启。 */}
      <div className="mt-4 border-t border-[var(--border)] pt-3">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <span className="text-[14px] font-bold text-[var(--text)]">⚙ 英语学习的设置</span>
          <span className="text-[11px] text-[var(--text-3)]">
            只看哪个分类 / 每天几个 / 一屏几个 / 谁来陪你 / 导入目录 —— 改完下一轮就用上
          </span>
        </div>
        <NestSettingsPanel onlyId="english_study" bare />
      </div>
    </section>
  )
}