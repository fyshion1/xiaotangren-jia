import { useEffect, useMemo, useState } from 'react'
import { cardDocument } from '../lib/cardHtml'
import { renderCardDisplay, type CardDisplayRule, type DisplayResult } from '../lib/cardDisplay'

/** Card styles and scripts are confined to an opaque-origin sandbox. */
type Props = {
  html: string; title?: string; defaultOpen?: boolean
  rules?: CardDisplayRule[]; depth?: number
  characterName?: string
}

export default function CardHtmlPreview(props: Props) {
  // A different source starts with scripts disabled, even when React reuses the view.
  return <Preview key={`${props.html}:${JSON.stringify(props.rules || [])}:${props.depth || 0}`} {...props} />
}

function Preview({ html, title = '卡片原始排版', defaultOpen = false, rules, depth = 0, characterName }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const [interactive, setInteractive] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [result, setResult] = useState<DisplayResult | null>(null)
  const hasRules = Boolean(rules?.length)
  useEffect(() => {
    if (!open || !rules?.length) return
    const controller = new AbortController()
    void renderCardDisplay(html, rules, depth, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult(value)
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ html, applied: 0, warnings: [String(error.message || error)] })
    })
    return () => controller.abort()
  }, [open, html, rules, depth])
  const document = useMemo(() => cardDocument(result?.html ?? html, interactive, { theme, characterName }), [result, html, interactive, theme, characterName])
  return <section className="my-2 space-y-2 rounded-xl border border-[var(--border)] p-2">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {open ? `收起${title}` : `查看${title}`}
      </button>
      {open && <>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={interactive}
          onChange={e => setInteractive(e.target.checked)} />启用卡内交互脚本</label>
        <button type="button" className="chip" onClick={() => setRevision(v => v + 1)}>重置预览</button>
        <button type="button" className="chip" onClick={() => setExpanded(v => !v)}>{expanded ? '缩小预览' : '放大预览'}</button>
        <button type="button" className="chip" onClick={() => setTheme(v => v === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '切换浅色底' : '切换深色底'}
        </button>
      </>}
    </div>
    {open && <>
      <p className="text-[11px] text-[var(--text-3)]">显示卡内样式与图片，外链素材需要联网。交互脚本默认关闭；不接入酒馆变量或聊天接口。</p>
      {hasRules && <p className="text-[11px] text-[var(--text-3)]">{result ? `卡内 ${rules!.length} 条显示规则，本次应用 ${result.applied} 条。` : '正在应用卡内显示规则…'}</p>}
      {result?.warnings.map((warning, i) => <p key={i} role="status" className="text-xs">{warning}</p>)}
      {(!hasRules || result) && <iframe key={`${interactive}:${revision}`} title={title} srcDoc={document}
        sandbox={interactive ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
        className="w-full rounded-lg border-0 bg-white" style={{ height: expanded ? '72vh' : 360 }} />}
    </>}
  </section>
}
