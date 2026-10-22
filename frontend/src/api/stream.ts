/** 通用的 SSE 读取：逐事件回调，读到 done / error 事件或流结束就收尾。
 *
 *  `body` 可以是 JSON 对象（自动 `Content-Type: application/json`），也可以是 FormData（原样发，浏览器自己带边界）。
 *  `onEvent(type, payload)` 拿到每一个事件 —— token / status / ping / done / error 都由调用方自己认。
 *  连接断了（"Server disconnected"、网络错误、流提前结束）一律走 `onError`，错误信息尽量是后端给的原话。 */
export async function readSSE(
  url: string,
  body: unknown,
  onEvent: (type: string, payload: Record<string, unknown>) => void,
  opts: { signal?: AbortSignal } = {},
) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let finished = false
  try {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    const resp = await fetch(url, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? (body as FormData) : JSON.stringify(body),
      signal: opts.signal,
    })
    if (!resp.ok) {
      let detail = ''
      try {
        detail = ((await resp.json()) as { detail?: string })?.detail ?? ''
      } catch {
        /* 后端没回 JSON（崩了 / 代理断了）—— 用状态码兜底 */
      }
      throw new Error(detail || `HTTP ${resp.status}`)
    }
    if (!resp.body) throw new Error('服务器没有返回内容')
    reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let data: string[] = []
    const dispatch = () => {
      if (!data.length) return false
      const raw = data.join('\n')
      event = event || 'message'
      data = []
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* 半个 JSON（极少见）—— 当作空 payload，调用方按事件名处理 */
      }
      const type = event
      event = ''
      onEvent(type, payload)
      return type === 'done' || type === 'error'
    }
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line === '') {
          if (dispatch()) {
            finished = true
            return
          }
        } else if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (done) {
        // 有的代理不发最后一个空行：把手上剩的完整 data 再解析一次。
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart())
        if (dispatch()) finished = true
        return
      }
    }
  } finally {
    // 没读到 done 就退出（断连 / abort）：尽量把 reader 收干净，收不干净也无所谓。
    if (!finished && reader) {
      try {
        await reader.cancel()
      } catch {
        /* 已经断了 */
      }
    }
  }
}

/** SSE transport shared by text and vision replies. A closed socket is not a done event. */
export async function streamSSE(
  url: string,
  body: unknown,
  onToken: (text: string) => void,
  onDone: (reason?: string, assistant?: import('./storage').StoredMessage) => void,
  onError: (message: string) => void,
  onContext?: (data: { model: string; messages: { role: string; text: string; image_count: number }[] }) => void,
  options: { signal?: AbortSignal; onEvent?: (type: string, payload: Record<string, unknown>) => void } = {},
) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    })
    if (!resp.ok) { const data = await resp.json().catch(() => null); throw new Error(typeof data?.detail === 'string' ? data.detail : `HTTP ${resp.status}`) }
    if (!resp.body) throw new Error('服务器没有返回内容')
    reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let data: string[] = []
    const dispatch = () => {
      if (!data.length) return false
      const payload = JSON.parse(data.join('\n')) as { text?: string; message?: string; finish_reason?: string; assistant?: import('./storage').StoredMessage }
      const type = event
      event = ''
      data = []
      options.onEvent?.(type, payload as Record<string, unknown>)
      if (type === 'context') onContext?.(payload as unknown as { model: string; messages: { role: string; text: string; image_count: number }[] })
      if (type === 'token' && payload.text) onToken(payload.text)
      if (type === 'done') { onDone(payload.finish_reason, payload.assistant); return true }
      if (type === 'error') { onError(payload.message ?? '未知错误'); return true }
      return false
    }
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line === '') {
          if (dispatch()) return
          event = ''
        } else if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (done) {
        // Some proxies omit the last blank line. Parse the final complete payload once.
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart())
        if (dispatch()) return
        throw new Error('连接提前结束，回复可能不完整。已保留收到的文字。')
      }
    }
  } catch (e) {
    onError(options.signal?.aborted ? '已停止本轮，已保留你的消息。' : e instanceof Error ? e.message : String(e))
  } finally {
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

export function finishWarning(reason?: string): string {
  if (reason === 'length' || reason === 'max_tokens') return '回复达到模型的长度上限，可能尚未写完。可以让对方继续回复。'
  if (reason === 'content_filter' || reason === 'refusal') return '上游模型因内容限制结束了回复，已保留收到的文字。'
  if (reason && reason !== 'stop') return `上游结束了回复（${reason}），内容可能不完整。`
  return ''
}
