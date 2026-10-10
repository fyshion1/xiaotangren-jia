// Run against a local Chromium executable: node tests/mobile-smoke.mjs <chrome.exe>
// All API calls are mocked; no real database, image files, or model is used.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, extname, join, dirname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const profile = mkdtempSync(join(tmpdir(), 'xtr-browser-'))
const characters = ['dashiyin', 'xiaoshiyin', 'xiaobai', 'xiaohongshu'].map((id, i) => ({
  id, name: ['大诗音', '小诗音', '小白', '小红薯头'][i], emoji: '🌸', about: '测试角色',
  personality: [], likes: [], dislikes: [], forms: [],
}))
let clears = 0
let stored = []
let mode = 'length'
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const data = []
  for await (const part of req) data.push(part)
  const body = data.length ? JSON.parse(Buffer.concat(data).toString()) : {}
  const json = (value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/characters') return json(characters)
    if (url.pathname === '/api/profiles') return json({ profiles: [{ id: 'dalaoda', name: '测试用户' }], active_id: 'dalaoda' })
    if (url.pathname === '/api/settings') return json({})
    if (url.pathname === '/api/gallery') return json([])
    if (url.pathname === '/api/messages') {
      if (req.method === 'POST') { stored.push(body); return json({ ...body, id: `m-${stored.length}`, seq: stored.length }) }
      return json({ items: [{ id: 'm-fixture', seq: 1, role: 'assistant', content: '测试历史', kind: 'text', segments: [] }], has_more: false, total: 1 })
    }
    if (url.pathname === '/api/attachments/stats') return json({ current_session: 'group', orig_bytes: clears ? 0 : 1024, thumb_bytes: 500, sessions: [{ session: 'group', orig_bytes: clears ? 0 : 1024, thumb_bytes: 500 }] })
    if (url.pathname === '/api/attachments/clear-originals') {
      assert.equal(url.searchParams.get('session'), 'group'); assert.equal(body.confirmed, true)
      clears++; return json({ removed: 1 })
    }
    if (url.pathname === '/api/images/engines') return json({ selected: 'local', engines: [] })
    if (url.pathname === '/api/chat') {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('event: token\ndata: {"text":"这是需要完整保留的测试回复"}\n\n')
      if (mode !== 'eof') res.write(`event: done\ndata: {"finish_reason":"${mode}"}\n\n`)
      return res.end()
    }
    return json([])
  }
  try {
    const file = resolve('dist', url.pathname === '/' ? 'index.html' : '.' + url.pathname)
    assert.ok(file.startsWith(resolve('dist') + '\\') || file.startsWith(resolve('dist') + '/'))
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)]
    res.setHeader('Content-Type', mime || 'application/octet-stream'); res.end(await readFile(file))
  } catch { res.statusCode = 404; res.end() }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const chrome = spawn(process.argv[2], ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true })
let socket
try {
  let output = ''
  const wsUrl = await new Promise((resolve, reject) => {
    chrome.on('error', reject)
    chrome.stderr.on('data', (chunk) => {
      output += chunk
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolve(match[1])
    })
  })
  socket = new WebSocket(wsUrl); await once(socket, 'open')
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const current = ++id; pending.set(current, { resolve, reject })
    socket.send(JSON.stringify({ id: current, method, params, sessionId }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => send(method, params, sessionId)
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const waitFor = async (expression) => {
    for (let n = 0; n < 80; n++) {
      if (await evaluate(expression)) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Timed out: ' + expression)
  }
  const click = async (label) => {
    const expr = `Array.from(document.querySelectorAll('button')).find(b => b.getClientRects().length && !b.disabled && b.textContent.trim() === ${JSON.stringify(label)})`
    await waitFor(`Boolean(${expr})`)
    await evaluate(`(${expr}).click()`)
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 1, mobile: true })
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` })
  await waitFor(`document.body.innerText.includes('测试历史')`)
  for (const [width, height] of [[375, 667], [320, 568], [667, 375]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
    await click('📊状态')
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'mobile overflow')
    for (const label of ['🧠记忆', '🖼画廊', '🔍提示词', '⚙设置', '存储管理']) {
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('button')).some(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(label)})`), label)
    }
    await click('⚙设置')
    await waitFor(`Boolean(document.querySelector('[aria-label="模型设置"]'))`)
    await click('保存并关闭')
  }
  await click('📊状态'); await click('🗑删除')
  await waitFor(`document.body.innerText.includes('已选 0 条')`)
  await click('取消')
  await click('📊状态'); await click('存储管理')
  await click('清理本会话原图…'); assert.equal(clears, 0)
  await click('取消'); assert.equal(clears, 0)
  await click('清理本会话原图…'); await click('确认清理原图')
  await waitFor(`document.body.innerText.includes('已清理 1 个')`); assert.equal(clears, 1)
  await click('关闭')
  await click('🎨生成照片')
  assert.equal(await evaluate(`document.body.innerText.includes('清理原图')`), false)
  await click('取消')
  await click('🐾聊天')
  for (const finish of ['length', 'content_filter', 'eof']) {
    mode = finish
    await evaluate(`(() => { const t = Array.from(document.querySelectorAll('textarea')).find(t => t.getClientRects().length); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'hello'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await click('发送')
    const expected = finish === 'length' ? '长度上限' : finish === 'content_filter' ? '内容限制' : '连接提前结束'
    await waitFor(`document.body.innerText.includes('${expected}')`)
    await waitFor(`!Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('发送') && b.disabled)`)
  }
  assert.equal(stored.filter((m) => m.role === 'assistant' && m.content === '这是需要完整保留的测试回复').length, 3)
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'desktop overflow')
  console.log('PASS: mobile 320/375/667 widths, settings, selection, scoped cleanup confirmation, stream warnings and partial persistence, desktop layout')
} finally {
  socket?.close(); chrome.kill(); server.close()
  await once(chrome, 'exit').catch(() => {})
  assert.equal(dirname(resolve(profile)), resolve(tmpdir()))
  assert.ok(basename(profile).startsWith('xtr-browser-'))
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
