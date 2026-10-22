import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const { outputText } = ts.transpileModule(readFileSync(new URL('../src/lib/messageMerge.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
})
const { mergeStoredMessages } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const local = { clientId: 'local', role: 'assistant', content: '甲：你好\n乙：你好\n丙：你好', kind: 'groups',
  segments: ['甲','乙','丙'].map(speaker => ({ speaker, text: '你好' })) }
const stored = { ...local, clientId: undefined, dbId: 'server-1', seq: 1 }

test('poll racing persistence never doubles the three speaker cards', () => {
  const result = mergeStoredMessages([local], [stored])
  assert.equal(result.length, 1)
  assert.equal(result.reduce((n,m) => n + m.segments.length, 0), 3)
  assert.equal(result[0].clientId, 'local')
  assert.equal(result[0].dbId, 'server-1')
  assert.deepEqual(mergeStoredMessages(result, [stored]), result)
})
test('identical intentional messages with distinct server IDs are retained', () => {
  const result = mergeStoredMessages([local], [stored, { ...stored, dbId: 'server-2', seq: 2 }])
  assert.equal(result.length, 2)
})
test('partial streaming and other unsaved messages survive a refresh', () => {
  const partial = { role: 'assistant', content: '正在写' }
  const result = mergeStoredMessages([partial], [stored])
  assert.equal(result.length, 2)
  assert.equal(result[1], partial)
})
