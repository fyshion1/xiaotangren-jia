// Isolated UI verification: no real QQ, model, memory or Bilibili access.
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundled = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Exploration from './src/components/AutonomousActivityPanel';
    import Settings from './src/components/NestSettingsPanel';
    createRoot(document.getElementById('root')).render(location.search === '?qq' ? <Settings onlyId="qq_bridge" bare/> : <Exploration/>);`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
})
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/bundle.js' ? bundled.outputFiles[0].text
    : '<!doctype html><meta charset="UTF-8"><div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.argv[2] || process.env.CHROME_PATH || undefined })
  const page = await browser.newPage()
  const errors = []
  const writes = []
  page.on('pageerror', e => errors.push(e.message))
  let uncertain = false, stopped = false
  const approvals = []
  let approved = false, paused = false, agentReady = false
  const schema = [
    { key: 'proactive.day_tokens', label: '旧普通活动每日预算', type: 'number', default: 24000, group: '自主活动' },
    { key: 'proactive.min_minutes', label: 'QQ 娱乐最短间隔', type: 'number', default: 90, group: '主动联系' },
    { key: 'owner.qq', label: 'QQ 通知主人', type: 'text', default: '', group: 'QQ 连接' },
  ]
  let settingsReads = 0
  const settingWrites = []
  let wallet = null
  let clockConfig = { enabled: false, continuous: true, qq_account_index: null, min_minutes: 60, max_minutes: 180, daily_opportunities: 6, run_tokens: 12000, day_tokens: 24000 }
  const globalWrites = []
  await page.route('**/api/profiles', route => route.fulfill({ json: { profiles: [{ id: 'dalaoda', name: '大老大' }], active_id: 'dalaoda' } }))
  await page.route('**/api/characters', route => route.fulfill({ json: [{ id: 'dashiyin', name: '大诗音' }] }))
  await page.route('**/api/qq-bridge/setup/choices', route => route.fulfill({ json: { items: [
    { index: 0, self_id: '11111', nickname: '普通小糖人', name: '普通号', status: 'connected' },
    { index: 1, self_id: '22222', nickname: '沙盒小糖人', name: '独立号', status: 'connected' },
  ] } }))
  await page.route('**/api/nest/features**', async route => {
    const request = route.request()
    if (new URL(request.url()).pathname === '/api/nest/features') return route.fulfill({ json: { items: [
      { id: 'qq_bridge', name: 'QQ 桥', settings: schema },
    ] } })
    if (request.method() === 'PUT') {
      settingWrites.push(request.postDataJSON().values)
      return route.fulfill({ json: { schema, values: settingWrites.at(-1), configured: true, updated_at: 'now' } })
    }
    settingsReads++
    return route.fulfill({ json: { schema, values: { 'proactive.day_tokens': 24000, 'proactive.min_minutes': 90, 'owner.qq': settingsReads > 1 ? 'updated-owner' : 'old-owner' }, configured: true, updated_at: 'now' } })
  })
  await page.route('**/api/exploration-projects**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/personal-space')) {
      assert.equal(request.headers()['x-exploration-dashboard'], '1')
      return route.fulfill({ json: { location: 'sandbox-personal/role-workspace', sources: 2,
        docs: ['docs/README.md', 'docs/task-log.md'], items: [
          { id: 'private-1', text: '我的独立记忆 <script>window.MEMORY_HACKED=true</script>', review_status: 'approved', perspective: 'reflection', reviewer: 'sandbox-role:dashiyin', state: 'active' },
        ] } })
    }
    if (path.endsWith('/personal-space/document')) return route.fulfill({ json: { content: '# 个人工作手册\n主项目只读，修改留在工作区。' } })
    if (path.endsWith('/wallets')) {
      assert.equal(request.headers()['x-exploration-dashboard'], '1')
      if (request.method() === 'PUT') {
        const body = request.postDataJSON(); globalWrites.push({ path, body })
        wallet = { id: 'wallet-1', persona: body.persona, speaker: body.speaker, base_url: body.base_url, model: body.model,
          token_limit: body.add_tokens, charged: 0, remaining: body.add_tokens, has_key: true, enabled: body.enabled }
        return route.fulfill({ json: { id: 'wallet-1' } })
      }
      return route.fulfill({ json: { items: wallet ? [wallet] : [] } })
    }
    if (path.endsWith('/autonomy')) {
      assert.equal(request.headers()['x-exploration-dashboard'], '1')
      if (request.method() === 'PUT') { clockConfig = request.postDataJSON(); globalWrites.push({ path, body: clockConfig }); return route.fulfill({ json: { ok: true } }) }
      return route.fulfill({ json: { settings: clockConfig, clock: null, notifications: [], threads: [
        { persona: 'dalaoda', speaker: 'dashiyin', state: 'ready', notes: '', next_at: 0 },
      ] } })
    }
    if (request.method() === 'POST') {
      assert.equal(request.headers()['x-exploration-dashboard'], '1')
      approvals.push({ path, body: request.postDataJSON() })
      if (path.endsWith('/approve')) approved = true
      if (path.endsWith('/pause')) paused = true
      return route.fulfill({ json: { ok: true } })
    }
    if (path.endsWith('/files')) return route.fulfill({ json: { items: [{ path: 'notes/diary.md', content: '<script>window.PROJECT_HACKED=true</script>' }] } })
    return route.fulfill({ json: {
      runtime: { available: agentReady, reason: agentReady ? '本地 Linux 容器镜像就绪；网络关闭' : '未安装 Docker；禁止回退到宿主执行', agent_available: agentReady },
      items: [{ id: 'project-1', persona: 'dalaoda', speaker: 'dashiyin', title: '鱼鱼观察日记', goal: '只在工作区做实验',
        progress: '', state: paused ? 'paused' : 'open', events: [], grants: [],
        requests: [{ id: 'request-1', reason: '好想把这个项目做完呀', state: approved ? 'approved' : 'pending' }],
      }],
    } })
  })
  await page.route('**/api/qq-bridge/exploration**', async route => {
    const request = route.request()
    if (request.method() === 'POST') {
      writes.push(new URL(request.url()).pathname)
      stopped = request.url().endsWith('/stop')
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ json: {
      day: '2026-10-19', run_limit: 12000, day_limit: 24000, input: 3210, output: 490,
      charged: 3700, stopped, uncertain, runs: [], artifacts: [
        { run_id: 'run-1', step: 0, kind: 'document', synced: 0,
          content: JSON.stringify({ title: '烘焙收藏夹', body: '仅为草稿 <script>window.HACKED=true</script>' }) },
      ],
    } })
  })
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.getByRole('heading', { name: '自主活动与沙盒', exact: true }).waitFor()
  await page.getByText(/等待后台调度/).waitFor()
  assert.equal(await page.getByText(/1970/).count(), 0)
  await page.getByText('她的独立记忆与工作手册', { exact: true }).click()
  await page.getByRole('button', { name: '查看个人记忆与文档' }).click()
  await page.getByText(/原始依据 2 条/).waitFor()
  await page.getByRole('button', { name: 'docs/README.md', exact: true }).click()
  await page.getByText(/个人工作手册/).waitFor()
  await page.getByText(/她已收录 · 自述与感想/).click()
  await page.getByText(/我的独立记忆 <script>/).waitFor()
  assert.equal(await page.evaluate(() => window.MEMORY_HACKED), undefined)
  await page.getByRole('textbox', { name: '钱包 API 地址' }).fill('https://wallet.invalid/v1')
  await page.getByRole('textbox', { name: '钱包模型', exact: true }).fill('own-model')
  await page.getByLabel('钱包 API Key').fill('test-only-secret')
  await page.getByRole('spinbutton', { name: '钱包追加 token', exact: true }).fill('12000')
  await page.getByRole('checkbox', { name: '启用角色钱包' }).check()
  await page.getByRole('button', { name: '保存独立钱包' }).click()
  await page.getByText(/累计额度 12000/).waitFor()
  assert.equal(await page.getByLabel('钱包 API Key').inputValue(), '')
  assert.equal(await page.locator('body').innerText().then(t => t.includes('test-only-secret')), false)
  await page.getByRole('checkbox', { name: '启用独立自主活动' }).check()
  await page.getByRole('spinbutton', { name: '轮间歇息（分钟）', exact: true }).fill('2')
  await page.getByRole('combobox', { name: '沙盒专用 QQ 账号', exact: true }).selectOption({ label: '沙盒小糖人（22222） · 独立号' })
  await page.getByRole('button', { name: '保存独立活动设置' }).click()
  await page.getByRole('button', { name: '保存独立活动设置' }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelectorAll('[role="status"]').length > 0)
  assert.equal(globalWrites[1].body.continuation_minutes, 2)
  assert.equal(globalWrites[1].body.qq_account_index, 1)
  assert.equal(globalWrites[1].body.continuous, true)
  assert.equal(settingWrites.length, 0)
  await page.getByText(/输入 3,210/).waitFor()
  await page.getByText(/等待记忆来源接收/).click()
  await page.getByText(/仅为草稿 <script>/).waitFor()
  assert.equal(await page.evaluate(() => window.HACKED), undefined)
  await page.getByRole('button', { name: '今天先休息' }).click()
  await page.getByRole('button', { name: '恢复今天的活动' }).waitFor()
  await page.getByRole('button', { name: '恢复今天的活动' }).click()
  assert.deepEqual(writes, ['/api/qq-bridge/exploration/stop', '/api/qq-bridge/exploration/resume'])
  stopped = true; uncertain = true
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByText(/今天已停止自主调用/).waitFor()
  assert.equal(await page.getByRole('button', { name: '恢复今天的活动' }).isDisabled(), true)
  await page.getByText('好想把这个项目做完呀', { exact: false }).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: '隔离 Python 执行' }).isDisabled(), true)
  assert.equal(await page.getByRole('checkbox', { name: '工作区 Codex' }).isDisabled(), true)
  await page.getByRole('checkbox', { name: '公开网页只读' }).check()
  await page.getByRole('spinbutton', { name: '追加 token', exact: true }).fill('24000')
  await page.getByRole('button', { name: '批准本次资源' }).click()
  await page.getByRole('button', { name: '批准本次资源' }).waitFor({ state: 'hidden' })
  assert.deepEqual(approvals[0], { path: '/api/exploration-projects/requests/request-1/approve',
    body: { tokens: 24000, hours: 2, capabilities: ['document', 'web_read'] } })
  approved = false; agentReady = true
  await page.getByRole('button', { name: '刷新项目' }).click()
  await page.getByRole('checkbox', { name: '工作区 Codex' }).check()
  await page.getByRole('button', { name: '批准本次资源' }).click()
  await page.getByRole('button', { name: '批准本次资源' }).waitFor({ state: 'hidden' })
  assert.deepEqual(approvals[1].body, { tokens: 12000, hours: 2, capabilities: ['document', 'codex'] })
  await page.getByText('鱼鱼观察日记 · dashiyin · 进行中').click()
  await page.getByRole('button', { name: '查看工作区文件' }).click()
  await page.getByText('notes/diary.md', { exact: true }).click()
  await page.getByText('<script>window.PROJECT_HACKED=true</script>', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.PROJECT_HACKED), undefined)
  await page.getByRole('button', { name: '暂停项目并撤销授权' }).click()
  await page.getByText('鱼鱼观察日记 · dashiyin · 已暂停').waitFor()
  await page.getByText('QQ 娱乐互动与通知设置', { exact: true }).click()
  await page.getByText('QQ 娱乐最短间隔', { exact: true }).waitFor()
  assert.equal(await page.getByText('QQ 通知主人', { exact: true }).count(), 0)
  assert.equal(await page.getByText('旧普通活动每日预算', { exact: true }).count(), 0)
  await page.getByText('QQ 娱乐最短间隔', { exact: true }).locator('../..').locator('input').fill('120')
  await page.getByRole('button', { name: '存下来（立刻生效）', exact: true }).click()
  await page.getByRole('button', { name: '没有改动', exact: true }).waitFor()
  assert.deepEqual(settingWrites[0], { 'proactive.day_tokens': 24000, 'proactive.min_minutes': 120, 'owner.qq': 'updated-owner' })
  await page.goto('http://127.0.0.1:' + server.address().port + '/?qq')
  await page.getByText('QQ 通知主人', { exact: true }).waitFor()
  assert.equal(await page.getByText('普通活动每日预算', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('heading', { name: '小糖人的自主活动' }).count(), 0)
  assert.equal(await page.getByRole('link', { name: '小窝设置 → 自主活动与沙盒' }).getAttribute('href'), '#autonomous-activity')
  assert.deepEqual(errors, [])
  console.log('Global activity UI: usage, approvals, workspace, pause, scoped settings preservation and QQ relocation passed.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
