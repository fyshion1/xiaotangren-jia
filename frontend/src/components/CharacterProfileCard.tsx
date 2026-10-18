import { useEffect, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import { insertTavernCardGreeting } from '../api/cardImport'
import { activeFormId, listForms, resolveForm } from '../lib/forms'
import { extractPalette, firstFrameOf, isGif, paletteGradient } from '../lib/portraitFx'
import { live2dUrl, resolveLive2DAsset } from '../lib/live2dAssets'
import { resolveVrmAsset, vrmUrl } from '../lib/vrmAssets'
import { modelBindingFor } from '../lib/modelBindings'
import { Live2DModelView } from './Live2DModelView'
import { VrmModelView } from './VrmModelView'

type Props = {
  p: CharacterProfile
  onEdit: () => void
  /** 缺省时不渲染「进入小窝」按钮 —— 私人空间里的身份档案不需要（§22）。 */
  onEnterChat?: () => void
  /** 切换形态（§17）。缺省时不渲染形态 chip —— 没配形态的角色保持原样。 */
  onSwitchForm?: (formId: string) => void
  /** 点立绘看高清原图（§19.13）。缺省时立绘不可点 —— 保持原样。 */
  onOpenPortrait?: (src: string) => void
  /** 卡片尾部追加的自定义区块（§22：私人空间用它塞「身份定位 + 删档」）。 */
  extra?: React.ReactNode
}

function Attr({ k, children, priv }: { k: string; children: React.ReactNode; priv?: boolean }) {
  return (
    <div className={`attr ${priv ? 'priv' : ''}`}>
      <div className="k">
        {k}
        {priv && <span className="ml-1.5 opacity-70">🔒</span>}
      </div>
      <div className="v">{children}</div>
    </div>
  )
}

function Chips({ items }: { items: string[] }) {
  return (
    <>
      {items.map((it) => (
        <span key={it} className="chip">
          {it}
        </span>
      ))}
    </>
  )
}

/** 模型没配 / 没加载起来时的兜底卡片（§36）——把「为什么空着」直接写在脸上。 */
function ModelFallback({ emoji, title, detail }: { emoji: string; title: string; detail: string }) {
  return (
    <div className="flex max-w-[260px] flex-col items-center gap-2 px-4 text-center text-[var(--text-3)]">
      <span className="text-[56px] leading-none">{emoji}</span>
      <span className="text-[13px] font-semibold text-[var(--text-2)]">{title}</span>
      <span className="text-[11px] leading-relaxed break-words">{detail}</span>
    </div>
  )
}

export default function CharacterProfileCard({ p, onEdit, onEnterChat, onSwitchForm, onOpenPortrait, extra }: Props) {
  const [showPriv, setShowPriv] = useState(false)
  // 立绘显示方式（§19）：静态 / Live2D 占位 / 3D 占位。用左上角标签里的下拉切换，
  // 不再是「点整张图循环」（那样每次点图都会误切，而且没有提示当前是哪个）。
  const [portraitMode, setPortraitMode] = useState<'image' | 'live2d' | 'vrm'>('image')
  const [modeOpen, setModeOpen] = useState(false)
  // 取色底（§19）：立绘多为不透明整幅图，object-contain 会留生硬直角 ——
  // 量出图里的主色铺成柔和渐变化进背景（参考图那种纵向色带的感觉）。
  const [palette, setPalette] = useState<string[]>([])
  // GIF 只在鼠标移上去时播放（§19）：静止态显示首帧静态图
  const [hovering, setHovering] = useState(false)
  const [firstFrame, setFirstFrame] = useState<string | null>(null)
  // 「关于」看译文还是看原文（导入的酒馆卡才有译文；原文一键可切）
  const [viewRaw, setViewRaw] = useState(false)
  // 「插入开场白」：把档案里存着的那份写成她私聊的第一条（默认不写，用户点了才写）
  const [greetingBusy, setGreetingBusy] = useState(false)
  const [greetingNote, setGreetingNote] = useState('')

  // 形态（§17）：没配形态的角色 = 只有基础形态，chip 不渲染，页面与从前一模一样。
  const forms = listForms(p)
  const hasForms = forms.length > 1
  const curFormId = activeFormId(p)
  const view = resolveForm(p).profile
  const aboutZh = (view.aboutZh || '').trim()
  const greeting = (view.greeting || '').trim()

  // 换了角色就把「看原文 / 插入结果」这些一次性状态收回去，别串台。
  useEffect(() => {
    setViewRaw(false)
    setGreetingNote('')
  }, [p.id])

  /** 「插入开场白」：档案里那份一直躺着，什么时候想用都行。成功后直接进她的私聊。
   *  会话已经聊过时后端会 400（开场白该在最前面），把原话摆出来给用户看。 */
  const insertGreeting = async () => {
    setGreetingBusy(true)
    setGreetingNote('')
    try {
      await insertTavernCardGreeting(p.id)
      setGreetingNote('开场白已经写成她私聊的第一条了 —— 这就去她的私聊看看。')
      onEnterChat?.()
    } catch (e) {
      setGreetingNote(e instanceof Error ? e.message : String(e))
    } finally {
      setGreetingBusy(false)
    }
  }

  const portrait = view.portrait
  const gif = Boolean(portrait && isGif(portrait))

  // 实机模型（§36）：档案里配了 `live2d.model` / `vrm.model` 才能切过去。
  // 没配的角色，下拉里那两项是灰的 —— 不至于切过去只看到一句「没配模型」。
  // 档案没填时再查本机绑定表（lib/modelBindings.ts，素材清单的 key 只在这台机器有意义）。
  const binding = modelBindingFor(p.id)
  const live2dAsset = resolveLive2DAsset(view.live2d?.model ?? binding.live2d)
  const vrmAsset = resolveVrmAsset(view.vrm?.model ?? binding.vrm)
  // 模型自己加载失败（文件缺了 / WebGL 挂了）：退回占位提示，别整张卡片白屏。
  const [modelError, setModelError] = useState<string>('')

  // 换角色 / 换形态 / 换立绘 → 重新量主色与首帧
  useEffect(() => {
    let cancelled = false
    setPalette([])
    setFirstFrame(null)
    setHovering(false)
    setModelError('')
    if (!portrait) return
    void extractPalette(portrait).then((pal) => {
      if (!cancelled && pal?.colors.length) setPalette(pal.colors)
    })
    if (isGif(portrait)) {
      void firstFrameOf(portrait).then((frame) => {
        if (!cancelled) setFirstFrame(frame)
      })
    }
    return () => {
      cancelled = true
    }
  }, [portrait])

  const priv: [string, string][] = [
    ['体重', view.weight],
    ['三围', view.measurements],
    ['秘密', view.secret],
    ['弱点', view.weakPoint],
    ['私密小愿望', view.privateWish],
  ]

  const MODES = [
    { id: 'image' as const, label: '静态图片 / GIF', hint: '显示上传的立绘；GIF 只在鼠标移上去时播放', ready: true },
    {
      id: 'live2d' as const,
      label: 'Live2D（2D）',
      hint: live2dAsset
        ? `${live2dAsset.name} · 点模型会看向鼠标`
        : '这个角色还没配 Live2D 模型（档案里填 live2d.model，见 lib/live2dAssets.ts）',
      ready: Boolean(live2dAsset),
    },
    {
      id: 'vrm' as const,
      label: '3D（VRM）',
      hint: vrmAsset ? `${vrmAsset.name} · 按住拖动可转视角` : '这个角色还没配 VRM 模型（档案里填 vrm.model）',
      ready: Boolean(vrmAsset),
    },
  ]
  const modeLabel = MODES.find((m) => m.id === portraitMode)?.label ?? ''

  return (
    <section
      className="grid overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)] md:grid-cols-[320px_1fr]"
      style={{ gridAutoRows: 'auto' }}
    >
      {/* 左：立绘区。显示方式由左上角标签里的下拉控制（§19），不再点整张图切换 */}
      <div
        className="portrait relative flex min-h-[280px] items-center justify-center overflow-hidden md:min-h-0"
        style={palette.length ? { background: paletteGradient(palette) } : undefined}
      >
        {/* 剩余占区用图自己填：放大 + 重模糊铺满 → 就是「取背景色做滤镜模糊」那层。
            object-cover 保证铺满，blur-3xl 把内容糊成色雾，不会露出直角边。
            GPU 只吃这一张底图；GIF 用首帧静态图，免得底下也在一直播。 */}
        {portraitMode === 'image' && portrait && (
          <img
            src={gif && firstFrame ? firstFrame : portrait}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-0 h-full w-full scale-150 object-cover opacity-60 blur-3xl"
          />
        )}
        {/* 左上角标签 = 下拉选择器（§19） */}
        <div className="absolute left-3.5 top-3.5 z-[6]">
          <button
            type="button"
            onClick={() => setModeOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_85%,transparent)] px-2.5 py-0.5 text-[11px] text-[var(--text-2)] backdrop-blur transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)]"
            title="选择立绘的显示方式"
          >
            {modeLabel}
            <span className={`text-[9px] transition ${modeOpen ? 'rotate-180' : ''}`}>▼</span>
          </button>
          {modeOpen && (
            <>
              {/* 点外面关掉 */}
              <span className="fixed inset-0 z-[4]" onClick={() => setModeOpen(false)} />
              <div className="absolute left-0 top-full z-[5] mt-1 w-[176px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow)]">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={!m.ready}
                    onClick={() => {
                      setPortraitMode(m.id)
                      setModeOpen(false)
                    }}
                    title={m.hint}
                    className={`block w-full px-3 py-1.5 text-left text-[12px] transition enabled:hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-45 ${
                      m.id === portraitMode ? 'font-semibold text-[var(--pink-deep)]' : 'text-[var(--text-2)]'
                    }`}
                  >
                    {m.id === portraitMode ? '✓ ' : ''}
                    {m.label}
                    {!m.ready && <span className="ml-1 text-[10px]">· 未配</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <span className="absolute bottom-2.5 right-3 z-[6] text-[11px] text-[var(--text-3)]">
          {gif && portraitMode === 'image' ? '鼠标移上去播放 GIF' : '待替换实机模型'}
        </span>
        {/* 过渡（§8.6 / §19）：上面那层模糊色雾已经让边缘不硬了，
            这里只再压一层很淡的四周渐隐（左右一样深），避免图的四边留下刀切感。
            旧做法是「下沿一道 45% 的卡片底色渐变」—— 那道边本身就是硬边，所以换掉。 */}
        {portraitMode === 'image' && portrait && (
          <span
            className="pointer-events-none absolute inset-0 z-[3]"
            style={{
              background:
                'radial-gradient(115% 88% at 50% 50%, transparent 58%, color-mix(in srgb, var(--surface) 55%, transparent) 100%)',
            }}
          />
        )}
        {portraitMode === 'image' ? (
          portrait ? (
            /* 点立绘 = 看高清原图（§19.13）。原来右下角那个「查看立绘大图」按钮
               没有任何 onClick，是个死按钮，已删掉 —— 直接点图更直觉。
               object-contain 的框比图大，所以按钮自己不吃点击，只有图那块响应。 */
            <button
              type="button"
              onClick={() => onOpenPortrait?.(portrait)}
              disabled={!onOpenPortrait}
              className="relative z-[2] flex h-full w-full cursor-zoom-in items-center justify-center disabled:cursor-default"
              title="点开看高清原图"
            >
              <img
                src={gif && !hovering && firstFrame ? firstFrame : portrait}
                alt={view.name}
                onMouseEnter={() => setHovering(true)}
                onMouseLeave={() => setHovering(false)}
                className="h-full w-full object-contain drop-shadow-[0_18px_28px_rgba(90,60,40,0.18)]"
              />
            </button>
          ) : (
            <div className="mb-4 text-[130px] leading-none drop-shadow-[0_14px_20px_rgba(140,96,58,0.18)]">{view.emoji}</div>
          )
        ) : portraitMode === 'live2d' ? (
          live2dAsset && !modelError ? (
            /* 实机 Live2D（§36）：模型自己会看鼠标、眨眼、呼吸、播待机动作 */
            <Live2DModelView
              url={live2dUrl(live2dAsset)}
              idleMotion={live2dAsset.idleMotion}
              expression={live2dAsset.expression}
              onError={setModelError}
              className="relative z-[2] h-full w-full"
            />
          ) : (
            <ModelFallback
              emoji="🧍‍♀️"
              title={live2dAsset ? 'Live2D 模型没加载起来' : '还没配 Live2D 模型'}
              detail={
                modelError ||
                '档案里加一段 live2d.model；模型清单见 frontend/src/lib/live2dAssets.ts（素材在仓库根 assets/live2d/）'
              }
            />
          )
        ) : vrmAsset && !modelError ? (
          /* 实机 3D（§36）：three.js + three-vrm，按身高自动入画 + 自己慢慢转圈 */
          <VrmModelView url={vrmUrl(vrmAsset)} onError={setModelError} className="relative z-[2] h-full w-full" />
        ) : (
          <ModelFallback
            emoji="🧊"
            title={vrmAsset ? '3D 模型没加载起来' : '还没配 3D 模型'}
            detail={
              modelError ||
              '档案里加一段 vrm.model；模型清单见 frontend/src/lib/vrmAssets.ts（素材在仓库根 assets/models/vrm/）'
            }
          />
        )}
      </div>

      {/* 右：信息 */}
      <div className="flex flex-col p-6 md:p-7 md:pl-3">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[28px] font-extrabold tracking-wide">
            {view.name}
            <span className="ml-2 text-[15px] font-medium text-[var(--text-3)]">{view.jp}</span>
          </span>
          <span className="text-[14px] font-semibold text-[var(--pink-deep)]">{view.alias}</span>
          {/* 形态 chip（§17）：有多形态时显示在名字栏右侧 */}
          {hasForms && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {forms.map((f) => {
                const active = f.id === curFormId
                return (
                  <button
                    key={f.id}
                    onClick={() => onSwitchForm?.(f.id)}
                    className={`form-chip ${active ? 'on' : ''}`}
                    title={active ? `当前形态：${f.name}` : `切换到：${f.name}`}
                  >
                    {active ? `🎀 ${f.name}` : f.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 关于 = 角色提示词；中文译文只给界面看，原文仍是实际喂给模型的正文 */}
        <div className="mb-4 max-w-[620px]">
          {aboutZh && (
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="eyebrow">关于 · 中文译文</span>
              <button
                type="button"
                className="chip"
                onClick={() => setViewRaw((v) => !v)}
                title={viewRaw ? '切回中文译文' : '查看原文；原文才会喂给模型'}
              >
                {viewRaw ? '看译文' : '看原文'}
              </button>
            </div>
          )}
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--text-2)]">
            {viewRaw || !aboutZh ? view.about : view.aboutZh}
          </p>
        </div>

        {/* 基本词条 */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <Attr k="生日 · 年龄">{`${view.birthday} · ${view.age}`}</Attr>
          <Attr k="身高 / 血型 / 星座">{`${view.height} · ${view.bloodType} · ${view.constellation}`}</Attr>
          <Attr k="职业">{view.occupation}</Attr>
          <Attr k="性格">
            <Chips items={view.personality} />
          </Attr>
          <Attr k="喜好">
            <Chips items={view.likes} />
          </Attr>
          <Attr k="讨厌">
            <Chips items={view.dislikes} />
          </Attr>
          <Attr k="体型">{view.bodyType}</Attr>
          <Attr k="瞳色">{view.eyeColor}</Attr>
          <Attr k="发型">{view.hairstyle}</Attr>
          <Attr k="发色">{view.hairColor}</Attr>
          <Attr k="胸部">{view.bust}</Attr>
          <Attr k="臀部">{view.hip}</Attr>
          <Attr k="服装">{view.clothing}</Attr>
          <Attr k="关系">{view.relationships}</Attr>
          <Attr k="特殊特征">{view.specialFeatures}</Attr>
          <Attr k="口头禅">{view.catchphrase}</Attr>
        </div>

        {/* 个人隐私词条 */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="eyebrow">个人隐私词条</span>
            <span className="rounded-full bg-[var(--pink-soft)] px-2 py-0.5 text-[11px] text-[var(--pink-deep)]">私密</span>
          </div>
          {showPriv ? (
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
              {priv.map(([k, v]) => (
                <Attr key={k} k={k} priv>
                  {v}
                </Attr>
              ))}
            </div>
          ) : (
            <button
              onClick={() => setShowPriv(true)}
              className="rounded-[14px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-3 text-[13px] text-[var(--text-3)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)]"
            >
              🔒 点开查看私密词条
            </button>
          )}
        </div>

        {/* CTA */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {onEnterChat && <button className="btn" onClick={onEnterChat}>进入她的小窝 · 聊天</button>}
          {/* 开场白按钮永远在：档案里没有开场白时按钮是虚的，旁边写明为什么 ——
              不藏起来，免得用户以为这功能没做。 */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn ghost sm"
              onClick={() => void insertGreeting()}
              disabled={!greeting || greetingBusy}
              title={greeting ? '' : '这角色的档案里没有开场白'}
            >
              {greetingBusy ? '插入中…' : '插入开场白'}
            </button>
            {!greeting && (
              <span className="max-w-[360px] text-[11px] leading-snug text-[var(--text-3)]">
                {p.imported
                  ? '档案里没有开场白 —— 这张卡的 first_mes 是空的，或者她是在「存开场白」之前就导入的老卡；重新导一次这张卡才会补进来。'
                  : '档案里没有开场白 —— 家里这几位小糖人本来就没有；自己写一句填进「开场白」就能用。'}
              </span>
            )}
            {greetingNote && <span className="max-w-[360px] text-[11px] leading-snug text-[var(--text-3)]">{greetingNote}</span>}
          </div>
          <button className="btn ghost sm ml-auto" onClick={onEdit}>
            ✎ 编辑资料
          </button>
        </div>

        {/* 私人空间（§22）：身份定位 + 删档，由调用方塞进来 */}
        {extra && <div className="mt-6">{extra}</div>}
      </div>
    </section>
  )
}