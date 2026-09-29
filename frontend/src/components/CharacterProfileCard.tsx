import { useState } from 'react'
import type { CharacterProfile } from '../data/characters'

type Props = {
  p: CharacterProfile
  onEdit: () => void
  onEnterChat: () => void
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

export default function CharacterProfileCard({ p, onEdit, onEnterChat }: Props) {
  const [showPriv, setShowPriv] = useState(false)

  const priv: [string, string][] = [
    ['体重', p.weight],
    ['三围', p.measurements],
    ['秘密', p.secret],
    ['弱点', p.weakPoint],
    ['私密小愿望', p.privateWish],
  ]

  return (
    <section
      className="grid overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)] md:grid-cols-[320px_1fr]"
      style={{ gridAutoRows: 'auto' }}
    >
      {/* 左：立绘占位 */}
      <div className="portrait flex min-h-[280px] items-end justify-center md:min-h-0">
        <span className="absolute left-3.5 top-3.5 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] px-2.5 py-0.5 text-[11px] text-[var(--text-2)]">
          Live2D 立绘占位
        </span>
        <span className="absolute bottom-2.5 right-3 text-[11px] text-[var(--text-3)]">兽耳科技风 · 待替换实机模型</span>
        <div className="mb-7 text-[130px] leading-none drop-shadow-[0_14px_20px_rgba(140,96,58,0.18)]">{p.emoji}</div>
      </div>

      {/* 右：信息 */}
      <div className="flex flex-col p-6 md:p-7 md:pl-3">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[28px] font-extrabold tracking-wide">
            {p.name}
            <span className="ml-2 text-[15px] font-medium text-[var(--text-3)]">{p.jp}</span>
          </span>
          <span className="text-[14px] font-semibold text-[var(--pink-deep)]">{p.alias}</span>
        </div>

        {/* 关于 = 角色提示词 */}
        <p className="mb-4 max-w-[620px] text-[15px] leading-relaxed text-[var(--text-2)]">{p.about}</p>

        {/* 基本词条 */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <Attr k="生日 · 年龄">{`${p.birthday} · ${p.age}`}</Attr>
          <Attr k="身高 / 血型 / 星座">{`${p.height} · ${p.bloodType} · ${p.constellation}`}</Attr>
          <Attr k="职业">{p.occupation}</Attr>
          <Attr k="性格">
            <Chips items={p.personality} />
          </Attr>
          <Attr k="喜好">
            <Chips items={p.likes} />
          </Attr>
          <Attr k="讨厌">
            <Chips items={p.dislikes} />
          </Attr>
          <Attr k="体型">{p.bodyType}</Attr>
          <Attr k="瞳色">{p.eyeColor}</Attr>
          <Attr k="发型">{p.hairstyle}</Attr>
          <Attr k="发色">{p.hairColor}</Attr>
          <Attr k="胸部">{p.bust}</Attr>
          <Attr k="臀部">{p.hip}</Attr>
          <Attr k="服装">{p.clothing}</Attr>
          <Attr k="关系">{p.relationships}</Attr>
          <Attr k="特殊特征">{p.specialFeatures}</Attr>
          <Attr k="口头禅">{p.catchphrase}</Attr>
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