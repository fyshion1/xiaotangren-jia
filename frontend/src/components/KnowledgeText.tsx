import { Fragment } from 'react'

/** Only first-party knowledge citations become links; arbitrary HTML stays text. */
export default function KnowledgeText({ text }: { text: string }) {
  const pattern = /\[([^\]\n]{1,100})\]\((\/api\/knowledge\/citations\/kd-[a-f0-9]{32}:[a-f0-9]{16})\)/g
  const nodes = []
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    nodes.push(<Fragment key={`t${match.index}`}>{text.slice(offset, match.index)}</Fragment>)
    nodes.push(<a key={`a${match.index}`} href={match[2]} target="_blank" rel="noreferrer" className="underline text-[var(--pink-deep)]">{match[1]}</a>)
    offset = match.index! + match[0].length
  }
  return <>{nodes}{text.slice(offset)}</>
}
