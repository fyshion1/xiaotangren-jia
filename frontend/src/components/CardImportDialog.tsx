/**
 * 酒馆角色卡导入浮层（聊天 · 会话列表底部的「🎴 导入角色卡（酒馆）」）。
 *
 * **快慢分开**（用户实测后拍板）：读卡 + 拼「关于」是纯本地活儿（毫秒级），
 * 所有慢的都在「叫模型」上 —— 所以预览先出画面（立绘 / 名字 / 关于立刻能看），
 * 词条抽取与中文译文只在用户点击后发起流式请求，打开预览不调用模型。
 * **这两件事永远不挡导入** —— 词条没抽完 / 译文没翻完 / 直接失败，都只是少填一点。
 *
 * 三条铁规矩（都是用户拍板的）：
 * 1. **原文一字不改** —— 「关于」里的正文是原作者写的，原样进来，不洗、不删、不改。
 * 2. **开场白不自动发言** —— 卡里的 first_mes 去标签后**存进档案**，但默认不勾选、
 *    绝不自动塞进聊天记录；想用就在这里勾一下（或事后在角色介绍页点「插入开场白」）。
 * 3. **重名先问** —— 同名角色已在库时，默认「跳过」（不动），用户坚持才建第二张。
 *
 * 中文译文（`aboutZh`）**只给界面看**：喂给模型的永远是原文，一键能切回去。
 *
 * 只在这里改「名字 / 别名 / emoji / 关于」，其余抽出来的词条进来后去 ✎ 编辑资料改 ——
 * 那套编辑器本来就有，不在这里再铺一遍。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import {
  commitTavernCard,
  extractTavernCardStream,
  previewTavernCard,
  translateTavernCardStream,
  type CardImportRoute,
  type CardPreview,
} from '../api/cardImport'
import { parseExtracted } from '../lib/partialJson'
import { parseProfileText } from '../lib/parseProfile'
import RichText from './RichText'
import CardHtmlPreview from './CardHtmlPreview'
import { hasCardHtml } from '../lib/cardHtml'

/** 汉字占字母的比例 ≥ 0.6 才算「这段是中文」——和后端 is_mostly_chinese 同一口径。 */
function isCjkText(text: string): boolean {
  const letters = Array.from(text).filter((ch) => /\p{L}/u.test(ch))
  if (!letters.length) return true
  return letters.filter((ch) => /[一-鿿]/.test(ch)).length / letters.length >= 0.6
}

type Props = {
  file: File
  /** 抽词条 / 翻译文用哪份上游（传聊天那一份配置即可）；不传则由后端回退 .env。 */
  route?: CardImportRoute
  onClose: () => void
  /** 建好了：带上落库后的完整档案（含最终 id）。 */
  onImported: (char: CharacterProfile) => void
}

/** 预览里按行展示的「抽出来的词条」（只读，改了去编辑资料）。 */
const SHOW_ROWS: [string, string][] = [
  ['birthday', '生日'],
  ['age', '年龄'],
  ['height', '身高'],
  ['bloodType', '血型'],
  ['constellation', '星座'],
  ['occupation', '职业'],
  ['bodyType', '体型'],
  ['eyeColor', '瞳色'],
  ['hairstyle', '发型'],
  ['hairColor', '发色'],
  ['bust', '胸部'],
  ['hip', '臀部'],
  ['measurements', '三围'],
  ['weight', '体重'],
  ['clothing', '服装'],
  ['relationships', '关系'],
  ['specialFeatures', '特殊特征'],
  ['catchphrase', '口头禅'],
  ['secret', '秘密'],
  ['weakPoint', '弱点'],
  ['privateWish', '私密小愿望'],
]

const LIST_ROWS: [string, string][] = [
  ['personality', '性格'],
  ['likes', '喜好'],
  ['dislikes', '讨厌'],
]

type GenStatus = 'idle' | 'running' | 'done' | 'failed'

export default function CardImportDialog({ file, route, onClose, onImported }: Props) {
  const [preview, setPreview] = useState<CardPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  // 用户改过的那几项（只覆盖动过的键）
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [emoji, setEmoji] = useState('🎴')
  const [about, setAbout] = useState('')
  // 重名时用户是否选了「还是新建第二张」
  const [forceNew, setForceNew] = useState(false)

  // 后填的两件事：模型抽的词条、模型翻的译文（各自独立，谁先回谁先填）
  const [extracted, setExtracted] = useState<Partial<CharacterProfile>>({})
  const [extractState, setExtractState] = useState<GenStatus>('idle')
  const [extractNote, setExtractNote] = useState('')
  const [aboutZh, setAboutZh] = useState('')
  const [transState, setTransState] = useState<GenStatus>('idle')
  const [transNote, setTransNote] = useState('')
  const [aiWarnings, setAiWarnings] = useState<string[]>([])
  // 「关于」看译文、看原文、还是看带格式的预览（可改的永远是原文）
  const [viewMode, setViewMode] = useState<'zh' | 'raw' | 'format'>('raw')
  // 开场白折叠 / 展开
  const [greetingOpen, setGreetingOpen] = useState(false)
  // 用户动过的键：后到的抽取结果不许盖掉手改的值
  const touched = useRef<Set<string>>(new Set())
  // 正在跑的模型请求（取消 / 关闭时一并断掉）
  const busy = useRef<AbortController[]>([])
  const extractRequest = useRef<AbortController | null>(null)
  const translateRequest = useRef<AbortController | null>(null)
  // 译文是对着哪份原文翻的（原文改过 → 译文过期，提示可重翻）
  const translatedFrom = useRef('')
  // 开场白要不要写进私聊第一条（默认不勾 —— 不勾就是你现在看到的没广告的样子）
  const [greetingOn, setGreetingOn] = useState(false)

  const abortAll = () => {
    for (const c of busy.current) c.abort()
    busy.current = []
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    touched.current = new Set()
    translatedFrom.current = ''
    setExtracted({})
    setExtractState('idle')
    setExtractNote('')
    setAboutZh('')
    setTransState('idle')
    setTransNote('')
    setAiWarnings([])
    setViewMode('raw')
    setGreetingOn(false)
    setGreetingOpen(false)
    setForceNew(false)
    // 只读卡；词条与译文由按钮分别触发。
    previewTavernCard(file)
      .then((p) => {
        if (!alive) return
        setPreview(p)
        setName(p.profile.name || '')
        setAlias(p.profile.alias || '')
        setEmoji(p.profile.emoji || '🎴')
        setAbout((p.profile.about as string) || '')
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      abortAll()
    }
    // route 是每次渲染新建的对象字面量，进依赖会无限重读卡 —— 只看 file 与上游的三个值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, route?.baseUrl, route?.apiKey, route?.model])

  /** 词条流：边吐边解析成半成品填上去。失败 / 断连不致命 —— 先把已收到的接上，
   *  一个都没抽到再用本地模板解析兜底。 */
  const runExtract = () => {
    if (extractRequest.current && !extractRequest.current.signal.aborted) return
    const ctrl = new AbortController()
    extractRequest.current = ctrl
    busy.current.push(ctrl)
    let raw = ''
    let lastParse = 0
    let alive = true
    setExtractState('running')
    setExtractNote('')
    setAiWarnings((w) => w.filter((x) => !x.startsWith('自动解析词条')))
    const mergePartial = () => {
      const f = parseExtracted(raw)
      if (!Object.keys(f).length) return
      setExtracted(f)
      if (!touched.current.has('alias') && f.alias) setAlias(String(f.alias))
    }
    extractTavernCardStream(file, route, {
      signal: ctrl.signal,
      onToken: (t) => {
        raw += t
        // 每 120ms 才重解析一次：模型一个 token 一个 token 地吐，没必要每下都动界面
        const now = Date.now()
        if (now - lastParse > 120) {
          lastParse = now
          mergePartial()
        }
      },
      onStatus: (m) => alive && setExtractNote(m),
      onDone: (p) => {
        if (!alive) return
        const serverFields = (p.fields ?? {}) as Partial<CharacterProfile>
        const fields = Object.keys(serverFields).length ? serverFields : parseExtracted(raw)
        setExtracted(fields)
        if (!touched.current.has('alias') && fields.alias) setAlias(String(fields.alias))
        const warnings = (p.warnings ?? []) as string[]
        if (warnings.length) setAiWarnings((w) => [...w, ...warnings])
        const ok = Boolean(fields && Object.keys(fields).length)
        setExtractState(ok ? 'done' : 'failed')
        // 键名全被认掉（模型只写了 jp / name 之类不认识的键）时 payload.reason 是 "done" 但 warnings 说清了
        const why = warnings[0] || (p.reason === 'length' ? '词条太多被截断了' : '模型没吐出能用的词条')
        setExtractNote(ok ? '' : why)
      },
      onError: (msg, payload) => {
        if (!alive) return
        mergePartial()
        // 本地兜底：原文要是「标签：值」这种规整格式，自己也能认几项
        const warned = ((payload?.warnings ?? []) as string[]).filter(Boolean)
        let got = Object.keys(parseExtracted(raw)).length
        if (!got) {
          const local = parseProfileText((preview?.profile.about as string) || '')
          if (Object.keys(local.fields).length) {
            setExtracted(local.fields)
            got = Object.keys(local.fields).length
            setExtractNote('模型没连上，词条按本地模板认了几项')
          }
        } else {
          setExtractNote(msg)
        }
        setAiWarnings((w) => [
          ...w,
          // 后端已经写明原因（比如「模型没给出能用的词条」）就直接用它的
          ...(warned.length ? warned : [`自动解析词条没成功（${msg}）—— 不影响导入，已抽到的照样填，缺的落库后手动补。`]),
        ])
        setExtractState(got ? 'done' : 'failed')
      },
    }).finally(() => {
      busy.current = busy.current.filter((c) => c !== ctrl)
      if (extractRequest.current === ctrl) extractRequest.current = null
      if (alive) setExtractState((s) => (s === 'running' ? 'failed' : s))
    })
  }

  /** 译文流：边翻边显示。后端发现正文本来就是中文会直接跳过（不叫模型）。 */
  const runTranslate = (src: string) => {
    if (!src.trim() || (translateRequest.current && !translateRequest.current.signal.aborted)) return
    const ctrl = new AbortController()
    translateRequest.current = ctrl
    busy.current.push(ctrl)
    let raw = ''
    let alive = true
    setTransState('running')
    setTransNote('')
    setAboutZh('')
    setViewMode('zh')
    setAiWarnings((w) => w.filter((x) => !x.startsWith('中文译文没翻成')))
    translateTavernCardStream(src, route, {
      signal: ctrl.signal,
      onToken: (t) => {
        raw += t
        setAboutZh(raw)
      },
      onStatus: (m) => alive && setTransNote(m),
      onDone: (p) => {
        if (!alive) return
        const zh = String(p.aboutZh ?? raw)
        translatedFrom.current = src
        setAboutZh(zh)
        setTransState('done')
        if (p.skipped) {
          setTransNote(String(p.reason || '正文本来就是中文，不用翻'))
          setViewMode((m) => (m === 'zh' ? 'raw' : m))
        } else if (!zh.trim()) {
          setTransState('failed')
          setTransNote('译文是空的')
        } else if (!isCjkText(zh) && isCjkText(src)) {
          // 模型把规则/原文复述了一遍，吐出来的还是门外语：不算翻成，界面继续看原文。
          setTransState('failed')
          setTransNote('模型没吐出中文，保留原文')
        }
      },
      onError: (msg, payload) => {
        if (!alive) return
        const zh = String(payload?.aboutZh ?? raw)
        const detail = zh.trim() ? `译文未完成，已保留收到的部分：${msg}` : msg
        setAboutZh(zh)
        setTransNote(detail)
        setTransState('failed')
        setAiWarnings((w) => [...w, msg.startsWith('中文译文没翻成') ? msg : `中文译文没翻成（${msg}）—— 不影响导入，界面继续看原文。`])
      },
    }).finally(() => {
      busy.current = busy.current.filter((c) => c !== ctrl)
      if (translateRequest.current === ctrl) translateRequest.current = null
      if (alive) setTransState((s) => (s === 'running' ? 'failed' : s))
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const hasDup = (preview?.duplicates.length ?? 0) > 0
  const fields = useMemo(() => {
    // 底子是草稿 + 后到的抽取结果，然后盖上用户手改的那几项（手改永远说了算）
    const p: Partial<CharacterProfile> & { imported?: boolean } = { ...(preview?.profile ?? {}), ...extracted }
    p.name = name.trim()
    p.alias = alias.trim()
    p.emoji = emoji.trim() || '🎴'
    p.about = about
    if (aboutZh.trim()) p.aboutZh = aboutZh
    // 原文明着改过的就别带库里那份排版了 —— 后端 commit 会按最终原文重算
    if (touched.current.has('about')) delete p.aboutHtml
    return p
  }, [preview, extracted, name, alias, emoji, about, aboutZh])

  const commit = async () => {
    if (!name.trim()) {
      setErr('角色得有名字')
      return
    }
    setSaving(true)
    setErr('')
    try {
      // id 留空 = 后端生成新的 —— 「新建第二张」正是靠这个，不会覆盖同名的那位。
      // greeting 勾了才把开场白写进她的私聊第一条（后端按当前身份算会话 id）。
      const saved = await commitTavernCard({ name: name.trim(), fields, greeting: greetingOn && greetingText !== '' })
      abortAll()
      onImported(saved)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // 改过原文 → 手上这份译文就过期了，提示一下，顺手给个重翻的按钮
  const retranslate = () => {
    runTranslate(about)
  }

  const card = preview ? { ...preview.profile, ...extracted } : undefined
  const greetingText = ((preview?.profile.greeting as string) || '').trim()
  const greetingHtml = (preview?.profile.greetingHtml as string) || ''
  const greetingSource = (preview?.profile.greetingSource as string) || greetingHtml || greetingText
  const zhStale = Boolean(aboutZh.trim()) && about.trim() !== translatedFrom.current.trim()
  const showingZh = viewMode === 'zh' && Boolean(aboutZh.trim())
  const showingFormat = viewMode === 'format'
  const allWarnings = [...(preview?.warnings ?? []), ...aiWarnings].filter(
    (w, i, a) => a.indexOf(w) === i,
  )

  // 失败总得写出**为什么**：没拿到原因时也别只留一个光秃秃的「没抽全」，那样跟没做一样。
  const extractLabel =
    extractState === 'running'
      ? extractNote || '正在抽词条…'
      : extractState === 'done'
        ? extractNote || '词条已填好'
        : extractState === 'failed'
          ? `词条没抽全：${extractNote || '模型没吐出能用的词条'}`
          : ''
  const transLabel =
    transState === 'running'
      ? transNote || (aboutZh ? '翻译中…（边翻边显示）' : '等着模型开口…')
      : transState === 'failed'
        ? `译文没翻成${transNote ? `：${transNote}` : ''}`
        : transState === 'done' && transNote
          ? transNote
          : ''

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={() => !saving && onClose()}>
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
          <span className="text-[15px] font-semibold text-[var(--text)]">🎴 导入角色卡</span>
          <span className="min-w-0 truncate text-[11px] text-[var(--text-3)]">{file.name}</span>
          <button onClick={() => !saving && onClose()} className="ml-auto text-[var(--text-3)] hover:text-[var(--text)]">
            ✕
          </button>
        </header>

        {loading ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-[13px] text-[var(--text-2)]">
            <span className="animate-pulse">读卡中…</span>
            <span className="text-[11px] text-[var(--text-3)]">只读取角色卡；翻译和抽词条需要点击按钮才开始。</span>
          </div>
        ) : !preview ? (
          <div className="px-4 py-10 text-center text-[13px] text-[#d9534f]">{err || '这张卡读不出来'}</div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {/* 卡的信息一行 */}
              <p className="mb-2 break-all text-[11px] text-[var(--text-3)]">
                翻译与词条使用聊天模型：{route?.model || '后端默认模型'} · {route?.baseUrl || '后端默认地址'}（与小窝大脑配置分开）
              </p>
              {(extractState === 'failed' || transState === 'failed' || aiWarnings.length > 0) && (
                <p className="mb-2 text-[11px] text-[var(--text-2)]">若提示 No available channel，请检查聊天设置中的当前通道、模型名和 Key 分组；只换 Key 不会自动切换模型。修改后重新打开导入框即可重试。</p>
              )}
              <p className="mb-3 text-[11px] leading-snug text-[var(--text-3)]">
                {preview.spec || '角色卡'}
                {preview.creator ? ` · 作者 ${preview.creator}` : ''}
                {preview.tags.length > 0 ? ` · ${preview.tags.slice(0, 6).join(' / ')}` : ''}
                {greetingText ? ' · 卡里带开场白（存下来，默认不发言）' : ''}
              </p>

              {/* 后填的两件事：各自一行，明说在干什么、到哪了 —— 别让人以为卡住了。
                  两行都是「进度」，不是「前提」：下面的导入按钮从来不会因为它们变灰。 */}
              <div className="mb-3 space-y-2">
                <p className="text-[11px] text-[var(--text-3)]">打开预览不会调用模型。以下操作按需点击，会消耗模型额度；也可以直接导入原文。</p>
                <div className="flex flex-wrap gap-2">
                  <button className="chip" disabled={saving || extractState === 'running'} onClick={runExtract}>
                    {extractState === 'running' ? '抽取中…' : extractState === 'idle' ? '抽取词条' : '重新抽取词条'}
                  </button>
                  <button className="chip" disabled={saving || transState === 'running' || !about.trim()} onClick={retranslate}>
                    {transState === 'running' ? '翻译中…' : transState === 'idle' ? '翻译成中文' : '重新翻译'}
                  </button>
                </div>
              </div>
              {(extractState !== 'idle' || transState !== 'idle') && (
                <div className="mb-3 space-y-1">
                  {extractState !== 'idle' && (
                    <p
                      className={`text-[11px] leading-snug ${
                        extractState === 'failed' ? 'text-[var(--text-2)]' : 'text-[var(--text-3)]'
                      }`}
                    >
                      <span className={extractState === 'running' ? 'animate-pulse' : ''}>{extractLabel}</span>
                      {extractState === 'running' && '（模型边吐边填，先导入也行）'}
                    </p>
                  )}
                  {transState !== 'idle' && (
                    <p
                      className={`text-[11px] leading-snug ${
                        transState === 'failed' ? 'text-[var(--text-2)]' : 'text-[var(--text-3)]'
                      }`}
                    >
                      <span className={transState === 'running' ? 'animate-pulse' : ''}>{transLabel}</span>
                      {transState === 'running' && (
                        <button className="chip ml-1" onClick={() => abortAll()} title="不看译文了，导入不受影响">
                          不用翻了
                        </button>
                      )}
                    </p>
                  )}
                </div>
              )}

              {/* 非致命提醒：截断了、没抽成、没卡图… 如实摊开 */}
              {allWarnings.length > 0 && (
                <div className="mb-3 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] p-3">
                  {allWarnings.map((w) => (
                    <p key={w} className="text-[12px] leading-snug text-[var(--text-2)]">
                      · {w}
                    </p>
                  ))}
                </div>
              )}

              {/* 重名：先问一句，默认跳过 */}
              {hasDup && !forceNew && (
                <div className="mb-3 rounded-xl border border-[var(--pink)] bg-[var(--pink-soft)] p-3">
                  <p className="text-[13px] font-semibold text-[var(--pink-deep)]">
                    家里已经有一位叫「{preview.duplicates[0].name}」了
                  </p>
                  <p className="mt-1 text-[12px] leading-snug text-[var(--text-2)]">
                    默认<b>跳过</b>（什么都不做，原来那位一字不动）。想留两张就在下面点
                    「新建第二张」—— 会话会各走各的，互不影响。
                  </p>
                </div>
              )}

              {/* 立绘 + 可改的名字 / 别名 / emoji */}
              <div className="flex gap-3">
                <div className="flex h-[112px] w-[112px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
                  {card?.portrait ? (
                    <img src={card.portrait as string} alt="卡图" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[40px]">{emoji || '🎴'}</span>
                  )}
                </div>
                <div className="grid min-w-0 flex-1 gap-2">
                  <label className="text-[12px] text-[var(--text-2)]">
                    名字
                    <input
                      className="input mt-1"
                      value={name}
                      onChange={(e) => {
                        touched.current.add('name')
                        setName(e.target.value)
                      }}
                    />
                  </label>
                  <div className="grid grid-cols-[1fr_84px] gap-2">
                    <label className="text-[12px] text-[var(--text-2)]">
                      别名 / 称号
                      <input
                        className="input mt-1"
                        value={alias}
                        onChange={(e) => {
                          touched.current.add('alias')
                          setAlias(e.target.value)
                        }}
                      />
                    </label>
                    <label className="text-[12px] text-[var(--text-2)]">
                      图标
                      <input className="input mt-1 text-center" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
                    </label>
                  </div>
                </div>
              </div>

              {/* 抽出来的词条：只读一览（模型边吐边铺满） */}
              {(LIST_ROWS.some(([k]) => (card?.[k as keyof typeof card] as string[])?.length) ||
                SHOW_ROWS.some(([k]) => (card?.[k as keyof typeof card] as string)?.trim())) && (
                <div className="mt-3 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-3">
                  <div className="mb-1.5 text-[12px] font-semibold text-[var(--pink-deep)]">
                    从原文里抽出来的词条（一个字都没编，原文没写的留空）
                    {extractState === 'running' && <span className="ml-1 font-normal text-[var(--text-3)]">· 还在抽…</span>}
                  </div>
                  {LIST_ROWS.map(([k, label]) => {
                    const items = (card?.[k as keyof typeof card] as string[]) || []
                    if (!items.length) return null
                    return (
                      <div key={k} className="mb-1 flex flex-wrap items-baseline gap-1.5">
                        <span className="text-[11px] text-[var(--text-3)]">{label}</span>
                        {items.map((it) => (
                          <span key={it} className="chip">
                            {it}
                          </span>
                        ))}
                      </div>
                    )
                  })}
                  <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                    {SHOW_ROWS.map(([k, label]) => {
                      const v = ((card?.[k as keyof typeof card] as string) || '').trim()
                      if (!v) return null
                      return (
                        <div key={k} className="status-row">
                          <span>{label}</span>
                          <span className="text-right">{v}</span>
                        </div>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-[var(--text-3)]">
                    这些进来后还能改 —— 角色介绍页点 ✎ 编辑资料。
                  </p>
                </div>
              )}

              {/* 关于：喂给模型的正文，原文照搬。译文 / 排版预览都只是摆着好读，切回来就是原文。 */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-[var(--text-2)]">关于（喂给模型的人设正文）</span>
                <div className="ml-auto flex items-center gap-1">
                  {aboutZh.trim() && (
                    <button
                      className={`chip ${showingZh ? 'ring-1 ring-[var(--pink)]' : 'opacity-70'}`}
                      onClick={() => setViewMode('zh')}
                      title="中文译文 —— 只给你看，喂模型用的还是原文"
                    >
                      中文译文
                    </button>
                  )}
                  <button
                    className={`chip ${viewMode === 'raw' ? 'ring-1 ring-[var(--pink)]' : 'opacity-70'}`}
                    onClick={() => setViewMode('raw')}
                    title="原文 —— 进档案、喂给模型的就是它；这里改的就是真正落库的那份"
                  >
                    原文（可改）
                  </button>
                  <button
                    className={`chip ${showingFormat ? 'ring-1 ring-[var(--pink)]' : 'opacity-70'}`}
                    onClick={() => setViewMode('format')}
                    title="在隔离预览中显示卡片 HTML 和样式，改字请去原文"
                  >
                    显示格式
                  </button>
                </div>
              </div>
              {showingZh ? (
                <div className="input mt-1 h-40 overflow-y-auto bg-[var(--surface-2)]">
                  <RichText html={aboutZh} className="text-[13px] leading-relaxed text-[var(--text-2)]" />
                  {transState === 'running' && <span className="animate-pulse text-[var(--text-3)]">▍</span>}
                </div>
              ) : showingFormat ? (
                <CardHtmlPreview html={about} characterName={name} defaultOpen />
              ) : (
                <textarea
                  className="input mt-1 h-40 resize-y font-[inherit] leading-relaxed"
                  value={about}
                  maxLength={20000}
                  onChange={(e) => {
                    touched.current.add('about')
                    setAbout(e.target.value)
                  }}
                />
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-snug text-[var(--text-3)]">
                <span>
                  {about.length} / 20000 字。按原卡读取，超限会提示截断
                  {aboutZh.trim() ? '；译文只给界面看，喂模型用的永远是原文' : ''}。
                </span>
                {zhStale && (
                  <>
                    <span className="text-[#d9534f]">原文改过了，译文还是旧的。</span>
                  </>
                )}
              </div>

              {/* 开场白：卡里存下来了，但**默认不发言** —— 勾了才写进她的私聊第一条。
                  永远显示一行：卡里没有开场白时框是虚的、勾不动，并写明原因，
                  免得用户以为界面漏了按钮。预览按卡里的排版画，默认折成两行。 */}
              <label
                className={`mt-3 flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 ${
                  greetingText ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={greetingOn && Boolean(greetingText)}
                  disabled={!greetingText}
                  onChange={(e) => setGreetingOn(e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--text-2)]">
                    把卡里的开场白放进她的私聊（当作第一条，她说的）
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-3)]">
                    {greetingText
                      ? '默认不勾：不勾就不发言，跟你现在看到的一样。没勾也照样存进档案 —— 以后想用，去角色介绍页点「插入开场白」。'
                      : '这张卡里没有开场白（first_mes 是空的），所以没得放，也勾不了。想让她先开口，导入后在她的私聊里随便发一句就行。'}
                  </span>
                  {greetingText && (
                    <span className="mt-1 block rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
                      <span className="mb-0.5 block text-[11px] text-[var(--text-3)]">开场白预览</span>
                      <RichText
                        html={greetingHtml || greetingText}
                        lines={greetingOpen ? undefined : 2}
                        className="text-[12px] leading-snug text-[var(--text-2)]"
                      />
                      <button
                        type="button"
                        className="chip mt-1"
                        onClick={(e) => {
                          // 别让点「看完整」把勾选框点掉了
                          e.preventDefault()
                          e.stopPropagation()
                          setGreetingOpen((v) => !v)
                        }}
                      >
                        {greetingOpen ? '收起' : '看完整'}
                      </button>
                    </span>
                  )}
                </span>
              </label>
              {(hasCardHtml(greetingSource) || preview.profile.tavernRegexScripts?.length) && <CardHtmlPreview
                html={greetingSource} characterName={name} rules={preview.profile.tavernRegexScripts} title="开场白原始排版" />}
            </div>

            {err && <p className="px-4 pb-1 text-[12px] text-[#d9534f]">{err}</p>}

            <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
              <span className="text-[11px] text-[var(--text-3)]">
                导入后她会出现在「最近聊天」里，单独聊；要进群去成员面板勾。
                {extractState === 'running' || transState === 'running' ? ' · 模型还在跑，不用等它。' : ''}
              </span>
              <button className="btn ghost sm ml-auto" onClick={() => !saving && onClose()} disabled={saving}>
                取消
              </button>
              {hasDup && !forceNew ? (
                <>
                  <button className="btn ghost sm" onClick={() => setForceNew(true)} disabled={saving}>
                    新建第二张
                  </button>
                  <button className="btn sm" onClick={() => onClose()} disabled={saving} title="什么都不做，原来那位一字不动">
                    跳过
                  </button>
                </>
              ) : (
                <button className="btn sm" onClick={() => void commit()} disabled={saving || !name.trim()}>
                  {saving ? '导入中…' : hasDup ? '新建第二张 · 导入' : '导入'}
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
