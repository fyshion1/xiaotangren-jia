// Isolated basic-mode UX; no real accounts, settings, or messages are touched.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Basic from './src/components/QqBasicSettings';import Expert from './src/components/ExpertModeControl';createRoot(document.getElementById('root')).render(<><Basic/><Expert/></>);`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', format: 'iife' })
const server = createServer((req,res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html;charset=utf-8')
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.argv[2] })
  const page = await browser.newPage({ viewport: {width:390,height:844} })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  let enabled = false, saved, exited
  let values = { accounts: [{ self_id:'11111', persona:'one', ws_url:'ws://127.0.0.1:3100/', groups:[], private:[], enabled:true }], 'owner.qq':'99999', 'bridge.selection_required': true, 'asr.engine':'qq', 'voice.engine':'edge', 'voice.voice':'zh-CN-XiaoxiaoNeural', 'sticker.library':[] }
  await page.route('**/api/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname
    let json = {}
    if (path === '/api/expert') {
      if (req.method() === 'PUT') { exited = req.postDataJSON(); enabled = exited.enabled }
      json = { enabled, autonomy_installed:false, qq_accounts:[{self_id:'11111',name:'一号'},{self_id:'22222',name:'二号'}] }
    } else if (path === '/api/characters') json = [{id:'one',name:'小白'}]
    else if (path.endsWith('/settings')) {
      if (req.method() === 'PUT') { saved=req.postDataJSON().values; values={...values,...saved} }
      json={values,schema:[],updated_at:'test'}
    } else if (path.endsWith('/select-basic-account')) {
      assert.equal(req.postDataJSON().self_id,'22222')
      values={...values,'bridge.selection_required':false,accounts:[{self_id:'22222',ws_url:'ws://127.0.0.1:3101/',groups:[],private:[]}]}
    } else if (path.endsWith('/accounts')) json={items:[{id:'22222',name:'二号'}]}
    else if (path.endsWith('/prepare')) json={connection:{self_id:'22222',ws_url:'ws://127.0.0.1:3101/',access_token:'test-only',listen_port:3201},groups:[{id:'33333',name:'测试群'}],private:[]}
    return route.fulfill({json})
  })
  const base=`http://127.0.0.1:${server.address().port}`
  await page.goto(base)
  await page.getByLabel('QQ 简化设置').waitFor()
  assert.equal(await page.getByRole('button',{name:/再加一个/}).count(),0)
  assert.equal(await page.getByText('自主探索',{exact:true}).count(),0)
  await page.getByLabel('保留运行的 QQ').selectOption('22222')
  await page.getByRole('button',{name:'使用这个账号'}).click()
  await page.getByText('当前账号：22222',{exact:true}).waitFor()
  await page.getByRole('button',{name:'读取已登录 QQ'}).click()
  await page.getByRole('button',{name:'自动配置连接并读取名单'}).click()
  await page.getByText('已自动填写。请下拉勾选群和好友，然后保存设置。',{exact:true}).waitFor()
  await page.getByLabel('让谁来聊天').selectOption('group')
  await page.getByLabel('听懂语音').selectOption('local')
  await page.getByRole('button',{name:'保存 QQ 聊天设置'}).click()
  await page.getByText(/已保存。账号连接变化/).waitFor()
  assert.equal(saved.accounts.length,1)
  assert.equal(saved.accounts[0].self_id,'22222')
  assert.equal(saved.accounts[0].persona,'group')
  assert.equal(saved.accounts[0].access_token,'test-only')
  assert.equal(saved['asr.engine'],'local')
  assert.equal(saved['tools.enabled'],undefined)
  assert.equal(saved['proactive.enabled'],undefined)
  enabled=true; await page.reload()
  const close=page.getByRole('button',{name:'关闭专家模式'})
  await close.waitFor(); assert.equal(await close.isDisabled(),true)
  await page.getByLabel('退出后使用的 QQ').selectOption('22222')
  await close.click(); await page.getByText('专家模式已开启',{exact:true}).waitFor({state:'hidden'})
  assert.equal(exited.qq_self_id,'22222')
  assert.deepEqual(errors,[])
  console.log('basic QQ UX: single binding, auto connection, scoped save, expert exit choice passed')
} finally { await browser?.close(); await new Promise(r=>server.close(r)) }
