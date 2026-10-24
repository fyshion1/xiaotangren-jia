// Account selection stays human-readable; fixtures never connect to real QQ.
import { chromium } from '@playwright/test'
import { build } from './feature-build.mjs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({stdin:{contents:`
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import Select from './src/components/QqAccountSelect';
function App(){const [sandbox,S]=useState(null),[bridge,B]=useState(0);return <>
<Select label="沙盒专用 QQ 账号" value={sandbox} onChange={S} nullable/>
<Select label="主动联系使用的 QQ 账号" value={bridge} onChange={B} settings={{accounts:[
 {self_id:'99999',enabled:false},{self_id:'11111',name:'普通号'},{self_id:'22222',name:'沙盒号'}]}}/>
<pre id="state">{JSON.stringify({sandbox,bridge})}</pre><button onClick={()=>S(99)}>模拟旧绑定失效</button></>}
createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})
const server=createServer((req,res)=>{
  res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html')
  res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<meta charset="UTF-8"><div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try{
  browser=await chromium.launch({headless:true,executablePath:process.argv[2]})
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
  let fail=false
  await page.route('**/api/qq-bridge/setup/choices',route=>{
    assert.equal(route.request().headers()['x-exploration-dashboard'],'1')
    return route.fulfill(fail?{status:503,json:{detail:'offline'}}:{json:{items:[
      {index:0,self_id:'11111',nickname:'芳月诗音',name:'普通号',status:'connected'},
      {index:1,self_id:'22222',nickname:'樱雪诗凛',name:'沙盒号',status:'connected'}]}})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const sandbox=page.getByRole('combobox',{name:'沙盒专用 QQ 账号'})
  const bridge=page.getByRole('combobox',{name:'主动联系使用的 QQ 账号'})
  await sandbox.selectOption({label:'樱雪诗凛（22222） · 沙盒号'})
  await bridge.selectOption({label:'樱雪诗凛（22222） · 沙盒号'})
  const state=async()=>JSON.parse(await page.locator('#state').innerText())
  assert.deepEqual(await state(),{sandbox:1,bridge:1})
  assert.equal(await bridge.locator('option').filter({hasText:'99999'}).count(),0)
  fail=true
  await page.getByRole('button',{name:'刷新账号昵称'}).first().click()
  await page.getByRole('status').filter({hasText:'原有绑定保持不变'}).waitFor()
  assert.deepEqual(await state(),{sandbox:1,bridge:1})
  await sandbox.selectOption({label:'不绑定 QQ 账号'})
  assert.equal((await state()).sandbox,null)
  await page.getByRole('button',{name:'模拟旧绑定失效'}).click()
  assert.equal(await sandbox.inputValue(),'99')
  assert.match(await sandbox.locator('option:checked').innerText(),/原绑定账号暂未找到/)
  assert.deepEqual(errors,[])
  console.log('Named QQ account selectors passed: labels, enabled order, numeric persistence, unbind and failures')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
