// Build in an isolated checkout with no features directory; never move live plugins.
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chromium } from '@playwright/test'

const source = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp(path.join(tmpdir(), 'xtr-no-tavern-'))
const frontend = path.join(root, 'frontend')
async function run(module, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(source, 'node_modules', module), ...args], {
      cwd: frontend, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)))
  })
}
try {
  await mkdir(frontend)
  for (const name of ['src', 'public', 'tsconfig.json', 'vite.config.ts', 'index.html', 'package.json']) {
    await cp(path.join(source, name), path.join(frontend, name), { recursive: true })
  }
  await symlink(path.join(source, 'node_modules'), path.join(frontend, 'node_modules'), 'junction')
  await run('typescript/bin/tsc', ['-b'])
  await run('vite/bin/vite.js', ['build'])
  const assets = path.join(frontend, 'dist', 'assets')
  const files = (await readdir(assets)).filter(name => name.endsWith('.js'))
  const bundle = (await Promise.all(files.map(name => readFile(path.join(assets, name), 'utf8')))).join('\n')
  for (const marker of ['此面板管理额外档案区块', '文件保存在本机；主动使用 AI 整理', 'tavern-card/preview', '卡片原始排版', '卡片显示内容或规则过大', '当前场景背景 · 世界书', '大诗音的小小茶会', '小白也在这里呀', '玫瑰棉糖', '想被你牵着走']) {
    assert.equal(bundle.includes(marker), false, 'Feature implementation leaked into missing-plugin build: ' + marker)
  }
  assert.equal((await readdir(assets)).some(name => name.endsWith('.woff2')), false, 'Theme fonts leaked into core')
  assert.equal(bundle.includes('test · Gemini'), false, 'Gemini session leaked into core')
  const html = await readFile(path.join(frontend, 'dist/index.html'), 'utf8')
  assert(html.includes('<title>聊天</title>'))
  assert.equal(html.includes('xtr.visual.palette'), false)
  assert.equal((await readdir(path.join(frontend, 'dist'))).includes('characters'), false)
  if (process.argv[2]) {
    const dist = path.join(frontend, 'dist')
    const server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, 'http://localhost').pathname
        const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname))
        if (!file.startsWith(dist + path.sep)) { response.writeHead(403).end(); return }
        const mime = {'.js':'text/javascript', '.css':'text/css', '.html':'text/html; charset=utf-8'}
        response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
        response.end(await readFile(file))
      } catch { response.writeHead(404).end() }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    let browser
    try {
      browser = await chromium.launch({headless:true, executablePath:process.argv[2]})
      const page = await browser.newPage({viewport:{width:1280,height:800}})
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      // Exercise the neutral offline defaults, without an actual running backend.
      await page.route('**/api/**', route => route.fulfill({status:503,json:{detail:'offline test'}}))
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      await page.getByText('助手', {exact:true}).first().waitFor()
      for(const name of ['语音通话','视频通话','按住说话'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0)
      assert.equal(await page.title(), '聊天')
      assert.equal(await page.getByText('大诗音', {exact:true}).count(), 0)
      await page.locator('.visual-nav-link').filter({hasText:'设置'}).click()
      await page.getByRole('navigation', {name:'功能分区'}).getByRole('button', {name:'设置 偏好与连接'}).click()
      await page.getByRole('button', {name:'模型连接',exact:true}).waitFor()
      assert.equal(await page.getByRole('button', {name:'外观与入场',exact:true}).count(), 0)
      for (const viewport of [{width:1280,height:800},{width:390,height:844}]) {
        await page.setViewportSize(viewport)
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.getByText('助手', {exact:true}).first().waitFor()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      }
      assert.deepEqual(errors, [])
      let created = null, failNext = true
      await page.route('**/api/characters', async route => {
        if (route.request().method() !== 'POST') return route.fulfill({json:[]})
        if (failNext) {failNext=false;return route.fulfill({status:500,json:{detail:'保存失败，请重试'}})}
        created={...route.request().postDataJSON(),id:'test-assistant'}
        return route.fulfill({json:created})
      })
      await page.setViewportSize({width:1280,height:800})
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      await page.getByRole('heading',{name:'创建你的第一位助手'}).waitFor()
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.corePalette),'warm')
      await page.getByRole('button',{name:'创建助手',exact:true}).click()
      await page.getByRole('button',{name:'取消',exact:true}).click()
      assert.equal(created,null)
      await page.getByRole('button',{name:'创建助手',exact:true}).click()
      await page.getByLabel('助手名称',{exact:true}).fill('测试助手')
      await page.getByLabel('角色设定',{exact:true}).fill('用于界面验证的虚构角色')
      await page.getByRole('button',{name:'创建并开始聊天'}).click()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.getByLabel('助手名称',{exact:true}).inputValue(),'测试助手')
      await page.getByRole('button',{name:'创建并开始聊天'}).click()
      await page.getByLabel('聊天输入框',{exact:true}).waitFor()
      assert.equal(created.name,'测试助手')
      assert.equal(await page.locator('.composer-input-row').evaluate(el=>getComputedStyle(el).display),'flex')
      for (const viewport of [{width:1280,height:800},{width:390,height:844}]) {
        await page.setViewportSize(viewport)
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
      }
      assert.deepEqual(errors, [])
      console.log('PASS: warm default, empty assistant prompt, cancel, failed creation retry, chat composer and mobile layout.')
      console.log('PASS: neutral core renders offline defaults and settings on desktop/mobile without theme.')
    } finally {
      await browser?.close()
      await new Promise(resolve => server.close(resolve))
    }
  }
  console.log('PASS: frontend typecheck and production build without optional features; implementations and theme assets absent.')
} finally {
  // Remove the junction first so cleanup never traverses the host dependency directory.
  await rm(path.join(frontend, 'node_modules'), { force: true, recursive: true })
  await rm(root, { force: true, recursive: true })
}
