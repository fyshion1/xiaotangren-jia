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
