/** SSE transport shared by text and vision replies. A closed socket is not a done event. */
export async function streamSSE(
  url: string,
  body: unknown,
  onToken: (text: string) => void,
  onDone: (reason?: string) => void,
  onError: (message: string) => void,
) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`)
    reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let data: string[] = []
    const dispatch = () => {
      if (!data.length) return false
      const payload = JSON.parse(data.join('\n')) as { text?: string; message?: string; finish_reason?: string }
      const type = event
      event = ''
      data = []
      if (type === 'token' && payload.text) onToken(payload.text)
      if (type === 'done') { onDone(payload.finish_reason); return true }
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
    onError(e instanceof Error ? e.message : String(e))
  } finally {
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

export function finishWarning(reason?: string): string {
  if (reason === 'length' || reason === 'max_tokens') return '回复达到模型的长度上限，可能尚未写完。可在模型设置中提高回复 token 上限。'
  if (reason === 'content_filter' || reason === 'refusal') return '上游模型因内容限制结束了回复，已保留收到的文字。'
  if (reason && reason !== 'stop') return `上游结束了回复（${reason}），内容可能不完整。`
  return ''
}
