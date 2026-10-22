// Real browser + independent expense service with a temporary database. No user backend or model calls.
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const dist = join(root, 'frontend/dist')
const temp = await mkdtemp(join(tmpdir(), 'xtr-costs-'))
const artifacts = join(root, 'docs/project-costs-evidence')
await mkdir(artifacts, { recursive: true })
const service = spawn(join(root, 'backend/.venv/Scripts/python.exe'), ['-m', 'uvicorn', 'costs.api:app', '--host', '127.0.0.1', '--port', '18794'], {
  cwd: join(root, 'features/project-costs'), env: { ...process.env, PROJECT_COSTS_DB: join(temp, 'costs.db') }, windowsHide: true, stdio: 'ignore',
})
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/project-costs/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const response = await fetch('http://127.0.0.1:18794/' + req.url.slice('/api/project-costs/'.length), {
        method: req.method, headers: { 'X-Costs-Persona': 'fixture', ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}) },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      })
      res.statusCode = response.status
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json')
      res.end(Buffer.from(await response.arrayBuffer()))
      return
    }
    const file = resolve(dist, '.' + new URL(req.url, 'http://fixture').pathname.replace(/^\/$/, '/index.html'))
    if (!file.startsWith(dist)) throw Error('path')
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.statusCode = 404; res.end() }
})
let browser
try {
  let ready = false
  for (let i = 0; i < 50; i++) {
    try { ready = (await fetch('http://127.0.0.1:18794/health')).ok; if (ready) break } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  assert.ok(ready, 'isolated costs service is ready')
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname
    if (path.startsWith('/api/project-costs/')) {
      return route.continue()
    }
    let body = {}
    if (path === '/api/nest/features') body = { items: [{ id: 'project_costs', name: '项目费用', emoji: '🧾', kind: 'other', status: 'available', desc: '项目费用与账单对账', folder: 'project-costs', needs_vision: false, runner: null }] }
    else if (path === '/api/profiles') body = { profiles: [{ id: 'dalaoda', name: '大老大' }], active_id: 'dalaoda' }
    else if (path === '/api/characters') body = []
    else if (path === '/api/reminders/due') body = { items: [] }
    return route.fulfill({ json: body })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/#project-costs`)
  const panel = page.getByRole('region', { name: '项目费用', exact: true })
  await expect(panel.getByRole('heading', { name: '项目费用', exact: true })).toBeVisible()
  await panel.getByLabel('付款日期（北京时间）').fill('2024-04-08')
  await panel.getByLabel('实付金额').fill('21.90')
  await panel.getByLabel('平台 / 商户').fill('API示例平台')
  await panel.getByLabel('支付平台').selectOption('alipay')
  await panel.getByRole('button', { name: '保存费用', exact: true }).click()
  await expect(panel.getByText('1 笔待对账', { exact: true })).toBeVisible()
  await panel.getByLabel('导入账单', { exact: true }).setInputFiles(join(root, 'features/project-costs/tests/fixtures/alipay-example.xls'))
  await expect(panel.getByRole('status')).toContainText('导入 1 笔')
  await panel.getByRole('button', { name: '查找对账候选', exact: true }).click()
  await expect(panel.getByRole('button', { name: '确认是这一笔', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '确认是这一笔', exact: true }).click()
  await expect(panel.getByText('✓ 已对账', { exact: true })).toBeVisible()
  // Seed through the same API the chat tool uses, then verify the integrated view.
  const dailyBody = { occurred_on: '2026-10-20', period: '晚上', kind: 'exercise', content: '骑车' }
  await page.request.post(`http://127.0.0.1:${server.address().port}/api/project-costs/daily`, { data: dailyBody })
  await panel.getByRole('button', { name: '刷新生活记录', exact: true }).click()
  const daily = panel.getByRole('region', { name: '饮食与运动', exact: true })
  await expect(daily.getByText('2026/10/20 晚上', { exact: true })).toBeVisible()
  await expect(daily.getByText('骑车', { exact: true })).toBeVisible()
  await daily.getByLabel('生活记录月份').fill('2026-09')
  await expect(daily.getByText('暂无饮食运动记录')).toBeVisible()
  await daily.getByRole('button', { name: '全部生活记录', exact: true }).click()
  await expect(daily.getByText('骑车', { exact: true })).toBeVisible()
  const scrollTop = () => panel.evaluate(el => { for (let p = el; p; p = p.parentElement) p.scrollTop = 0 })
  await scrollTop()
  await page.screenshot({ path: join(artifacts, 'desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await scrollTop()
  await page.screenshot({ path: join(artifacts, 'mobile-dark.png') })
  assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'panel fits mobile viewport')
  await panel.getByRole('button', { name: '修改', exact: true }).click()
  await panel.getByLabel('用途 / 备注').fill('核对后的充值用途')
  await panel.getByRole('button', { name: '保存修改（需重新对账）', exact: true }).click()
  await expect(panel.getByText('1 笔待对账', { exact: true })).toBeVisible()
  page.on('dialog', dialog => dialog.accept())
  await daily.getByRole('button', { name: '删除生活记录', exact: true }).click()
  await expect(daily.getByText('暂无饮食运动记录')).toBeVisible()
  await panel.getByRole('button', { name: '删除', exact: true }).click()
  await expect(panel.getByText('暂无记录', { exact: true })).toBeVisible()
  assert.deepEqual(errors, [])
  console.log('PASS: isolated XLS import → expense save → candidate → confirmed match → edit invalidates match → delete; mobile layout and dark mode')
} finally {
  await browser?.close()
  server.close()
  service.kill()
  await new Promise(r => service.once('exit', r))
  await rm(temp, { recursive: true, force: true })
}
