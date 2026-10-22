// Offline identity creation flow; API writes are mocked.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const bundle=await build({stdin:{contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import HomeView from './src/components/HomeView';
import {createProfile,saveProfile,switchProfile} from './src/api/client';
function App(){const [profiles,setProfiles]=useState([]),[active,setActive]=useState('');return <HomeView
 space characters={profiles} activePersonaId={active} onOpenNest={()=>{}} onEnterChat={()=>{}}
 onCreateProfile={async draft=>{const p=await createProfile(draft);setProfiles(v=>[...v,p]);return p}}
 onSaveChar={async draft=>{const p=await saveProfile(draft);setProfiles(v=>v.map(x=>x.id===p.id?p:x))}}
 onBecomePersona={async id=>{const result=await switchProfile(id);setActive(result.active_id)}}/>}
createRoot(document.getElementById('root')).render(<App/>);
`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx'},bundle:true,write:false,jsx:'automatic',format:'iife',
plugins:[{name:'unrelated-panels',setup(b){b.onLoad({filter:/[\\/](SelfProfilePanel|PersonaMemorySection|PersonalDatabasePanel|PatrolPanel|GalleryGrid|WorldbookPanel|JailbreakPanel)\.tsx$/},()=>({contents:'export default function Panel(){return null}',loader:'tsx'}))}}]})
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<div id="root"></div><script src="/app.js"></script>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
  browser=await chromium.launch({headless:true,executablePath:process.argv[2]})
  const page=await browser.newPage()
  const errors=[],creates=[],updates=[],switches=[]
  let failNext=false
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)})
  await page.route('**/api/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname
    if(path==='/api/profiles' && request.method()==='POST') {
      const body=request.postDataJSON();creates.push(body)
      if(failNext){failNext=false;return route.fulfill({status:500,json:{detail:'保存暂时失败'}})}
      assert(body.name.trim())
      return route.fulfill({json:{...body,id:'persona-test'}})
    }
    if(path.startsWith('/api/profiles/active/')){switches.push(path);return route.fulfill({json:{active_id:'persona-test'}})}
    if(path==='/api/profiles/persona-test' && request.method()==='PUT') {const body=request.postDataJSON();updates.push(body);return route.fulfill({json:body})}
    return route.fulfill({json:{tavern_mode:'false'}})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const add=page.getByTitle('添加一份新的身份档案',{exact:true})
  await add.click()
  assert.equal(creates.length,0,'open draft without creating blank identity')
  await page.getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(creates.length,0,'cancel has no writes')
  await add.click()
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await page.getByRole('alert').getByText('Error: 请先填写身份名字',{exact:true}).first().waitFor()
  assert.equal(creates.length,0,'empty name is rejected locally')
  await page.getByLabel('名字',{exact:true}).fill('新身份测试')
  failNext=true
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await page.getByRole('alert').getByText('Error: 保存暂时失败',{exact:true}).first().waitFor()
  assert.equal(await page.getByLabel('名字',{exact:true}).inputValue(),'新身份测试')
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await page.getByRole('button',{name:'成为',exact:true}).waitFor()
  assert.equal(creates.length,2)
  assert.equal(switches.length,0,'creation does not switch current identity')
  await page.getByRole('button',{name:'成为',exact:true}).click()
  await page.getByRole('button',{name:'使用中',exact:true}).waitFor()
  await page.getByRole('button',{name:/编辑资料/}).click()
  await page.getByLabel('名字',{exact:true}).fill('修改后的身份')
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await page.locator('.persona-card').getByText('修改后的身份',{exact:true}).waitFor()
  assert.equal(updates.length,1)
  assert.equal(updates[0].id,'persona-test')
  assert.deepEqual(errors,[])
  console.log('PASS: draft, cancel, name validation, failed save retry, create, switch, edit existing identity')
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
