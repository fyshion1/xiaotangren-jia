// RichText：把「关于」/ 开场白里的轻量 HTML 安全地画出来。
//
// 走 `lib/richText.ts` 的洗白 → RichNode 树 → React 节点这条路，**不用 dangerouslySetInnerHTML**：
// 白名单外的标签、属性、脚本都不会出现在 DOM 里（链接只留文字）。
// 纯文本（没标签）也能直接喂进来，换行原样保留。

import { Fragment, useMemo } from 'react'
import type { CSSProperties, Key, ReactNode } from 'react'
import { listLeadMark, richNodeClass, toRichNodes, type RichNode } from '../lib/richText'

/** 开头 `!` / `?` 记号单独染色 —— 卡里常用它标「重要 / 疑问」。 */
function renderText(text: string, key?: Key): ReactNode {
  const lead = listLeadMark(text)
  if (!lead) return text
  return (
    <Fragment key={key}>
      <span className={`mr-0.5 font-bold ${/[!！]/.test(lead.mark) ? 'text-[#d9534f]' : 'text-[var(--pink-deep)]'}`}>
        {lead.mark}
      </span>
      {lead.rest}
    </Fragment>
  )
}

function renderNodes(nodes: RichNode[]): ReactNode[] {
  return nodes.map((node, i) =>
    typeof node === 'string' ? renderText(node, i) : <Fragment key={i}>{renderNode(node)}</Fragment>,
  )
}

// 每个标签单独一条 JSX，免得用动态标签名 + 类型体操。
function renderNode(node: RichNode): ReactNode {
  if (typeof node === 'string') return renderText(node)
  const { tag, children } = node
  switch (tag) {
    case 'br':
      return <br />
    case 'hr':
      return <hr className={richNodeClass(tag)} />
    case 'p':
      return <p className={richNodeClass(tag)}>{renderNodes(children)}</p>
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return (
        <div className={richNodeClass(tag)} role="heading" aria-level={Number(tag[1])}>
          {renderNodes(children)}
        </div>
      )
    case 'b':
    case 'strong':
      return <strong>{renderNodes(children)}</strong>
    case 'i':
    case 'em':
      return <em>{renderNodes(children)}</em>
    case 'u':
      return <u>{renderNodes(children)}</u>
    case 's':
    case 'del':
      return <del>{renderNodes(children)}</del>
    case 'sub':
      return <sub>{renderNodes(children)}</sub>
    case 'sup':
      return <sup>{renderNodes(children)}</sup>
    case 'small':
      return <small>{renderNodes(children)}</small>
    case 'mark':
      return <mark>{renderNodes(children)}</mark>
    case 'code':
      return <code className={richNodeClass(tag)}>{renderNodes(children)}</code>
    case 'pre':
      return <pre className={richNodeClass(tag)}>{renderNodes(children)}</pre>
    case 'blockquote':
      return <blockquote className={richNodeClass(tag)}>{renderNodes(children)}</blockquote>
    case 'ul':
      return <ul className={richNodeClass(tag)}>{renderNodes(children)}</ul>
    case 'ol':
      return <ol className={richNodeClass(tag)}>{renderNodes(children)}</ol>
    case 'li':
      return <li className={richNodeClass(tag)}>{renderNodes(children)}</li>
    default:
      return <span>{renderNodes(children)}</span>
  }
}

type Props = {
  /** 可能带 HTML 的正文（后端洗过或原文都行，这里会再洗一遍）。 */
  html: string
  /** 纯文本模式：保留换行（等同于 `<br>`）。 */
  preserveNewlines?: boolean
  className?: string
  style?: CSSProperties
  /** 最多显示几行（用于折叠预览）。 */
  lines?: number
}

export default function RichText({ html, preserveNewlines = true, className = '', style, lines }: Props) {
  const nodes = useMemo(() => toRichNodes(html), [html])
  const clamp: CSSProperties | undefined = lines
    ? {
        display: '-webkit-box',
        WebkitLineClamp: lines,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
      }
    : undefined
  return (
    <div
      className={`[overflow-wrap:anywhere] ${preserveNewlines ? 'whitespace-pre-wrap' : ''} ${className}`}
      style={{ ...clamp, ...style }}
    >
      {renderNodes(nodes)}
    </div>
  )
}
