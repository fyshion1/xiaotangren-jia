// 「关于」/ 开场白里的轻量 HTML → 安全的渲染模型（**不用 dangerouslySetInnerHTML**）。
//
// 酒馆角色卡的正文常带 `<p> <b> <i> <br>` 这类排版。后端导入时已经洗过一遍（存进
// `aboutHtml` / `greetingHtml`），但那是「上次落库时」的结果 —— 用户手改了原文、或者
// 老数据的字段不对，前端都不能信。这里再洗一遍，**只认一个定死的标签白名单、不带任何属性**，
// 输出成 `RichNode` 树交给 React 渲染：React 只建节点不解析字符串，脚本 / 事件属性根本没机会进来。
//
// 规则与后端 `services/card_import.py` 的 sanitize_html 对齐：
// - 白名单外的标签一律丢掉（script / style / iframe 连内容一起丢）；
// - 属性全部不要（href / src / on* / style 都不保留，链接只留文字）；
// - `<p> <div> <h*>` 这类块状标签前后换行，`<br>` 直接换行；
// - 孤零零的 `<`（比如「她 < 他」）原样当文字。

export type RichNode = string | { tag: string; children: RichNode[] }

const ALLOWED = new Set([
  'p', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'sub', 'sup', 'small', 'mark', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'span',
])
const VOID = new Set(['br', 'hr'])
// 连内容一起丢（它们里面的文字不是给人看的排版，而是代码 / 脚本 / 样式）。
const DROP_WITH_CONTENT = new Set(['script', 'style'])
// 块状：前后换行（`div` 不在白名单里，但开合时也按块处理，免得段落粘成一坨）。
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li'])
const BOTH_SIDES = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'])
const DROP_BLOCKS = new Set([
  'div', 'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math',
  'textarea', 'select', 'form', 'table', 'head',
])
// 可选结束标签：HTML 里 `<p>a<p>b` 允许不写 `</p>`。碰到同类或块状标签时自动收掉。
const AUTO_CLOSE = new Set(['p', 'li'])

const ENTITY: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m
      try {
        return String.fromCodePoint(code)
      } catch {
        return m
      }
    }
    return ENTITY[body] ?? m
  })
}

type El = { tag: string; children: RichNode[] }

function pushText(stack: El[], text: string) {
  if (!text) return
  const kids = stack[stack.length - 1].children
  const last = kids[kids.length - 1]
  if (typeof last === 'string' && last !== '\n' && text !== '\n') kids[kids.length - 1] = last + text
  else kids.push(text)
}

/** 落到根上：根层的空行压成一个，首尾裁掉。 */
function finish(root: El): RichNode[] {
  const out: RichNode[] = []
  for (const n of root.children) {
    const last = out[out.length - 1]
    if (n === '\n' && (last === undefined || last === '\n')) continue
    if (typeof n === 'string' && typeof last === 'string') out[out.length - 1] = last + n
    else out.push(n)
  }
  while (out.length && out[out.length - 1] === '\n') out.pop()
  return out
}

/**
 * 把一段「可能带 HTML」的正文洗成 RichNode 树。
 * 没有标签的纯文本也能进来，结果就是一段文字（保留换行）。
 */
export function toRichNodes(html: string): RichNode[] {
  const src = html || ''
  const root: El = { tag: '#root', children: [] }
  const stack: El[] = [root]
  const closeTo = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) {
        const el = stack.pop() as El
        stack[i - 1].children.push(el)
        return true
      }
    }
    return false
  }
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      pushText(stack, decodeEntities(src.slice(i)))
      break
    }
    if (lt > i) pushText(stack, decodeEntities(src.slice(i, lt)))
    const end = src.indexOf('>', lt)
    if (end < 0) {
      pushText(stack, decodeEntities(src.slice(lt))) // 没收口的 `<`：当文字
      break
    }
    const inner = src.slice(lt + 1, end).trim()
    const m = inner.match(/^(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/)
    if (!inner || !m) {
      // `< 3`、`<她`、`<>` 这种不是标签 —— 原样当文字
      pushText(stack, decodeEntities(src.slice(lt, end + 1)))
      i = end + 1
      continue
    }
    i = end + 1
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()

    if (DROP_WITH_CONTENT.has(tag)) {
      if (closing) continue
      const re = new RegExp(`</\\s*${tag}\\s*>`, 'i')
      const rest = src.slice(i)
      const cm = re.exec(rest)
      i = cm ? i + cm.index + cm[0].length : src.length
      continue
    }
    if (tag === 'br') {
      pushText(stack, '\n')
      continue
    }
    if (tag === 'hr') {
      if (!closing) stack[stack.length - 1].children.push({ tag: 'hr', children: [] })
      continue
    }
    if (!ALLOWED.has(tag)) {
      if (DROP_BLOCKS.has(tag) && !closing) pushText(stack, '\n')
      continue
    }
    if (closing) {
      closeTo(tag)
      if (BLOCK.has(tag) && BOTH_SIDES.has(tag)) pushText(stack, '\n')
      continue
    }
    // 开标签：先收掉同类的「可选结束」标签，以及块中块
    if (AUTO_CLOSE.has(tag) && stack[stack.length - 1].tag === tag) closeTo(tag)
    if (BLOCK.has(tag) && stack[stack.length - 1].tag === 'p') closeTo('p')
    if (BLOCK.has(tag) && BOTH_SIDES.has(tag)) pushText(stack, '\n')
    const el: El = { tag, children: [] }
    stack.push(el)
    if (VOID.has(tag)) {
      stack.pop()
      stack[stack.length - 1].children.push(el)
    }
  }
  // 没写完的标签收口
  while (stack.length > 1) {
    const el = stack.pop() as El
    stack[stack.length - 1].children.push(el)
  }
  return finish(root)
}

const BLOCK_CLASS = 'mt-2 first:mt-0'

/** 节点 → className（白名单内的标签一律不带属性，这里只挑几个排版样式）。 */
export function richNodeClass(tag: string): string | undefined {
  switch (tag) {
    case 'p':
      return BLOCK_CLASS
    case 'h1':
      return 'mt-3 first:mt-0 text-[1.15em] font-bold'
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'mt-2 first:mt-0 font-semibold'
    case 'ul':
      return `${BLOCK_CLASS} list-disc pl-5`
    case 'ol':
      return `${BLOCK_CLASS} list-decimal pl-5`
    case 'li':
      return 'ml-0'
    case 'blockquote':
      return 'my-2 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-3)]'
    case 'hr':
      return 'my-3 border-t border-[var(--border)]'
    case 'code':
      return 'rounded bg-[var(--surface-2)] px-1 py-px font-mono text-[0.92em]'
    case 'pre':
      return `${BLOCK_CLASS} overflow-x-auto whitespace-pre-wrap rounded bg-[var(--surface-2)] p-2 font-mono text-[0.92em]`
    default:
      return undefined
  }
}

/** 列表项开头的 `!` / `?` 变成醒目记号（很多卡用这两个符号标「重要 / 疑问」）。 */
export function listLeadMark(text: string): { mark: string; rest: string } | null {
  const m = text.match(/^([!?！？]+)\s*/)
  if (!m) return null
  return { mark: m[1], rest: text.slice(m[0].length) }
}

/** 洗白后的**纯文字**（用于「库里存的 aboutHtml 跟现在的 about 还是不是一回事」这种比对）。 */
export function plainText(nodes: RichNode[], sep = ''): string {
  const parts: string[] = []
  const walk = (list: RichNode[]) => {
    for (const n of list) {
      if (typeof n === 'string') parts.push(n)
      else if (n.tag === 'br' || n.tag === 'hr') parts.push('\n')
      else walk(n.children)
    }
  }
  walk(nodes)
  return parts.join(sep)
}

function squeeze(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 挑出要显示的 HTML：只有「库里的排版版本」和「现在的原文」文字一致时才用排版版本。
 * 用户后来手改了 `about`（排版没跟着重算）就退回原文按纯文本显示，别把旧内容画出来。
 */
export function pickHtml(plain: string, html?: string): string {
  if (!html) return plain
  const a = plainText(toRichNodes(html))
  return squeeze(a) === squeeze(plain) ? html : plain
}
