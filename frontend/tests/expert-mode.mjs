// Real settings navigation and unlock controls, with an isolated local API fixture.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import NestView from './src/components/NestView';
import NetworkAccess from './src/components/NetworkAccess';
createRoot(document.getElementById('root')).render(<><NestView/><aside aria-label="联网入口"><NetworkAccess channel="core"/><NetworkAccess channel="qq_bridge"/><NetworkAccess channel="desktop_pet"/></aside></>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: {'.css':'empty'}, define: { 'process.env.NODE_ENV': '"production"' } })
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html; charset=utf-8')
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({headless:true, executablePath:process.argv[2]})
  const page = await browser.newPage()
  let expert = false, installed = true, networkInstalled = false
  const channels = {core:true,qq_bridge:true,desktop_pet:true}
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    let data = {}
    if (path === '/api/expert') {
      if (request.method() === 'PUT') {
        assert.equal(request.headers()['x-exploration-dashboard'], '1')
        const body = request.postDataJSON()
        if (body.enabled && body.passphrase !== 'xiaotangren') return route.fulfill({status:403,json:{detail:'口令不正确'}})
        expert = body.enabled
      }
      data = {enabled:expert,autonomy_installed:installed,qq_accounts:[{self_id:'11111',name:'first'},{self_id:'22222',name:'second'}]}
    } else if (path.startsWith('/api/tools/network')) {
      if (request.method() === 'PUT') channels[path.split('/').pop()] = request.postDataJSON().enabled
      data = {installed:networkInstalled,channels}
    } else if (path === '/api/nest/features') data = {items:[]}
    else if (path === '/api/compute/config') data = {mode:'delegated',worker_url:'http://127.0.0.1:8010',has_token:true,profile:'full'}
    else if (path.startsWith('/api/gallery')) data = []
    else if (path.includes('/api/plugins/')) return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>独立插件页面</h1>'})
    return route.fulfill({json:data})
  })
  const base = `http://127.0.0.1:${server.address().port}`
  await page.goto(base)
  assert.equal(await page.getByRole('button',{name:/小窝动态/}).count(),0)
  await page.getByRole('button', {name:/小窝设置/}).click()
  const nav = page.getByRole('navigation', {name:'小窝设置分类'})
  for (const name of ['自主活动与沙盒','工具中心','进程管理','功能偏好']) assert.equal(await nav.getByRole('button',{name,exact:true}).count(),0,name)
  assert.equal(await page.getByRole('checkbox',{name:'联网搜索',exact:true}).count(),0)
  assert.equal(await nav.getByRole('button',{name:'委托计算',exact:true}).count(),0)
  const version = page.getByRole('button',{name:'版本 0.1.0'})
  for (let i=0;i<7;i++) await version.click()
  // Password inputs have no implicit textbox role.
  const password = page.getByLabel('探索口令', {exact:true})
  await password.fill('wrong')
  await page.getByRole('button',{name:'开启专家模式',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'口令不正确'}).waitFor()
  await password.fill('xiaotangren')
  await page.getByRole('button',{name:'开启专家模式',exact:true}).click()
  await nav.getByRole('button',{name:'自主活动与沙盒',exact:true}).waitFor()
  assert.equal(await nav.getByRole('button',{name:'进程管理',exact:true}).count(),1)
  await nav.getByRole('button',{name:'委托计算',exact:true}).click()
  await page.getByRole('combobox').waitFor()
  assert.equal(await page.getByRole('combobox').inputValue(),'delegated')
  assert.equal(await nav.getByRole('button').last().innerText(),'委托计算')
  await page.getByRole('button',{name:/小窝动态/}).click()
  await page.getByRole('region',{name:'小窝动态',exact:true}).waitFor()
  assert.equal(await page.getByText('一起看', {exact:true}).count(),0)
  await page.getByRole('button',{name:/小窝设置/}).click()
  assert.equal(await nav.getByRole('button',{name:'功能偏好',exact:true}).count(),0)
  await nav.getByRole('button',{name:'自主活动与沙盒',exact:true}).click()
  await page.frameLocator('iframe[title="自主活动与沙盒"]').getByText('独立插件页面').waitFor()
  assert.equal(await page.getByLabel('退出后使用的 QQ').count(),0)
  const close = page.getByRole('button',{name:'关闭专家模式',exact:true})
  assert.equal(await close.locator('..').getByRole('button',{name:'版本 0.1.0'}).count(),1)
  await close.click()
  await nav.getByRole('button',{name:'自主活动与沙盒',exact:true}).waitFor({state:'detached'})
  assert.equal(await page.locator('iframe').count(),0)
  assert.equal(await nav.getByRole('button',{name:'委托计算',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:/小窝动态/}).count(),0)
  networkInstalled = true
  await page.reload()
  const network = page.getByRole('complementary',{name:'联网入口'}).getByRole('checkbox',{name:'联网搜索'})
  await network.nth(2).waitFor()
  assert.equal(await network.count(),3)
  const saved = page.waitForResponse(response => response.url().endsWith('/api/tools/network/qq_bridge') && response.request().method() === 'PUT')
  await network.nth(1).uncheck()
  await saved
  assert.equal(channels.qq_bridge,false)
  assert.equal(channels.core,true)
  assert.equal(channels.desktop_pet,true)
  expert=true;installed=false
  await page.reload()
  await page.getByRole('button',{name:/小窝设置/}).click()
  await nav.getByRole('button',{name:'进程管理',exact:true}).waitFor()
  assert.equal(await nav.getByRole('button',{name:'自主活动与沙盒',exact:true}).count(),0)
  assert.deepEqual(errors,[])
  console.log('Expert mode passed: hidden unlock, wrong phrase, gated navigation, plugin iframe, revocation, optional installation, channel-specific network controls.')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
