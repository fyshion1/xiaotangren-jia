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
  // 不在这里过滤空组（§19.21）：以前会把「没立绘也没画廊」的成员整组丢掉，
  // 群聊里只剩有图的那位，chip 也不出现 —— 看着像「只做了大诗音」。空组下面补占位格。
  const groups = useMemo(() => {
    return characters.map((c) => {
      const form = resolveForm(c).profile
      const slides: Slide[] = []
      // 立绘本身就是原图，src 和 orig 同一个
      if (form.portrait) slides.push({ src: form.portrait, tag: '立绘', orig: form.portrait })
      for (const g of gallery[c.id] ?? []) slides.push({ src: g.thumb, tag: '画廊', orig: g.orig })
      return { c, slides }
    })
  }, [characters, gallery])

  // 每位成员在 all 里占的格数：没图的成员也占一格（占位格），所以下限是 1。
  // 取组的起点和判断当前下标属于哪组都必须用同一个口径（§19.21）——
  // 以前 chip 按 slides.length 累加、all 却按 max(1, len) 展开，两者错位。
  const span = (g: (typeof groups)[number]) => Math.max(1, g.slides.length)
  const groupStart = (i: number) => groups.slice(0, i).reduce((n, g) => n + span(g), 0)

  const all = useMemo(
    () => groups.flatMap((g) => (g.slides.length ? g.slides : [{ src: '', tag: '暂无', orig: '' }])),
    [groups],
  )
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
    if (idx < acc + span(g)) {
      activeGroup = g.c.id
      break
    }
    acc += span(g)
  }
  const curChar = characters.find((c) => c.id === activeGroup)
  const bio = curChar ? resolveForm(curChar).profile.about : ''

  return (
    <div className="shrink-0 border-b border-[var(--border)] p-3">
      {/* 群聊：成员 chip，点谁切到谁的第一张（单聊不出现） */}
      {characters.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {groups.map((g, i) => (
            <button
              key={g.c.id}
              onClick={() => setIdx(groupStart(i))}
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
          {cur.src ? (
            <>
              <img
                src={cur.src}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-55 blur-2xl"
              />
              <button
                type="button"
                onClick={() => onOpenImage(cur.orig)}
                className="relative block w-full"
                title="点开看大图"
              >
                <img src={cur.src} alt={cur.tag} className="block max-h-[52vh] w-full object-contain" />
              </button>
            </>
          ) : (
            /* 占位格（§19.21）：这位既没立绘也没画廊图。
               以前整组被丢掉，群聊里只剩有图的那位，看着像「只给大诗音做了立绘」。
               这里给他留一格，切过来能看见「还没图」而不是一张裂图。 */
            <div className="flex h-[180px] flex-col items-center justify-center gap-1 text-[var(--text-3)]">
              <Avatar name={curChar?.name ?? ''} avatar={curChar?.avatar} emoji={curChar?.emoji} size={44} />
              <span className="text-[13px] text-[var(--text-2)]">{curChar?.name ?? '这位小糖人'}</span>
              <span className="text-[11px]">还没有立绘或画廊图</span>
            </div>
          )}
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

        {/* 缩略图条：点一张直接跳过去。占位格（src 为空）不放缩略图。 */}
        {all.filter((s) => s.src).length > 1 && (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {all.map((s, i) =>
              s.src ? (
                <button
                  key={`${s.src}-${i}`}
                  onClick={() => setIdx(i)}
                  title={s.tag}
                  className={`h-11 w-11 shrink-0 overflow-hidden rounded-lg border transition ${
                    i === idx
                      ? 'border-[var(--pink)] ring-1 ring-[var(--pink)]'
                      : 'border-[var(--border)] opacity-70 hover:opacity-100'
                  }`}
                >
                  <img src={s.src} alt={s.tag} className="h-full w-full object-cover" />
                </button>
              ) : (
                <div
                  key={`empty-${i}`}
                  title="暂无图"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--border-strong)] text-[10px] text-[var(--text-3)]"
                >
                  暂无
                </div>
              ),
            )}
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
