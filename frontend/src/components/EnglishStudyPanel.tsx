// 糖人小窝 · 英语学习面板（feature `english_study`）。
//
// 为什么这个功能在本体里、又为什么在小窝里渲染：它是**交互界面 + 你自己的学习数据**，
// 不是在外面跑循环的采集端（§9.6 里 folder="" 的那种）。所以没有 start/stop 按钮，
// 就是一块面板。
//
// 四件事，对应当初提的四条：
//   ① 导入旧单词表   → 「词表」页右上「导入旧词表」：先试读（看它把哪列认成了什么），认对了再导
//   ② 例句 + 插图    → 每个词的详情卡里：让小糖人写例句 / 自己写 / 上传插图 / 生成插图；
//                      不懂的语法就在下面那个问句框里问她（带上下文，她会讲给你听）
//   ③ 成绩与薄弱点   → 「分析」页：易忘词 / 拖后腿的分类 / 慢反应 + 逐日曲线 + 成绩记录
//   ④ 复习           → 首页队列，三档作答（认识/模糊/忘了）直接改复习间隔
//
// 发音走已有的 /api/voice/tts（edge 晓晓），插图走已有的 /api/images/generate，
// 例句的附件也落在附件库（`english-vocab` 目录）—— 都不另起一套（§9.6.4）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addVocabExample, addVocabExam, askVocabQuestion, createVocabWord, deleteVocabExample,
  deleteVocabWord, deleteVocabExam, fetchVocabAnalysis, fetchVocabOverview, fetchVocabQueue,
  fetchVocabWords, generateVocabExamples, importVocabFile, patchVocabWord, reviewVocabWord,
  type ImportResult, type VocabAnalysis, type VocabExam, type VocabOverview, type VocabWord,
} from '../api/english'
import { fetchCharacters } from '../api/client'
import { generateImages } from '../api/imagegen'
import { buildAppearancePrompt } from '../lib/comfyPrompt'
import { uploadAttachmentsBatch } from '../api/storage'
import type { CharacterProfile } from '../data/characters'

type Tab = 'review' | 'words' | 'analysis'

const TABS: { id: Tab; label: string }[] = [
  { id: 'review', label: '🔁 复习' },
  { id: 'words', label: '📚 词表' },
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

function WordDetail({
  word, characters, onChanged, onClose,
}: {
  word: VocabWord
  characters: CharacterProfile[]
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
  const speak = useSpeak()
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setNote(word.note) }, [word.id, word.note])

  // 派生出来的当前角色：用户没点过就用名册第一位。不 setState，免得渲染里改状态。
  const activeChar = charId || characters[0]?.id || ''
  const activeName = characters.find((c) => c.id === activeChar)?.name ?? '小糖人'

  const run = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag)
    setErr('')
    try { await fn(); onChanged() }
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
    const target = word.examples?.[word.examples.length - 1]
    return addVocabExample(word.id, target
      ? { text: target.text, translation: target.translation, image: orig, image_thumb: thumb }
      : { text: '', image: orig, image_thumb: thumb })
  }

  // 生成插图：拿她的外貌词条 + 这条例句当场景，画一张这张词卡的图。
  // 用哪张图看「模型设置 §7」里选的引擎 —— 引擎没配好后端会点名缺什么，原话透出来。
  const genImage = () => run('genimg', async () => {
    const profile = characters.find((c) => c.id === activeChar)
    if (!profile) throw new Error('还没有小糖人 —— 先去介绍页建一位，再让她画插图')
    const scene = word.examples?.[word.examples.length - 1]?.text?.trim()
    const prompt = [
      buildAppearancePrompt(profile),
      scene ? `场景：${scene}` : `围绕「${word.word}」的一个日常场景`,
      '单词卡插图，柔和暖色，画面干净',
    ].filter(Boolean).join('，')
    const imgs = await generateImages({ prompt, session_id: 'english-vocab', n: 1 })
    const first = imgs[0]
    if (!first) throw new Error('生图返回为空 —— 看下「模型设置」里选的引擎通不通')
    await attachImage(first.orig, first.thumb)
  })

  const ask = () => run('ask', async () => {
    const q = question.trim()
    if (!q) throw new Error('先写要问什么')
    const saved = await askVocabQuestion(word.id, q, activeChar)
    setAnswers((list) => [{ q, a: saved.answer, who: saved.character_name }, ...list])
    setQuestion('')
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

        {(word.examples ?? []).length === 0 ? (
          <p className="text-[12px] text-[var(--text-3)]">
            还没有例句。让她写几句 —— 她会用自己的日常造句，比课本例句好记。
          </p>
        ) : (
          <ul className="space-y-2">
            {(word.examples ?? []).map((ex) => (
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
        {(word.questions ?? []).length > 0 && answers.length === 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] text-[var(--text-3)]">
              以前问过 {word.questions!.length} 次
            </summary>
            <div className="mt-1.5 space-y-2">
              {word.questions!.map((q) => (
                <div key={q.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                  <p className="text-[12px] text-[var(--text-3)]">你问：{q.question}</p>
                  <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--text)]">{q.answer}</p>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

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
  const speak = useSpeak()
  // 这一张卡从出现到现在花了多久 —— 作答复盘时一起报上去，用来找「认得但不熟」的词。
  const shownAt = useRef(Date.now())

  useEffect(() => { shownAt.current = Date.now(); setRevealed(false) }, [word.id])

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
        <WordDetail word={word} characters={characters}
          onChanged={onChanged} onClose={onToggleDetail} />
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
  // 「换一轮」翻到第几屏。0 = 队首。翻到头就把轮次归零转回队首 —— 一屏 50 个够背了。
  const [queueRound, setQueueRound] = useState(0)
  // 队列到底有多长（后端按 skip 取回来的 next_skip 推）。翻到这儿就该回头了。
  const [queueMore, setQueueMore] = useState(true)

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const loadOverview = useCallback(async () => {
    try { setOverview(await fetchVocabOverview()) } catch { setOverview(null) }
  }, [])

  const loadQueue = useCallback(async (round = 0) => {
    setBusy(true)
    try {
      const r = await fetchVocabQueue(QUEUE_SIZE, filterTag || undefined, round * QUEUE_SIZE)
      setQueue(r.items)
      setQueueRound(round)
      // 这屏取满了 → 后面多半还有；取不满 → 到头了。
      setQueueMore(r.items.length >= QUEUE_SIZE)
      if (r.items.length === 0 && round > 0) {
        // 翻过界（比如中途删了词）→ 悄悄转回队首，别让人对着空屏。
        const back = await fetchVocabQueue(QUEUE_SIZE, filterTag || undefined, 0)
        setQueue(back.items); setQueueRound(0); setQueueMore(back.items.length >= QUEUE_SIZE)
        flash('已经到最后一批了，转回队首')
      }
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
  useEffect(() => { void loadOverview() }, [loadOverview])
  // 换分类就回队首 —— 别的分类的轮次在这儿没意义。
  useEffect(() => { if (tab === 'review') void loadQueue(0) }, [tab, loadQueue])
  useEffect(() => { if (tab === 'words') void loadWords() }, [tab, loadWords])
  useEffect(() => { if (tab === 'analysis') void loadAnalysis() }, [tab, loadAnalysis])

  /** 「换一轮」：翻下一屏；翻到头就转回队首。 */
  const nextRound = () => {
    if (busy) return
    void loadQueue(queueMore ? queueRound + 1 : 0)
    if (!queueMore) flash('已经到最后一批了，转回队首')
  }

  const reviewed = async (word: VocabWord, r: 'known' | 'fuzzy' | 'forgot', elapsedMs = 0) => {
    try {
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
            先复习到期的，够了再补新词。答「认识」间隔往后推，答「模糊」缩一半，答「忘了」明天重来 ——
            三档就行，不用纠结打几分。
          </p>
          {busy && queue.length === 0 && <p className="text-[13px] text-[var(--text-3)]">读取中…</p>}
          {!busy && queue.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-5 text-[13px] text-[var(--text-3)]">
              {(stats?.total ?? 0) === 0
                ? '还没有词 — 先导入或手加几个。'
                : '这一轮都过完了，歇会儿。明天再来它会把该复习的排好队。'}
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
            <div className="flex items-center justify-end gap-2">
              <span className="text-[11px] text-[var(--text-3)]">第 {queueRound + 1} 批 · 这屏 {queue.length} 个</span>
              <button className="btn ghost sm" disabled={busy} onClick={nextRound}>
                {busy ? '换着呢…' : queueMore ? '换一轮' : '换一轮（回队首）'}
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
    </section>
  )
}