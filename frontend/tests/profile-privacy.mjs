// Offline component regression; no real profile writes or model requests.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const bundle = await build({stdin:{contents:`
import React from 'react'; import {createRoot} from 'react-dom/client';
import CharacterProfileCard from './src/components/CharacterProfileCard';
import CharacterEditor from './src/components/CharacterEditor';
import {useTavernMode} from './src/lib/tavernMode';
const profile={id:'test',name:'测试角色',about:'日常介绍',age:'25',personality:['开朗'],likes:['阅读'],dislikes:[],
bust:'胸围测试值',hip:'臀围测试值',secret:'秘密测试值',customFields:[{label:'胸部',value:'自定义隐私测试值'},{label:'家乡',value:'杭州'}],
forms:[{id:'other',name:'另一形态',fields:{bust:'形态隐私'}}]};
function App(){const [mode,setMode]=useTavernMode(); return <>
<button onClick={()=>setMode(!mode)}>切换酒馆</button>
<div id="card"><CharacterProfileCard p={profile} onEdit={()=>{}}/></div>
<div id="editor"><CharacterEditor initial={profile} onClose={()=>{}} onSave={value=>{window.saved=value}}/></div>
</>}; createRoot(document.getElementById('root')).render(<App/>);
`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})
const server=createServer((req,res)=>{
  res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html; charset=utf-8')
  res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
  browser=await chromium.launch({headless:true,executablePath:process.argv[2]})
  const page=await browser.newPage()
  const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  let mode=false
  await page.route('**/api/**',route=>{
    if(route.request().method()==='PUT') mode=route.request().postDataJSON().tavern_mode==='true'
    return route.fulfill({json:{tavern_mode:String(mode)}})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const card=page.locator('#card'),editor=page.locator('#editor')
  await card.getByText('25',{exact:true}).waitFor()
  await card.getByText('阅读',{exact:true}).waitFor()
  await card.getByText('杭州',{exact:true}).waitFor()
  assert.equal(await page.getByText('个人隐私词条',{exact:true}).count(),0)
  assert.equal(await editor.locator('textarea').filter({hasText:'秘密测试值'}).count(),0)
  await page.getByRole('button',{name:'切换酒馆',exact:true}).click()
  await card.getByText('个人隐私词条',{exact:true}).waitFor()
  assert.equal(await card.getByText('胸围测试值',{exact:true}).count(),0)
  await card.getByRole('button',{name:'🔒 点开查看私密词条',exact:true}).click()
  for(const text of ['胸围测试值','臀围测试值','秘密测试值','自定义隐私测试值']) {
    const value=card.getByText(text,{exact:true})
    await value.waitFor()
    assert.equal(await value.locator('xpath=ancestor::div[contains(@class,"priv")]').count(),1)
  }
  await page.getByRole('button',{name:'切换酒馆',exact:true}).click()
  await card.getByText('个人隐私词条',{exact:true}).waitFor({state:'detached'})
  for(const text of ['胸围测试值','臀围测试值','秘密测试值','自定义隐私测试值']) assert.equal(await card.getByText(text,{exact:true}).count(),0)
  await editor.getByRole('button',{name:/保存/}).last().click()
  const saved=await page.evaluate(()=>window.saved)
  assert.equal(saved.bust,'胸围测试值')
  assert.equal(saved.hip,'臀围测试值')
  assert.equal(saved.secret,'秘密测试值')
  assert.equal(saved.customFields[0].value,'自定义隐私测试值')
  assert.deepEqual(errors,[])
  console.log('PASS: neutral fields remain visible; private and custom sensitive fields are tavern-only; mode-off save preserves all data')
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
