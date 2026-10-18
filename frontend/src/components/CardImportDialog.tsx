/**
 * 酒馆角色卡导入浮层（聊天 · 会话列表底部的「🎴 导入角色卡（酒馆）」）。
 *
 * **快慢分开**（用户实测后拍板）：读卡 + 拼「关于」是纯本地活儿（毫秒级），
 * 所有慢的都在「叫模型」上 —— 所以预览先出画面（立绘 / 名字 / 关于立刻能看），
 * 词条抽取与中文译文各自走后一个请求，回来一样填一样。用户不必盯着转圈等模型。
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
  extractTavernCard,
  previewTavernCard,
  translateTavernCard,
  type CardImportRoute,
  type CardPreview,
} from '../api/cardImport'

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
  const [extracting, setExtracting] = useState(false)
  const [aboutZh, setAboutZh] = useState('')
  const [translating, setTranslating] = useState(false)
  const [aiWarnings, setAiWarnings] = useState<string[]>([])
  // 「关于」看译文还是看原文（默认看译文，可改的仍是原文）
  const [viewMode, setViewMode] = useState<'zh' | 'raw'>('zh')
  // 用户动过的键：后到的抽取结果不许盖掉手改的值
  const touched = useRef<Set<string>>(new Set())
  // 译文是对着哪份原文翻的（原文改过 → 译文过期，提示可重翻）
  const translatedFrom = useRef('')
  // 开场白要不要写进私聊第一条（默认不勾 —— 不勾就是你现在看到的没广告的样子）
  const [greetingOn, setGreetingOn] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    touched.current = new Set()
    translatedFrom.current = ''
    setExtracted({})
    setAboutZh('')
    setAiWarnings([])
    setViewMode('zh')
    setGreetingOn(false)
    setForceNew(false)
    // 读卡是本地活儿，这一步毫秒级 —— 词条与译文随后自己到（见下一个 effect）。
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
    }
    // route 是每次渲染新建的对象字面量，进依赖会无限重读卡 —— 只看 file 与上游的三个值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, route?.baseUrl, route?.apiKey, route?.model])

  // 画面出来之后再叫模型 —— 两件事互不等待，各自回来各自填。
  useEffect(() => {
    if (!preview) return
    let alive = true
    const src = (preview.profile.about as string) || ''

    setExtracting(true)
    extractTavernCard(file, route)
      .then((r) => {
        if (!alive) return
        setExtracted(r.fields || {})
        if (r.warnings?.length) setAiWarnings((w) => [...w, ...r.warnings])
        // 用户已经手改过的项不许被盖（比如他刚把别名清空了）
        if (!touched.current.has('alias') && r.fields?.alias) setAlias(String(r.fields.alias))
        if (!touched.current.has('name') && r.fields?.name) setName(String(r.fields.name))
      })
      .catch((e) => alive && setAiWarnings((w) => [...w, `自动解析词条没成功（${e}）—— 不影响导入，落库后可以手动补。`]))
      .finally(() => alive && setExtracting(false))

    if (src.trim()) {
      setTranslating(true)
      translateTavernCard(src, route)
        .then((r) => {
          if (!alive) return
          translatedFrom.current = src
          setAboutZh(r.aboutZh || '')
          if (r.warnings?.length) setAiWarnings((w) => [...w, ...r.warnings])
        })
        .catch((e) => alive && setAiWarnings((w) => [...w, `中文译文没翻成（${e}）—— 不影响导入，界面继续看原文。`]))
        .finally(() => alive && setTranslating(false))
    }

    return () => {
      alive = false
    }
    // 同上：只认 file + 上游三个值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, file, route?.baseUrl, route?.apiKey, route?.model])

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
      onImported(saved)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // 改过原文 → 手上这份译文就过期了，提示一下，顺手给个重翻的按钮
  const retranslate = async () => {
    setTranslating(true)
    setAiWarnings((w) => w.filter((x) => !x.startsWith('中文译文没翻成')))
    try {
      const r = await translateTavernCard(about, route)
      translatedFrom.current = about
      setAboutZh(r.aboutZh || '')
      if (r.warnings?.length) setAiWarnings((w) => [...w, ...r.warnings])
    } catch (e) {
      setAiWarnings((w) => [...w, `中文译文没翻成（${e}）—— 不影响导入，界面继续看原文。`])
    } finally {
      setTranslating(false)
    }
  }

  const aboutText = about.trim()
  const card = preview ? { ...preview.profile, ...extracted } : undefined
  const greetingText = ((preview?.profile.greeting as string) || '').trim()
  const zhStale = Boolean(aboutZh.trim()) && about.trim() !== translatedFrom.current.trim()
  const showingZh = viewMode === 'zh' && Boolean(aboutZh.trim())
  const allWarnings = [...(preview?.warnings ?? []), ...aiWarnings]

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
            <span className="text-[11px] text-[var(--text-3)]">只读卡，立绘和「关于」马上就到；词条和译文随后自己填进来。</span>
          </div>
        ) : !preview ? (
          <div className="px-4 py-10 text-center text-[13px] text-[#d9534f]">{err || '这张卡读不出来'}</div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {/* 卡的信息一行 */}
              <p className="mb-3 text-[11px] leading-snug text-[var(--text-3)]">
                {preview.spec || '角色卡'}
                {preview.creator ? ` · 作者 ${preview.creator}` : ''}
                {preview.tags.length > 0 ? ` · ${preview.tags.slice(0, 6).join(' / ')}` : ''}
                {greetingText ? ' · 卡里带开场白（存下来，默认不发言）' : ''}
              </p>

              {/* 后填的两件事：正在补什么，明说 —— 别让人以为卡住了 */}
              {(extracting || translating) && (
                <p className="mb-3 animate-pulse text-[11px] leading-snug text-[var(--text-3)]">
                  正在
                  {extracting ? '从原文里抽词条' : ''}
                  {extracting && translating ? '、' : ''}
                  {translating ? '翻一份中文译文' : ''}
                  …（各要几秒，回来自己填进来，这个框不用等）
                </p>
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
                    家里已经有一位叫「{name.trim() || preview.duplicates[0].name}」了
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

              {/* 抽出来的词条：只读一览（模型回来之后才铺满） */}
              {(LIST_ROWS.some(([k]) => (card?.[k as keyof typeof card] as string[])?.length) ||
                SHOW_ROWS.some(([k]) => (card?.[k as keyof typeof card] as string)?.trim())) && (
                <div className="mt-3 rounded-xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-3">
                  <div className="mb-1.5 text-[12px] font-semibold text-[var(--pink-deep)]">
                    从原文里抽出来的词条（一个字都没编，原文没写的留空）
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

              {/* 关于：喂给模型的正文，原文照搬。译文只是摆着好读，切回来就是原文。 */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-[var(--text-2)]">关于（喂给模型的人设正文）</span>
                {aboutZh.trim() && (
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      className={`chip ${showingZh ? 'ring-1 ring-[var(--pink)]' : 'opacity-70'}`}
                      onClick={() => setViewMode('zh')}
                      title="中文译文 —— 只给你看，喂模型用的还是原文"
                    >
                      中文译文
                    </button>
                    <button
                      className={`chip ${!showingZh ? 'ring-1 ring-[var(--pink)]' : 'opacity-70'}`}
                      onClick={() => setViewMode('raw')}
                      title="原文 —— 进档案、喂给模型的就是它"
                    >
                      原文（可改）
                    </button>
                  </div>
                )}
              </div>
              {showingZh ? (
                <div className="input mt-1 h-40 overflow-y-auto whitespace-pre-wrap bg-[var(--surface-2)] text-[13px] leading-relaxed text-[var(--text-2)]">
                  {aboutZh}
                </div>
              ) : (
                <textarea
                  className="input mt-1 h-40 resize-y font-[inherit] leading-relaxed"
                  value={about}
                  onChange={(e) => {
                    touched.current.add('about')
                    setAbout(e.target.value)
                  }}
                />
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-snug text-[var(--text-3)]">
                <span>
                  {aboutText.length} 字。卡里怎么写的就怎么进来 —— 原作的内容不动
                  {aboutZh.trim() ? '；译文只给界面看，喂模型用的永远是原文' : ''}。
                </span>
                {zhStale && (
                  <>
                    <span className="text-[#d9534f]">原文改过了，译文还是旧的。</span>
                    <button className="chip" onClick={() => void retranslate()} disabled={translating}>
                      {translating ? '重翻中…' : '重新翻译'}
                    </button>
                  </>
                )}
                {!aboutZh.trim() && aboutText && (
                  <button className="chip" onClick={() => void retranslate()} disabled={translating}>
                    {translating ? '翻译中…' : '要一份中文译文'}
                  </button>
                )}
              </div>

              {/* 开场白：卡里存下来了，但**默认不发言** —— 勾了才写进她的私聊第一条。
                  永远显示一行：卡里没有开场白时框是虚的、勾不动，并写明原因，
                  免得用户以为界面漏了按钮。 */}
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
                    <span className="mt-1 line-clamp-2 block text-[11px] leading-snug text-[var(--text-3)]">
                      开场白：{greetingText}
                    </span>
                  )}
                </span>
              </label>
            </div>

            {err && <p className="px-4 pb-1 text-[12px] text-[#d9534f]">{err}</p>}

            <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
              <span className="text-[11px] text-[var(--text-3)]">
                导入后她会出现在「最近聊天」里，单独聊；要进群去成员面板勾。
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