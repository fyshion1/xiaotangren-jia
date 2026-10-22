export type CardDisplayRule = {
  scriptName?: string; findRegex?: string; replaceString?: string; disabled?: boolean
  placement?: number[]; promptOnly?: boolean; substituteRegex?: number
  minDepth?: number | null; maxDepth?: number | null; trimStrings?: string[]
}
export type DisplayResult = { html: string; warnings: string[]; applied: number }

/** Self-contained so the same function can execute inside a disposable Worker. */
export function transformCardDisplay(source: string, rules: CardDisplayRule[], depth = 0): DisplayResult {
  const warnings: string[] = []
  let html = source
  let applied = 0
  if (source.length > 200_000 || rules.length > 100) {
    return { html: source, warnings: ['卡片显示内容或规则过大，保留原文'], applied }
  }
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || rule.disabled || rule.promptOnly) continue
    if (Array.isArray(rule.placement) && !rule.placement.includes(2)) continue
    if (typeof rule.minDepth === 'number' && depth < rule.minDepth) continue
    if (typeof rule.maxDepth === 'number' && depth > rule.maxDepth) continue
    const name = typeof rule.scriptName === 'string' ? rule.scriptName : '未命名规则'
    if (rule.substituteRegex || rule.trimStrings?.length) {
      warnings.push(`${name} 依赖尚未支持的宏或捕获组清理，已跳过`)
      continue
    }
    if (typeof rule.findRegex !== 'string' || typeof rule.replaceString !== 'string') continue
    if (rule.findRegex.length > 8_000 || rule.replaceString.length > 50_000) {
      warnings.push(`${name} 过大，已跳过`)
      continue
    }
    try {
      const literal = rule.findRegex
      const lastSlash = literal.lastIndexOf('/')
      const delimited = literal.startsWith('/') && lastSlash > 0 && /^[dgimsuvy]*$/.test(literal.slice(lastSlash + 1))
      const pattern = delimited ? literal.slice(1, lastSlash) : literal
      const flags = delimited ? literal.slice(lastSlash + 1) : ''
      const regex = new RegExp(pattern, flags)
      const next = html.replace(regex, rule.replaceString)
      if (next.length > 1_000_000) {
        warnings.push(`${name} 生成内容过大，已停止转换`)
        break
      }
      if (next !== html) applied++
      html = next
    } catch {
      warnings.push(`${name} 正则格式无法识别，已跳过`)
    }
  }
  return { html, warnings, applied }
}

/** Imported regexes must not be able to freeze the UI with catastrophic backtracking. */
export function renderCardDisplay(source: string, rules: CardDisplayRule[], depth: number, signal: AbortSignal): Promise<DisplayResult> {
  return new Promise((resolve, reject) => {
    const code = `self.onmessage = ({data}) => self.postMessage((${transformCardDisplay.toString()})(data.source, data.rules, data.depth))`
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    const worker = new Worker(url)
    let timer: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url)
      signal.removeEventListener('abort', abort)
    }
    const abort = () => { cleanup(); reject(new Error('已取消预览')) }
    worker.onmessage = ({ data }: MessageEvent<DisplayResult>) => { cleanup(); resolve(data) }
    worker.onerror = () => { cleanup(); reject(new Error('卡内显示规则执行失败，保留原文')) }
    timer = setTimeout(() => { cleanup(); reject(new Error('卡内显示规则执行超时，保留原文')) }, 2000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else worker.postMessage({ source, rules, depth })
  })
}
