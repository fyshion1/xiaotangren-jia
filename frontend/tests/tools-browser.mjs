// Real Chromium + isolated API fixtures. Never talks to the user's backend.
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const artifacts = fileURLToPath(new URL('../../docs/tool-agent-evidence/', import.meta.url))
await mkdir(artifacts, { recursive: true })
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://test')
    const file = resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(dist)) throw Error('path')
    const body = await readFile(file)
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream')
    res.end(body)
  } catch { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ executablePath: process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = [], writes = [], messages = []
  let mode = 'success'
  let reminders = [{ id: 'rem-test', persona_id: 'dalaoda', title: '交项目材料', due_at: Math.floor(Date.now() / 1000) + 86400, revision: 1, status: 'draft' }]
  page.on('pageerror', error => errors.push(error.message))
  const chars = [{ id: 'dashiyin', name: '大诗音', emoji: '🌸', about: '测试角色', personality: [], likes: [], dislikes: [], forms: [] }]
  let config = { enabled: false, web_enabled: true, pet_enabled: true, owner_persona_id: 'dalaoda', root: '', allowed_names: ['local_dir', 'local_read', 'local_find', 'local_info'], max_bytes: 8000, max_turns: 6, max_calls: 8, timeout_seconds: 60 }
  const capabilities = [
    ['local_dir', '查看目录', '列出允许目录中的文件和子目录。', '看看允许目录里有什么文件'],
    ['local_read', '读取文本', '读取允许目录中的 UTF-8 文本。', '读取允许目录里的 使用说明.txt'],
    ['local_find', '寻找文件', '按文件名查找。', '找文件名包含 笔记 的文件'],
    ['local_info', '确认工具边界', '查询当前的目录和限制。', '用工具确认你能访问的目录和限制'],
    ['reminder_draft', '提醒草稿', '生成待确认草稿，不会直接生效。', '明天下午三点提醒我交材料'],
  ].map(([name, label, description, example]) => ({ name, label, description, example }))
  await page.addInitScript(() => localStorage.setItem('xiaotangren.config', JSON.stringify({ baseUrl: 'http://fixture/v1', apiKey: 'fixture', chatModel: 'fixture-model', visionModel: 'fixture-model', channel: 'normal' })))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    let data = {}
    if (path === '/api/reminders' || path === '/api/reminders/due') {
      data = { persona_id: 'dalaoda', items: reminders.filter(item => path.endsWith('/due') ? item.status === 'due' : true) }
    } else if (path.startsWith('/api/reminders/') && method === 'POST') {
      const change = request.postDataJSON(), id = path.split('/').pop()
      const row = reminders.find(item => item.id === id)
      if (!row) return route.fulfill({ status: 404, json: { detail: '未找到提醒' } })
      if (change.action === 'edit') { row.title = change.title; row.due_at = Date.parse(change.due_at) / 1000; row.status = 'draft' }
      else row.status = { confirm: 'scheduled', cancel: 'cancelled', dismiss: 'dismissed' }[change.action]
      row.revision++
      data = row
    } else if (path === '/api/tools/config') {
      if (method === 'PUT') { config = request.postDataJSON(); writes.push(config) }
      data = { config, capabilities, resolved_root: 'C:\\小糖人\\data\\tool-sandbox', personas: [{ id: 'dalaoda', name: '大老大' }] }
    } else if (path === '/api/tools/runs') data = { items: [] }
    else if (path === '/api/characters') data = chars
    else if (path === '/api/profiles') data = { profiles: [{ ...chars[0], id: 'dalaoda', name: '大老大' }], active_id: 'dalaoda' }
    else if (path === '/api/settings') data = {}
    else if (path === '/api/nest/features') data = { items: [] }
    else if (path === '/api/messages') {
      if (method === 'POST') { const body = request.postDataJSON(); data = { ...body, id: `saved-${messages.length}`, seq: messages.length + 1 }; messages.push(data) }
      else data = { items: messages, has_more: false, total: messages.length }
    } else if (path === '/api/chat/session/web-stream') {
      if (mode === 'cancel') {
        await new Promise(resolve => setTimeout(resolve, 500))
        return route.fulfill({ contentType: 'text/event-stream', body: 'event: done\ndata: {}\n\n' }).catch(() => {})
      }
      const assistant = { id: 'answer-1', seq: messages.length + 1, role: 'assistant', content: '已确认允许目录，当前只有只读文件工具。', kind: 'text', segments: [] }
      messages.push(assistant)
      const events = [
        ['agent_status', { phase: 'thinking', run_id: 'test-run', turn: 1 }],
        ['tool_start', { name: 'local_info', call_id: 'c1', run_id: 'test-run' }],
        ['tool_result', { name: 'local_info', call_id: 'c1', ok: true, code: 'ok', output: '允许目录：专用工具目录。仅支持只读操作。', run_id: 'test-run' }],
        ['agent_end', { status: 'completed', run_id: 'test-run' }],
        ['token', { text: assistant.content }], ['done', { assistant, finish_reason: 'stop' }],
      ]
      return route.fulfill({ contentType: 'text/event-stream', body: events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') })
    } else if (path.includes('engines')) data = { engines: [] }
    else if (path.includes('voices')) data = { voices: [] }
    else if (path.includes('gallery')) data = { items: [] }
    else if (path.includes('worldbook')) data = []
    return route.fulfill({ json: data })
  })

  await page.goto(base + '/#tool-center')
  await expect(page.getByRole('heading', { name: '工具中心', exact: true })).toBeVisible()
  await expect(page.getByText('工具未开启', { exact: true })).toBeVisible()
  const panel = page.getByRole('region', { name: '我的提醒', exact: true })
  await expect(panel.getByText('待确认', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '确认创建', exact: true }).click()
  await expect(panel.getByText('等待提醒', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '修改', exact: true }).click()
  await panel.getByLabel('提醒内容', { exact: true }).fill('提交更新后的材料')
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(panel.getByText('待确认', { exact: true })).toBeVisible()
  await expect(panel.getByText('提交更新后的材料', { exact: true })).toBeVisible()
  await panel.screenshot({ path: resolve(artifacts, 'reminders-desktop.png') })
  await panel.getByRole('button', { name: '确认创建', exact: true }).click()
  reminders[0].status = 'due'
  await page.evaluate(() => window.dispatchEvent(new Event('xtr:reminders-changed')))
  const notice = page.getByRole('status', { name: '到期提醒' })
  await expect(notice.getByText('提交更新后的材料', { exact: true })).toBeVisible()
  await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await expect(notice).toHaveCount(0)
  assert.equal(reminders[0].status, 'dismissed')
  await page.getByLabel('允许小糖人使用工具').check()
  await expect(page.getByText('设置待保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存工具设置', exact: true }).click()
  await expect(page.getByText('已保存，下一轮聊天生效。')).toBeVisible()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].enabled, true)
  assert.equal(writes[0].allowed_names.length, 4)
  await page.getByRole('heading', { name: '工具中心', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(artifacts, 'tool-center-desktop.png') })
  await page.goto(base)
  await page.getByRole('button', { name: '✦ 工具能力', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '工具中心' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '✦ 工具能力', exact: true }).click()
  await page.getByRole('button', { name: '填入聊天：用工具确认你能访问的目录和限制', exact: true }).click()
  await expect(page.getByLabel('聊天输入框')).toHaveValue('用工具确认你能访问的目录和限制')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('本轮工具执行').getByText('成功', { exact: true })).toBeVisible()
  await page.getByLabel('本轮工具执行').locator('summary').click()
  await expect(page.getByText('允许目录：专用工具目录。仅支持只读操作。')).toBeVisible()
  await page.screenshot({ path: resolve(artifacts, 'tool-chat-desktop.png'), fullPage: true })
  mode = 'cancel'
  await page.getByLabel('聊天输入框').fill('再确认一次工具边界')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByRole('button', { name: '停止本轮', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await expect(page.getByText('已停止本轮，已保留你的消息。').first()).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  reminders = [{ id: 'rem-mobile', persona_id: 'dalaoda', title: '记得喝水，休息一下眼睛', due_at: Math.floor(Date.now() / 1000) + 7200, revision: 1, status: 'draft' }]
  await page.goto(base + '/#tool-center')
  await expect(page.getByRole('heading', { name: '工具中心', exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('heading', { name: '工具中心', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(artifacts, 'tool-center-mobile.png') })
  await page.getByRole('region', { name: '我的提醒', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(artifacts, 'reminders-mobile.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: resolve(artifacts, 'reminders-mobile-dark.png') })
  await page.getByRole('region', { name: '我的提醒', exact: true }).getByRole('button', { name: '取消提醒', exact: true }).click()
  await expect(page.getByText('还没有进行中的提醒。开启「提醒草稿」能力后，可以先试一句。')).toBeVisible()
  assert.deepEqual(errors, [])
  console.log('PASS: tool center, save state, examples, activity/results, cancellation, mobile layout, deep link; screenshots:', artifacts)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
