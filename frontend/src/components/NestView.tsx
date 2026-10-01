// 糖人小窝（《项目要求》§9.6）：全家共同的回忆 + 以后要接的互动入口。
// 现在只有「共同回忆 · 画廊」（归属为「家 · 共用」的那部分，见 §9.4）是真的；
// 小游戏 / Unity 互动小家是占位卡片，点开只弹「规划中」，不做假功能。

import { useState } from 'react'
import GalleryGrid from './GalleryGrid'

const PLACEHOLDERS = [
  {
    emoji: '🎮',
    title: '一起玩的小游戏',
    desc: '谁是卧底 / 你画我猜 / 猜谜 —— 让小糖人们真的一起玩，而不只是聊到。',
    tag: '规划中',
  },
  {
    emoji: '🏡',
    title: '互动小家（Unity 渲染）',
    desc: '把「家」渲染成一个能走动的三维场景，小糖人在里面各有各的房间。',
    tag: '规划中',
  },
]

export default function NestView() {
  const [toast, setToast] = useState('')

  const plan = (what: string) => {
    setToast(`${what}还在规划中 —— 先把画廊和聊天养厚，再来盖这间屋子 🏡`)
    setTimeout(() => setToast(''), 4000)
  }

  return (
    <main className="mx-auto max-w-6xl overflow-y-auto px-4 pb-16 pt-5">
      <header className="mb-6">
        <h1 className="text-[26px] font-extrabold tracking-wide">🏠 糖人小窝</h1>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">
          全家的共同回忆。每个人的专属画廊在各自的角色介绍页里；这里只放「家 · 共用」的那部分。
        </p>
      </header>

      {toast && (
        <div className="mb-4 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[13px] text-[var(--pink-deep)]">
          {toast}
        </div>
      )}

      <section className="mb-10 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {PLACEHOLDERS.map((p) => (
          <button
            key={p.title}
            type="button"
            onClick={() => plan(p.title)}
            className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-5 text-left transition hover:border-[var(--pink)]"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[22px]">{p.emoji}</span>
              <span className="text-[15px] font-bold text-[var(--text)]">{p.title}</span>
              <span className="ml-auto rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-3)]">
                {p.tag}
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-[var(--text-2)]">{p.desc}</p>
          </button>
        ))}
      </section>

      {/* 共同回忆 · 画廊：只看 owner='' 的那些（全家共用） */}
      <GalleryGrid owner="" variant="home" />
    </main>
  )
}
