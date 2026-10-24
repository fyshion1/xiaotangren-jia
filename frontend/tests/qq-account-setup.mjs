// Isolated setup flow: never contacts QQ or changes real gateway settings.
import { chromium } from '@playwright/test'
import { build } from './feature-build.mjs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { contents: `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {AccountsEditor} from './src/components/NestSettingsPanel';
function App() { const [rows,setRows]=useState([]); return <><AccountsEditor
 field={{key:'accounts',label:'QQ',type:'accounts',fields:[
 {key:'self_id',label:'QQ号',type:'text'}, {key:'ws_url',label:'网关地址',type:'text'},
 {key:'listen_port',label:'监听端口',type:'number'}, {key:'access_token',label:'token',type:'text',secret:true},
 {key:'groups',label:'接哪些群',type:'list'}, {key:'private',label:'接哪些人私聊',type:'list'}]}}
 rows={rows} characters={[]} defaults={{'onebot.self_id':'11111','onebot.ws_url':'ws://127.0.0.1:3001/','allow.groups':['99999'],'allow.private':['88888']}}
 onChange={setRows}/><pre id="state">{JSON.stringify(rows)}</pre></> }; createRoot(document.getElementById('root')).render(<App/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
const server = createServer((req,res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<meta charset="UTF-8"><div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
let browser
try {
  browser = await chromium.launch({headless:true,executablePath:process.argv[2]})
  const page = await browser.newPage()
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  let fail = false
  await page.route('**/api/qq-bridge/setup/**', route => {
    if (route.request().url().endsWith('/accounts')) return route.fulfill({json:{items:[{id:'22222',name:'新账号'}]}})
    return route.fulfill({json:{connection:{self_id:'22222',ws_url:'ws://127.0.0.1:3101/',listen_port:3102,access_token:'test-secret'},
      ...(fail ? {warning:'名单读取失败'} : {groups:[{id:'55555',name:'测试群'}],private:[{id:'66666',name:'测试好友'}]})}})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'＋ 再加一个 QQ 号'}).click()
  const state=async()=>JSON.parse(await page.locator('#state').innerText())
  assert.equal((await state()).length,2)
  assert.deepEqual((await state())[0].groups,['99999'])
  assert.deepEqual((await state())[1].private,[])
  await page.getByRole('button',{name:'读取已登录 QQ'}).nth(1).click()
  await page.getByLabel('已登录 QQ').selectOption('22222')
  await page.getByRole('button',{name:'自动配置连接并读取名单'}).nth(1).click()
  await page.waitForFunction(()=>JSON.parse(document.querySelector('#state').textContent)[1].listen_port===3102)
  assert.equal((await state())[1].ws_url,'ws://127.0.0.1:3101/')
  assert.deepEqual((await state())[1].groups,[])
  await page.locator('summary').filter({hasText:'接哪些群'}).nth(1).click()
  await page.getByLabel('测试群（55555）').check()
  assert.deepEqual((await state())[1].groups,['55555'])
  await page.locator('summary').filter({hasText:'接哪些群'}).nth(0).click()
  await page.getByLabel('已保存（99999）').check()
  fail=true
  await page.getByRole('button',{name:'自动配置连接并读取名单'}).nth(1).click()
  await page.getByText('名单读取失败',{exact:true}).waitFor()
  assert.deepEqual((await state())[1].groups,['55555'])
  assert.deepEqual(errors,[])
  console.log('QQ setup browser checks passed')
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)) }
