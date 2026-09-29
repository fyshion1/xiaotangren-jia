const CELLS = [
  { cls: 't1', emoji: '🌸', cap: '日常 · 烘焙坊', framed: true },
  { cls: 't2', emoji: '🍵', cap: '午后 · 一起喝茶' },
  { cls: 't3', emoji: '🌙', cap: '晚安 · 睡前故事' },
  { cls: 't4', emoji: '🍰', cap: '生日 · 蛋糕' },
  { cls: 't5', emoji: '🎀', cap: '服饰 · 主题换装' },
  { cls: 't6', emoji: '🧣', cap: '冬日 · 围巾' },
]

export default function GalleryGrid() {
  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[20px] font-extrabold tracking-wide">画廊</h2>
        <span className="text-[13px] text-[var(--text-3)]">Gallery · CG / 立绘 · 在个人介绍下方</span>
      </div>
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
        {CELLS.map((c) => (
          <div
            key={c.cap}
            className="relative aspect-[3/4] cursor-pointer overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] shadow-[var(--shadow-sm)] transition hover:-translate-y-1 hover:border-[var(--pink)] hover:shadow-[var(--shadow)]"
          >
            <div className={`absolute inset-0 flex items-center justify-center text-[40px] ${c.cls}`}>{c.emoji}</div>
            {c.framed && (
              <span className="absolute right-2 top-2 flex h-[22px] w-[22px] items-center justify-center rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] text-[11px] text-[var(--text-3)]">
                ♡
              </span>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--text-2)] backdrop-blur">
              {c.cap}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[12px] text-[var(--text-3)]">画廊图均为占位。点击画廊格子可在左半区设为立绘占位图。（对应「参考图：画廊，在个人介绍下面」）</p>
    </section>
  )
}