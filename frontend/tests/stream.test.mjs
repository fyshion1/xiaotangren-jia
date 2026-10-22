import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const { outputText } = ts.transpileModule(readFileSync(new URL('../src/api/stream.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
})
const { streamSSE, finishWarning } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

async function receive(raw) {
  const previous = globalThis.fetch
  const bytes = new TextEncoder().encode(raw)
  // One byte per chunk exercises UTF-8 and CRLF boundaries.
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }))
  const events = []
  try {
    await streamSSE('/mock', {}, (text) => events.push(['text', text]),
      (reason) => events.push(['done', reason]), (error) => events.push(['error', error]))
  } finally {
    globalThis.fetch = previous
  }
  return events
}

test('UTF-8, CRLF and finish reason survive arbitrary network chunks', async () => {
  const events = await receive('event: token\r\ndata: {"text":"你好"}\r\n\r\nevent: done\r\ndata: {"finish_reason":"length"}\r\n\r\n')
  assert.deepEqual(events, [['text', '你好'], ['done', 'length']])
})
test('final done frame without blank line is processed', async () => {
  assert.deepEqual(await receive('event: done\ndata: {"finish_reason":"stop"}'), [['done', 'stop']])
})
test('unexpected EOF preserves text and reports an error', async () => {
  const events = await receive('event: token\ndata: {"text":"partial"}\n\n')
  assert.equal(events[0][1], 'partial')
  assert.equal(events[1][0], 'error')
})
test('terminal event fires once even if upstream adds more frames', async () => {
  assert.deepEqual(await receive('event: error\ndata: {"message":"broken"}\n\nevent: done\ndata: {}\n\n'), [['error', 'broken']])
})
test('length, refusal and filtering have distinct explanations', () => {
  assert.equal(finishWarning('stop'), '')
  assert.match(finishWarning('length'), /token/)
  assert.match(finishWarning('content_filter'), /内容限制/)
  assert.match(finishWarning('refusal'), /内容限制/)
})

test('tool events reach observers without ending the stream', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response('event: tool_start\ndata: {"name":"local_info","call_id":"c1"}\n\nevent: tool_result\ndata: {"name":"local_info","ok":true}\n\nevent: token\ndata: {"text":"已确认"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n')
  const observed = [], text = []
  try {
    await streamSSE('/mock', {}, value => text.push(value), () => text.push('done'), error => assert.fail(error), undefined,
      { onEvent: (type, payload) => observed.push([type, payload]) })
    assert.deepEqual(text, ['已确认', 'done'])
    assert.deepEqual(observed.map(event => event[0]), ['tool_start', 'tool_result', 'token', 'done'])
  } finally { globalThis.fetch = previous }
})

test('cancellation passes the signal and reports a stopped turn', async () => {
  const previous = globalThis.fetch
  const controller = new AbortController(), errors = []
  globalThis.fetch = async (_, options) => {
    assert.equal(options.signal, controller.signal)
    controller.abort()
    throw new DOMException('aborted', 'AbortError')
  }
  try {
    await streamSSE('/mock', {}, () => assert.fail(), () => assert.fail(), value => errors.push(value), undefined,
      { signal: controller.signal })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /已停止/)
  } finally { globalThis.fetch = previous }
})
