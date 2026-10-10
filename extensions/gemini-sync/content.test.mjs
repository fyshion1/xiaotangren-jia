import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('./content.js', import.meta.url), 'utf8')

function harness() {
  const state = {}, sent = [], callbacks = {}
  const location = { pathname: '/app/conv1' }
  const nodes = []
  const chrome = {
    storage: { local: {
      get: async () => ({ ...state }),
      set: async value => Object.assign(state, value),
    } },
    runtime: {
      onMessage: { addListener: callback => { callbacks.message = callback } },
      sendMessage: async message => { sent.push(message); return {ok: true} },
    },
  }
  vm.runInNewContext(source, {
    chrome, crypto: webcrypto, TextEncoder, location,
    document: { body: {}, querySelectorAll: () => nodes },
    MutationObserver: class { observe() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: callback => { callbacks.poll = callback },
  })
  const node = (role, text) => {
    const value = { tagName: role === 'user' ? 'USER-QUERY' : 'MODEL-RESPONSE', text,
      getClientRects: () => [1], getAttribute: () => null, closest: () => null }
    value.querySelector = () => ({innerText: value.text})
    return value
  }
  const poll = async () => { await callbacks.poll() }
  return {state, sent, location, nodes, node, poll}
}

test('默认停止、重复快照去重、流式回答保持标识、切会话停止', async () => {
  const h = harness()
  h.nodes.push(h.node('user', '你好'), h.node('assistant', '**大诗音**：你好'))
  await h.poll()
  assert.equal(h.sent.length, 0)
  Object.assign(h.state, {conversationId: 'conv1', enabledTabId: 1})
  await h.poll()
  assert.equal(h.sent.length, 1)
  const originalId = h.sent[0].messages[1].id
  await h.poll()
  assert.equal(h.sent.length, 1)
  h.nodes[1].text += '，明天再见。'
  await h.poll()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].messages[1].id, originalId)
  h.location.pathname = '/app/conv2'
  h.nodes[1].text += ' changed'
  await h.poll()
  assert.equal(h.sent.length, 2)
})

test('长快照分批，来源缺失时不发送无法关联的回答', async () => {
  const h = harness()
  Object.assign(h.state, {conversationId: 'conv1', enabledTabId: 1})
  h.nodes.push(h.node('assistant', '没有已加载问题的回答'))
  for (let i = 0; i < 31; i++) h.nodes.push(h.node('user', `问题 ${i}`), h.node('assistant', `回答 ${i}`))
  await h.poll()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[0].messages.length, 50)
  assert.equal(h.sent[1].messages.length, 12)
  assert.equal(new Set(h.sent.flatMap(batch => batch.messages.map(m => m.id))).size, 62)
})
