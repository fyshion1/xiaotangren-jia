// 小窝 · 功能动态流（§9.6）。
//
// 独立功能（B站小糖人刷到的视频、QQ 里聊到的…）通过 `POST /api/nest/feed` 把**给人看的产出**
// 推进来，这里渲染成卡片。后端只当中转站，不解释 payload —— 卡片长什么样由 `kind` 决定：
//   video → 封面 + 标题 + 一句推荐语 + 外链
//   其余  → 标题 + 简述（note 等）
// 大老大的反馈（收藏 / 不感兴趣）写回 status，功能项目可以去读回来当信号。

import { useEffect, useState } from 'react'
import {
  fetchNestFeed,
  setNestFeedStatus,
  deleteNestFeedItem,
  type NestFeedItem,
  type NestFeature,
} from '../api/client'

const STATUS_LABEL: Record<NestFeedItem['status'], string> = {
  new: '新', seen: '看过', saved: '收藏', dismissed: '不感兴趣',
}

function FeedCard({ item, onChanged }: { item: NestFeedItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)

  const act = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try { await fn(); onChanged() } finally { setBusy(false) }
  }

  return (
    <article className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      {item.cover ? (
        <img src={item.cover} alt="" loading="lazy"
          className="h-20 w-32 shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[22px]">
          {item.kind === 'video' ? '📺' : '📝'}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <b className="min-w-0 flex-1 text-[14px] leading-snug text-[var(--text)]">{item.title}</b>
          {item.status !== 'new' && (
            <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">
              {STATUS_LABEL[item.status]}
            </span>
          )}
        </div>
        {item.summary && <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-2)]">{item.summary}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          {item.url && (
            <a className="text-[var(--pink-deep)] underline" href={item.url} target="_blank" rel="noreferrer noopener"
              onClick={() => void act(() => setNestFeedStatus(item.id, 'seen'))}>去看看 ↗</a>
          )}
          <span className="text-[var(--text-3)]">{item.feature_id} · {item.created_at}</span>
          <span className="ml-auto flex gap-1.5">
            <button className="btn ghost sm" disabled={busy}
              onClick={() => void act(() => setNestFeedStatus(item.id, item.status === 'saved' ? 'seen' : 'saved'))}>
              {item.status === 'saved' ? '★ 已收藏' : '☆ 收藏'}
            </button>
            <button className="btn ghost sm" disabled={busy}
              onClick={() => void act(() => setNestFeedStatus(item.id, 'dismissed'))}>不感兴趣</button>
            <button className="btn ghost sm" disabled={busy}
              onClick={() => void act(async () => { await deleteNestFeedItem(item.id) })}>删</button>
          </span>
        </div>
      </div>
    </article>
  )
}

// bare：由外面的抽屉提供卡片和标题（§9.6 布局改造），这里只出内容。
export default function NestFeedPanel({ features, bare = false }: { features: NestFeature[]; bare?: boolean }) {
  const [items, setItems] = useState<NestFeedItem[]>([])
  const [filter, setFilter] = useState('')  // '' = 全部
  const [busy, setBusy] = useState(false)

  const load = () => {
    setBusy(true)
    void fetchNestFeed({ featureId: filter || undefined, limit: 60 })
      .then(setItems).catch(() => setItems([]))
      .finally(() => setBusy(false))
  }
  useEffect(load, [filter])

  // 只有真的推过东西的功能才出现在筛选条里，避免一排空按钮。
  const activeIds = Array.from(new Set(items.map((i) => i.feature_id)))
  const chips = features.filter((f) => activeIds.includes(f.id) || f.id === filter)

  return (
    <section className={bare ? '' : 'mb-8'}>
      {!bare && (
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-[20px] font-extrabold tracking-wide">📬 小糖人找到了什么</h2>
          <span className="text-[13px] text-[var(--text-3)]">功能推回来的东西都在这 · 收藏/不感兴趣会写回给功能</span>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <button className={`form-chip ${filter === '' ? 'on' : ''}`} onClick={() => setFilter('')}>全部</button>
        {chips.map((f) => (
          <button key={f.id} className={`form-chip ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.emoji} {f.name}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] p-5 text-[13px] text-[var(--text-3)]">
          {busy ? '读取中…' : '还没有东西。功能是独立项目，跑起来后会把刷到的、聊到的推到这里（POST /api/nest/feed）。'}
        </div>
      ) : (
        <div className="space-y-2.5">{items.map((i) => <FeedCard key={i.id} item={i} onChanged={load} />)}</div>
      )}

      {/* 「一起看」占位（§9.6.3）：只留位置和接口口子，实时逐帧 token 太贵，不做。 */}
      <div className="mt-3 rounded-2xl border border-dashed border-[var(--border-strong)] px-4 py-3 text-[12px] text-[var(--text-3)]">
        👀 <b>一起看</b>（占位）—— 想「和小糖人同步看视频」的话，走的是同一条 <code>/api/nest/chat</code> 带图口子
        （帧以 data URL 传，≤8 张）。实时逐帧目前不做，太贵。
      </div>
    </section>
  )
}