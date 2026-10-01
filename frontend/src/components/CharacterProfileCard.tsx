import { useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import { activeFormId, listForms, resolveForm } from '../lib/forms'

type Props = {
  p: CharacterProfile
  onEdit: () => void
  onEnterChat: () => void
  /** 切换形态（§17）。缺省时不渲染形态 chip —— 没配形态的角色卡片保持原样。 */
  onSwitchForm?: (formId: string) => void
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

export default function CharacterProfileCard({ p, onEdit, onEnterChat, onSwitchForm }: Props) {
  const [showPriv, setShowPriv] = useState(false)
  // 立绘三态循环：静态图片/GIF → Live2D（2D）→ 3D（VRM）→ 回到静态。模型后续替换，现在只占位。
  const [portraitMode, setPortraitMode] = useState<'image' | 'live2d' | 'vrm'>('image')

  // 形态（§17）：没配形态的角色 = 只有基础形态，chip 不渲染，页面与从前一模一样。
  const forms = listForms(p)
  const hasForms = forms.length > 1
  const curFormId = activeFormId(p)
  const view = resolveForm(p).profile

  const priv: [string, string][] = [
    ['体重', view.weight],
    ['三围', view.measurements],
    ['秘密', view.secret],
    ['弱点', view.weakPoint],
    ['私密小愿望', view.privateWish],
  ]

  const cyclePortrait = () => {
    setPortraitMode((m) => (m === 'image' ? 'live2d' : m === 'live2d' ? 'vrm' : 'image'))
  }

  const modeBadge =
    portraitMode === 'image' ? '静态图片 / GIF 占位' : portraitMode === 'live2d' ? 'Live2D（2D）占位' : '3D（VRM）占位'

  return (
    <section
      className="grid overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)] md:grid-cols-[320px_1fr]"
      style={{ gridAutoRows: 'auto' }}
    >
      {/* 左：立绘占位 */}
      <button type="button" onClick={cyclePortrait} className="portrait relative flex min-h-[280px] items-center justify-center overflow-hidden md:min-h-0" title="点击切换立绘：静态/GIF → Live2D → 3D">
        <span className="absolute left-3.5 top-3.5 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] px-2.5 py-0.5 text-[11px] text-[var(--text-2)]">
          {modeBadge}
        </span>
        <span className="absolute bottom-2.5 right-3 text-[11px] text-[var(--text-3)]">点击切换 · 待替换实机模型</span>
        {portraitMode === 'image' ? (
          view.portrait ? (
            <img src={view.portrait} alt={view.name} className="pointer-events-none h-full w-full object-contain" />
          ) : (
            <div className="mb-4 text-[130px] leading-none drop-shadow-[0_14px_20px_rgba(140,96,58,0.18)]">{view.emoji}</div>
          )
        ) : portraitMode === 'live2d' ? (
          <div className="flex flex-col items-center gap-2 text-[var(--text-3)]">
            <span className="text-[64px] leading-none">🧍‍♀️</span>
            <span className="text-[12px]">Live2D 模型占位 · 后续接入 pixi-live2d-display</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-[var(--text-3)]">
            <span className="text-[64px] leading-none">🧊</span>
            <span className="text-[12px]">VRM 3D 模型占位 · 后续 three.js + three-vrm</span>
          </div>
        )}
      </button>

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

        {/* 关于 = 角色提示词 */}
        <p className="mb-4 max-w-[620px] text-[15px] leading-relaxed text-[var(--text-2)]">{view.about}</p>

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
          <button className="btn" onClick={onEnterChat}>进入她的小窝 · 聊天</button>
          <button className="btn ghost">查看立绘大图</button>
          <button className="btn ghost sm ml-auto" onClick={onEdit}>
            ✎ 编辑资料
          </button>
        </div>
      </div>
    </section>
  )
}