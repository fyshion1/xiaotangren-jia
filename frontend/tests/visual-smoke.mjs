// Run after npm run build: node tests/visual-smoke.mjs [path/to/chrome.exe]
// All API requests are intercepted; this test never writes to the application database.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const artifacts = await mkdtemp(join(tmpdir(), 'xtr-visual-'))
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const file = resolve(
      dist,
      '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
    )
    if (!file.startsWith(dist)) throw Error('invalid path')
    res.setHeader(
      'Content-Type',
      {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.woff2': 'font/woff2',
        '.png': 'image/png',
      }[extname(file)] || 'application/octet-stream',
    )
    res.end(await readFile(file))
  } catch {
    res.statusCode = 404
    res.end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseURL = 'http://127.0.0.1:' + server.address().port
let browser
try {
  const b = (browser = await chromium.launch({
    executablePath: process.argv[2] || process.env.CHROME_PATH || undefined,
    headless: true,
  }))
  const c = await b.newContext({ viewport: { width: 1440, height: 1000 } })
  const p = await c.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  const writes = []
  const stored = []
  let privateSticker = false
  const img = '/visual/images/gal-193cace93192.png'
  const chars = ['dashiyin', 'xiaoshiyin', 'xiaobai', 'xiaohongshutou'].map((id, i) => ({
    id,
    name: ['大诗音', '小诗音', '小白', '小红薯头'][i],
    emoji: '🌸',
    avatar: img,
    portrait: img,
    about: '温柔的日常里，一起喝一杯热可可。',
    jp: '',
    personality: [],
    likes: [],
    dislikes: [],
    forms: [],
  }))
  const fixtures = [
    {
      id: 'public1',
      orig: img,
      thumb: img,
      owner: '',
      kind: 'image',
      description: '共同相片',
      private: false,
    },
    {
      id: 'private1',
      orig: img,
      thumb: img,
      owner: '',
      kind: 'image',
      description: '私密测试图',
      private: true,
    },
  ]
  await p.route('**/api/**', async (r) => {
    const u = new URL(r.request().url()),
      path = u.pathname,
      method = r.request().method()
    let data = {}
    if (path === '/api/chat' && method === 'POST') {
      writes.push(path)
      return r.fulfill({
        contentType: 'text/event-stream',
        body: 'event: token\ndata: {"text":"界面迁移测试回复"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
      })
    }
    if (method !== 'GET') {
      writes.push(path)
      if (path === '/api/messages') {
        const body = r.request().postDataJSON()
        stored.push(body)
        data = { ...body, id: 'saved-' + stored.length, seq: stored.length + 1 }
      }
      return r.fulfill({ json: data })
    }
    if (path === '/api/characters') data = chars
    else if (path === '/api/profiles')
      data = { profiles: [{ ...chars[0], id: 'dalaolao', name: '大老大' }], active_id: 'dalaolao' }
    else if (path === '/api/messages')
      data = {
        items: [
          {
            id: 'm1',
            seq: 1,
            role: 'assistant',
            content: '回来啦，热可可刚刚好。',
            kind: 'text',
            segments: [],
          },
        ],
        total: 1,
        has_more: false,
      }
    else if (path === '/api/gallery') {
      const owner = u.searchParams.get('owner') || ''
      data = {
        items: fixtures.map((g) => ({
          ...g,
          owner,
          private: g.private || (privateSticker && g.id === 'public1'),
        })),
      }
    } else if (path === '/api/nest/features')
      data = [
        {
          id: 'english_study',
          name: '英语学习',
          emoji: '📖',
          desc: '一起学英语',
          status: 'available',
          folder: 'english-study',
          needs_vision: false,
        },
        {
          id: 'qq_bridge',
          name: 'QQ 桥',
          emoji: '💬',
          desc: '接入 QQ',
          status: 'available',
          folder: 'qq',
          needs_vision: false,
        },
      ]
    else if (path.includes('inbox') || path.includes('feed') || path.includes('agents'))
      data = { items: [], events: [] }
    else if (path.includes('worldbook')) data = []
    else if (path.includes('engines')) data = { engines: [] }
    else if (path.includes('voices')) data = { voices: [] }
    return r.fulfill({ json: data })
  })
  await p.goto(baseURL)
  await p.waitForTimeout(2500)
  await p.locator('.visual-chat-header').waitFor()
  await p.evaluate(() => document.fonts.ready)
  assert.equal(await p.locator('[aria-label="选择品牌方案"]').count(), 0)
  assert.equal(
    await p
      .locator('.chat-primary-actions>button')
      .evaluateAll((es) => es.map((e) => e.getAttribute('aria-label')))
      .then((a) => a.join(',')),
    '成员,模型设置,提示词,无审查',
  )
  await p.locator('.composer-candidate-toggle').click()
  assert.equal(await p.locator('#visual-reply-candidates').count(), 0)
  await p.locator('.composer-candidate-toggle').click()
  await p.getByLabel('主题', { exact: true }).click()
  for (const name of ['玫瑰棉糖','夜间星轨','奶油烘焙']) {
    await p.getByRole('button', {name:new RegExp(name)}).click()
  }
  await p.getByRole('button',{name:'切换夜间',exact:true}).click()
  assert.ok(await p.locator('html').evaluate(el=>el.classList.contains('dark')))
  await p.getByRole('button',{name:'切换日间',exact:true}).click()
  await p.getByLabel('主题',{exact:true}).click()

  assert.equal(await p.locator('html').getAttribute('data-palette'), 'cream')
  await p.locator('.visual-chat-title').click()
  assert.equal(await p.locator('.appearance-switcher').getAttribute('open'), null)
  for (const area of ['home', 'nest']) {
    await p
      .locator('.visual-main-nav button')
      .nth(area === 'home' ? 2 : 0)
      .click()
    await p.waitForTimeout(120)
    await p.screenshot({ path: join(artifacts, 'formal-' + area + '.png') })
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  }
  await p.locator('.nest-sticker-manager>summary').click()
  await p.locator('#nest-sticker-left').selectOption('public1')
  await p.locator('.nest-sticker-left .nest-sticker-custom img').waitFor()
  await p.getByRole('button', { name: '调整图片 1 构图' }).first().click()
  await p.getByLabel('上下位置', { exact: true }).first().fill('75')
  await p.getByRole('button', { name: '保存构图', exact: true }).click()
  assert.ok(await p.locator('.composition-status').first().textContent())
  await p
    .getByRole('navigation', { name: '小窝分区' })
    .getByRole('button', { name: /小窝设置/ })
    .click()
  await p.getByRole('switch', { name: '启动动画' }).click()
  for (const name of [
    '小窝大脑',
    '功能偏好',
    '运行与日志',
    '共用世界书',
    'Agent 协作',
    '外观与入场',
  ]) {
    await p
      .getByRole('navigation', { name: '小窝设置分类' })
      .getByRole('button', { name, exact: true })
      .click()
    await p.waitForTimeout(80)
  }
  await p.screenshot({ path: join(artifacts, 'formal-settings.png') })
  for (const width of [390, 320, 900]) {
    await p.setViewportSize({ width, height: 844 })
    for (const area of ['共同回忆', '一起玩', '小窝动态', '小窝设置']) {
      await p
        .getByRole('navigation', { name: '小窝分区' })
        .getByRole('button', { name: new RegExp(area) })
        .click()
      await p.waitForTimeout(100)
      assert.equal(
        await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        area + width,
      )
    }
    await p.screenshot({ path: join(artifacts, 'formal-settings-' + width + '.png') })
  }
  await p.setViewportSize({ width: 1440, height: 1000 })
  privateSticker = true
  await p.reload()
  await p.locator('.visual-main-nav button').nth(0).click()
  await p.waitForTimeout(200)
  assert.equal(await p.locator('.nest-sticker-left').count(), 0, 'private sticker hidden')
  assert.equal(
    await p
      .locator('.nest-room')
      .getByText('私密测试图', { exact: false })
      .isVisible()
      .catch(() => false),
    false,
  )
  assert.equal(writes.length, 0, 'all appearance changes must stay local')
  await p.locator('.visual-main-nav button').nth(3).click()
  await p.locator('.chat-primary-actions [aria-label="模型设置"]').click()
  await p.getByRole('button', { name: '保存并关闭', exact: true }).click()
  await p.getByLabel('聊天输入框', { exact: true }).fill('这是发送回归测试')
  await p.locator('.composer-send').click()
  await p.getByText('界面迁移测试回复', { exact: true }).first().waitFor()
  await p.waitForTimeout(200)
  assert.ok(
    stored.some((m) => m.role === 'assistant' && m.content === '界面迁移测试回复'),
    'assistant response persisted',
  )
  assert.ok(
    stored.some((m) => m.role === 'user' && m.content === '这是发送回归测试'),
    'user message persisted',
  )
  for (const width of [390, 320]) {
    await p.setViewportSize({ width, height: 844 })
    await p.locator('.app-mobile-nav button').nth(1).click()
    await p.locator('.composer-hold').waitFor()
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'mobile chat overflow',
    )
    const input = await p.locator('.composer-textarea').boundingBox()
    assert.ok(input.width > 90, 'textarea has usable flexible width')
    await p.locator('.app-mobile-nav button').nth(2).click()
    await p.locator('.mobile-settings-grid').waitFor()
  }
  console.log(
    'PASS: mocked chat send, assistant/user persistence, model settings, mobile composer and settings',
  )
  console.log('Screenshots:', artifacts)
  assert.deepEqual(errors, [])
  console.log(
    'PASS: themes, dismissal, fixed variants, candidates, live gallery crop, private sticker isolation, 4 rooms / 6 settings, 320/390/900/1440 widths; appearance causes no API writes, chat API mocked',
  )
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
