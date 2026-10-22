import { useEffect, useMemo, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import { renderCardDisplay } from '../lib/cardDisplay'
import { cardDocument, hasCardHtml } from '../lib/cardHtml'
import { plainText, toRichNodes } from '../lib/richText'
import KnowledgeText from './KnowledgeText'

/** Rendering is a view over stored text; the iframe cannot access the host. */
export default function CardChatMessage({ text, character, mode, depth, streaming }: {
  text: string; character?: CharacterProfile; mode: 'chat' | 'html'; depth: number; streaming: boolean
}) {
  const source = mode === 'html' && character?.greeting === text
    ? character.greetingSource || character.greetingHtml || text : text
  const [result, setResult] = useState<{ source: string; html: string; warnings: string[] } | null>(null)
  const rules = character?.tavernRegexScripts
  const styles = useMemo(() => {
    const document = new DOMParser().parseFromString(character?.greetingSource || character?.greetingHtml || '', 'text/html')
    return Array.from(document.querySelectorAll('style, link[rel="stylesheet"]')).map(node => node.outerHTML).join('\n')
  }, [character?.greetingSource, character?.greetingHtml])
  useEffect(() => {
    if (mode !== 'html' || streaming || !rules?.length) return
    const controller = new AbortController()
    void renderCardDisplay(source, rules, depth, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ source, ...value })
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ source, html: source, warnings: [String(error.message || error)] })
    })
    return () => controller.abort()
  }, [source, mode, streaming, rules, depth])
  const rendered = result?.source === source ? result : null
  const html = rendered?.html ?? source
  if (mode === 'chat' || streaming || (!hasCardHtml(html) && !rules?.length)) {
    const visible = hasCardHtml(text) ? plainText(toRichNodes(text.replace(/```(?:html)?\s*\n([\s\S]*?)```/gi, '$1'))) : text
    return <div className="whitespace-pre-wrap"><KnowledgeText text={visible} /></div>
  }
  return <div className="min-w-0 space-y-1">
    {rendered?.warnings.map((warning, i) => <p key={i} role="status" className="text-xs">{warning}</p>)}
    {rules?.length && !rendered ? <p role="status" className="text-xs">正在加载卡内样式…</p> :
      <iframe title="角色卡消息" sandbox="" referrerPolicy="no-referrer"
        srcDoc={cardDocument(`${styles}\n${html}`, false, { theme: 'dark', characterName: character?.name })}
        className="w-full border-0" style={{ height: 'min(60vh, 560px)', minHeight: 280 }} />}
  </div>
}
