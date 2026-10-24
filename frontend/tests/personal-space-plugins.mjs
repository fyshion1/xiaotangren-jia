// Synthetic documents only; no real backend or user directories are accessed.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {chromium} from '@playwright/test'
import {build} from './feature-build.mjs'

const bundle=await build({stdin:{contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import SelfProfilePanel from './src/components/SelfProfilePanel';
import PersonalDatabasePanel from './src/components/PersonalDatabasePanel';
function App(){const [persona,setPersona]=useState('one');return <>
<button onClick={()=>window.dispatchEvent(new Event('plugins-changed'))}>刷新插件状态</button>
<button onClick={()=>setPersona(p=>p==='one'?'two':'one')}>切换身份</button>
<SelfProfilePanel personaId={persona}/><PersonalDatabasePanel personaId={persona}/></>}
createRoot(document.getElementById('root')).render(<App/>);
`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx'},bundle:true,write:false,jsx:'automatic',format:'iife',
alias:{'#personal-profile':fileURLToPath(new URL('../../features/personal-profile/frontend',import.meta.url)),
       '#personal-database':fileURLToPath(new URL('../../features/personal-database/frontend',import.meta.url))},
plugins:[{name:'shared-service-panels',setup(b){b.onLoad({filter:/[\\/](KnowledgeLibrary|EmbeddingSettings|PatrolPanel)\.tsx$/},()=>({contents:'export default function SharedPanel(){return null}',loader:'tsx'}));b.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}))}}]})
const styles=(await readFile(new URL('../src/index.css',import.meta.url),'utf8')).replace(/^@(?:import|source).*;$/gm,'')
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><div id="root"></div><script src="/app.js"></script>`)})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
let browser
try {
  browser=await chromium.launch({headless:true,executablePath:process.argv[2]})
  const page=await browser.newPage({viewport:{width:1280,height:900}})
  const errors=[],sourceRequests=[],saves=[]
  let profile=false,database=false,hidden=false
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname
    let data={}
    if(path==='/api/personal-space/panels')data={items:[{id:'personal_profile',enabled:profile,hidden},{id:'personal_database',enabled:database,hidden:false}]}
    else if(path==='/api/characters')data=[]
    else if(path==='/api/self/status'){
      sourceRequests.push(path);const persona=url.searchParams.get('persona_id')
      data=[{title:`测试档案 ${persona}`,filename:'test.md',persona_id:persona,inject:false,visible_to:'all',created_at:'2026-10-24'}]
    } else if(path.startsWith('/api/self/')){
      sourceRequests.push(path)
      const persona=path.split('/')[3]
      const body=req.method()==='PUT'?req.postDataJSON():{title:`测试档案 ${persona}`,content:`资料 ${persona}`,inject:false,visible_to:'all'}
      if(req.method()==='PUT')saves.push({persona,...body})
      data={...body,filename:'test.md',persona_id:persona,created_at:'2026-10-24'}
    } else if(path==='/api/personal-db/tree'){sourceRequests.push(path);data=[]}
    await route.fulfill({json:data})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'刷新插件状态',exact:true}).waitFor()
  assert.equal(sourceRequests.length,0,'disabled plugins never fetch personal documents')
  profile=true
  await page.getByRole('button',{name:'刷新插件状态',exact:true}).click()
  const editor=page.getByRole('region',{name:'个人档案管理'})
  await editor.getByText('测试档案 one',{exact:true}).click()
  await editor.getByRole('textbox',{name:'档案正文'}).fill('修改后的测试资料')
  await editor.getByRole('button',{name:/保存/}).click()
  await page.waitForFunction(()=>document.querySelector('.char-count')?.textContent==='8 字')
  assert.equal(saves[0].persona,'one');assert.equal(saves[0].content,'修改后的测试资料')
  await page.getByRole('button',{name:'切换身份',exact:true}).click()
  await editor.getByText('测试档案 two',{exact:true}).waitFor()
  assert.equal(await editor.getByRole('textbox',{name:'档案正文'}).count(),0)
  database=true
  await page.getByRole('button',{name:'刷新插件状态',exact:true}).click()
  await page.getByRole('region',{name:'个人数据库管理'}).waitFor()
  assert(sourceRequests.includes('/api/personal-db/tree'))
  database=false;hidden=true
  const before=sourceRequests.length
  await page.getByRole('button',{name:'刷新插件状态',exact:true}).click()
  await page.getByRole('region',{name:'个人数据库管理'}).waitFor({state:'detached'})
  await editor.waitFor({state:'detached'})
  assert.equal(sourceRequests.length,before)
  assert.deepEqual(errors,[])
  console.log('PASS: disabled plugins do not fetch documents; optional editors load, save, switch identity, hide and unmount without page reload.')
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
