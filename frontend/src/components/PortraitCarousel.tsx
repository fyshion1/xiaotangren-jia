// 聊天右栏顶部的立绘轮播（《项目要求》§19 / 参考图）。
// 图源 = 立绘（形态可覆盖）+ 该角色的画廊图；群聊里每位成员各一组，上方有成员 chip。
// 一张图都没有 → 整块不渲染，右栏保持原样。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import { resolveForm } from '../lib/forms'
import { fetchGallery } from '../api/gallery'
import Avatar from './Avatar'

type Props = {
  /** 本会话在场的角色（群聊全部，私聊只有一位）。 */
  characters: CharacterProfile[]
  /** 点主图看原图 —— 复用 ChatView 的 lightbox。 */
  onOpenImage: (src: string) => void
}

type Slide = { src: string; tag: string; orig: string }
/** 画廊一张图的两个地址：缩略图给轮播看，原图给 lightbox 看（§19.13）。 */
type GallerySlide = { thumb: string; orig: string }

export default function PortraitCarousel({ characters, onOpenImage }: Props) {
  const [idx, setIdx] = useState(0)
  const [gallery, setGallery] = useState<Record<string, GallerySlide[]>>({})
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const bioRef = useRef<HTMLParagraphElement>(null)

  const ids = characters.map((c) => c.id).join(',')

  // 每位角色的画廊图。缩略图和原图都要留着：条带里显示 thumb（快、省流量），
  // 点开看大图时给原图（§19.13 —— 以前传的是 thumb，点开还是糊的）。
  useEffect(() => {
    let cancelled = false
    Promise.all(
      characters.map((c) =>
        fetchGallery(c.id)
          .then(
            (rows) =>
              [
                c.id,
                rows
                  .map((g) => ({ thumb: g.thumb || g.orig, orig: g.orig || g.thumb }))
                  .filter((s) => Boolean(s.thumb)),
              ] as const,
          )
          .catch(() => [c.id, [] as GallerySlide[]] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setGallery(Object.fromEntries(pairs))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])

  // 幻灯片 = [立绘] + [画廊图]，按角色分块（群聊里每位成员一段）。
  const groups = useMemo(() => {
    return characters
      .map((c) => {
        const form = resolveForm(c).profile
        const slides: Slide[] = []
        // 立绘本身就是原图，src 和 orig 同一个
        if (form.portrait) slides.push({ src: form.portrait, tag: '立绘', orig: form.portrait })
        for (const g of gallery[c.id] ?? []) slides.push({ src: g.thumb, tag: '画廊', orig: g.orig })
        return { c, slides }
      })
      .filter((g) => g.slides.length > 0)
  }, [characters, gallery])

  const all = useMemo(() => groups.flatMap((g) => g.slides), [groups])
  const cur = all[Math.min(idx, all.length - 1)]

  // 切换角色 / 换会话后下标可能越界
  useEffect(() => {
    if (idx >= all.length) setIdx(0)
  }, [all.length, idx])

  // 简介溢出测量：别按字数猜（§19），量出来才准。
  useEffect(() => {
    setExpanded(false)
    const el = bioRef.current
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [cur?.src, characters])

  if (!all.length || !cur) return null

  const step = (d: number) => setIdx((v) => (v + d + all.length) % all.length)
  // 当前选中项落在哪一组 —— 群聊里用它高亮成员 chip
  let acc = 0
  let activeGroup = groups[0]?.c.id
  for (const g of groups) {
    if (idx < acc + g.slides.length) {
      activeGroup = g.c.id
      break
    }
    acc += g.slides.length
  }
  const curChar = characters.find((c) => c.id === activeGroup)
  const bio = curChar ? resolveForm(curChar).profile.about : ''

  return (
    <div className="shrink-0 border-b border-[var(--border)] p-3">
      {/* 群聊：成员 chip，点谁切到谁的第一张（单聊不出现） */}
      {characters.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {groups.map((g) => (
            <button
              key={g.c.id}
              onClick={() => {
                const at = groups.slice(0, groups.indexOf(g)).reduce((n, x) => n + x.slides.length, 0)
                setIdx(at)
              }}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition ${
                g.c.id === activeGroup
                  ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                  : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-3)] hover:border-[var(--pink)]'
              }`}
            >
              <Avatar name={g.c.name} avatar={g.c.avatar} emoji={g.c.emoji} size={18} />
              {g.c.name}
            </button>
          ))}
        </div>
      )}

      <div className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
        {/* 剩余占区用图自己填（§19）：立绘多为竖幅，横向铺满、纵向照着原比例长，
            上下露出的那点空白用同图放大模糊补上，别留生硬直角。
            以前写死 aspect-[3/4] + object-cover，竖幅立绘会被上下各切掉一截。 */}
        <img
          src={cur.src}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-55 blur-2xl"
        />
        <button type="button" onClick={() => onOpenImage(cur.orig)} className="relative block w-full" title="点开看大图">
          <img src={cur.src} alt={cur.tag} className="block max-h-[52vh] w-full object-contain" />
        </button>
        <span className="absolute right-2 top-2 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] px-2 py-0.5 text-[11px] text-[var(--text-2)] backdrop-blur">
          {idx + 1}/{all.length}
        </span>
        <span className="absolute left-2 top-2 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)] px-2 py-0.5 text-[11px] text-[var(--text-3)] backdrop-blur">
          {cur.tag}
        </span>
        {all.length > 1 && (
          <>
            <button
              onClick={() => step(-1)}
              title="上一张"
              className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_78%,transparent)] px-2 py-1 text-[12px] text-[var(--text-2)] backdrop-blur transition hover:text-[var(--pink-deep)]"
            >
              ◀
            </button>
            <button
              onClick={() => step(1)}
              title="下一张"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_78%,transparent)] px-2 py-1 text-[12px] text-[var(--text-2)] backdrop-blur transition hover:text-[var(--pink-deep)]"
            >
              ▶
            </button>
          </>
        )}
      </div>

      {/* 缩略图条：点一张直接跳过去 */}
      {all.length > 1 && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {all.map((s, i) => (
            <button
              key={`${s.src}-${i}`}
              onClick={() => setIdx(i)}
              title={s.tag}
              className={`h-11 w-11 shrink-0 overflow-hidden rounded-lg border transition ${
                i === idx ? 'border-[var(--pink)] ring-1 ring-[var(--pink)]' : 'border-[var(--border)] opacity-70 hover:opacity-100'
              }`}
            >
              <img src={s.src} alt={s.tag} className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      {/* 简介：从个人介绍里提取，太长就收纳（§19） */}
      {bio && (
        <div className="mt-2">
          <p
            ref={bioRef}
            className={`text-[12px] leading-relaxed text-[var(--text-2)] ${expanded ? '' : 'line-clamp-3'}`}
          >
            {bio}
          </p>
          {overflowing && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[11px] text-[var(--text-3)] transition hover:text-[var(--pink-deep)]"
            >
              {expanded ? '收起 ▲' : '展开 ▼'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}