// Isolated dev-server test: never edits live plugin state or calls the real backend.
import assert from 'node:assert/strict'
import {cp,mkdir,mkdtemp,rename,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {chromium} from '@playwright/test'

const source = fileURLToPath(new URL('../',import.meta.url))
const root = await mkdtemp(path.join(tmpdir(),'xtr-plugin-management-'))
const frontend = path.join(root,'frontend')
const stateFile = path.join(root,'backend/data/plugin-state.json')
let child, browser
let output = ''
const base = 'http://127.0.0.1:5197'
async function until(check) {
  const deadline = Date.now()+90000
  while(Date.now()<deadline) {
    try {if(await check())return} catch {}
    await new Promise(resolve=>setTimeout(resolve,300))
  }
  throw Error('Timeout\n'+output)
}
try {
  await mkdir(frontend)
  for(const name of ['src','public','tsconfig.json','vite.config.ts','index.html','package.json']) {
    await cp(path.join(source,name),path.join(frontend,name),{recursive:true})
  }
  await symlink(path.join(source,'node_modules'),path.join(frontend,'node_modules'),'junction')
  for(const name of ['xiaotangren-theme','tavern']) {
    await cp(path.resolve(source,'../features',name),path.join(root,'features',name),{recursive:true,filter:file=>!['.git','node_modules','__pycache__'].includes(path.basename(file))})
  }
  await mkdir(path.dirname(stateFile),{recursive:true})
  child = spawn(process.execPath,[path.join(source,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5197','--strictPort'],{cwd:frontend,windowsHide:true,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',data=>output+=data)
  child.stderr.on('data',data=>output+=data)
  await until(async()=> (await fetch(base)).ok)
  browser = await chromium.launch({executablePath:process.argv[2]||process.env.CHROME_PATH||undefined,headless:true})
  const page = await browser.newPage({viewport:{width:1280,height:900}})
  const errors = []
  page.on('pageerror',error=>{errors.push(error.message); console.error('Browser:',error.message)})
  let disabled=false, hidden=false, resourceMode=false
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const owner = {id:'demo',name:'测试角色',about:'保留的设定',avatar:'',personality:[],likes:[],dislikes:[],forms:[]}
  const resourceId = 'a'.repeat(64)
  let uploaded=false, assigned=false
  let applyRequests=0
  let packInstalled=false, packImported=false, packConfirmed=false
  const packMetadata={id:'example.roles',name:'示例角色包',version:'1.0.0',author:'Test author',license:'Test fixtures only',description:'测试角色与图片'}
  const guide={...owner,id:'test-guide',name:'测试向导',characterPackId:'example.roles',personality:[],likes:[],dislikes:[],forms:[]}
  await page.route('**/api/**',async route=>{
    const url = new URL(route.request().url())
    if(!url.pathname.startsWith('/api/')) {await route.continue();return}
    let data={}
    if(url.pathname==='/api/plugins') data={items:[{id:'xiaotangren_theme',name:'小糖人主题与设定',folder:'xiaotangren-theme',installed:true,archived:false,enabled:!disabled,hidden}]}
    else if(url.pathname==='/api/plugins/apply') {
      applyRequests++
      const changes=route.request().postDataJSON().changes
      assert.equal(changes.length,1)
      const change=changes[0]
      assert.equal(change.expected_enabled,!disabled);assert.equal(change.expected_hidden,hidden)
      disabled=!change.enabled;hidden=change.hidden
      await writeFile(stateFile+'.tmp',JSON.stringify({xiaotangren_theme:{disabled,hidden}}))
      await rename(stateFile+'.tmp',stateFile)
      data={message:'已应用全部修改。'}
    } else if(url.pathname.endsWith('/manage')) {
      const action=route.request().postDataJSON().action
      if(action==='hide'||action==='show') hidden=action==='hide'
      else disabled=action==='disable'
      await writeFile(stateFile+'.tmp',JSON.stringify({xiaotangren_theme:{disabled,hidden}}))
      await rename(stateFile+'.tmp',stateFile)
      data={message:'已保存'}
    } else if(url.pathname==='/api/character-packs/catalog') data={items:[{...packMetadata,catalog_id:'local.example',source:'local'}],errors:[]}
    else if(url.pathname==='/api/character-packs') data={items:packImported?[{...packMetadata,installed:packInstalled,characters:[{character_id:'test-guide',available:1}]}]:[]}
    else if(url.pathname==='/api/character-packs/catalog/local.example/preview') data={...packMetadata,token:'a'.repeat(32),sha256:'b'.repeat(64),asset_count:1,installed_version:null,characters:[{template_id:'guide',name:'测试向导',about:'测试设定',existing:false,action:'新增角色'}]}
    else if(url.pathname==='/api/character-packs/install') {
      assert.equal(packConfirmed,true);assert.equal(route.request().postDataJSON().token,'a'.repeat(32))
      packInstalled=true;packImported=true;data={message:'已新增 1 个角色，保留 0 个已有角色及个人修改。'}
    } else if(url.pathname==='/api/character-packs/example.roles/uninstall') {
      packInstalled=false;data={message:'角色包已卸载。已导入角色、个人修改、图片、聊天和记忆保留。'}
    }
    else if(url.pathname==='/api/nest/features') data={items:[]}
    else if(url.pathname==='/api/settings') data={}
    else if(url.pathname==='/api/expert') data={enabled:false}
    else if(url.pathname==='/api/assets' && resourceMode) {
      if(route.request().method()==='POST') {uploaded=true;data={id:resourceId,url:`/api/assets/${resourceId}/content`}}
      else data={items:uploaded?[{id:resourceId,url:`/api/assets/${resourceId}/content`,mime:'image/png',size:imageBytes.length,source:'user-upload',available:true,references:assigned?[{name:owner.name,kind:'characters',owner_id:'demo',field:'avatar'}]:[]}]:[],legacy:[]}
    } else if(url.pathname==='/api/assets/assignment') {
      const body=route.request().postDataJSON()
      assert.equal(body.owner_id,'demo');assert.equal(body.expected_url,'');assigned=true
      owner.avatar=`/api/assets/${resourceId}/content`;data={url:owner.avatar}
    } else if(url.pathname===`/api/assets/${resourceId}/content`) {
      await route.fulfill({contentType:'image/png',body:imageBytes});return
    } else if(url.pathname==='/api/characters' && resourceMode) data=packImported?[owner,guide]:[owner]
    else if(url.pathname==='/api/profiles' && resourceMode) data={profiles:[],active_id:'dalaoda'}
    else if(url.pathname==='/api/characters'||url.pathname==='/api/profiles') {
      await route.fulfill({status:503,json:{detail:'isolated offline test'}});return
    }
    await route.fulfill({json:data})
  })
  await page.goto(base+'/#plugins')
  const panel=page.getByRole('region',{name:'插件管理'})
  await panel.getByRole('button',{name:'关闭插件',exact:true}).waitFor().catch(async error=>{console.error((await page.locator('body').innerText()).slice(0,4000));console.error(output);throw error})
  assert.notEqual(await page.title(),'聊天')
  await panel.getByRole('button',{name:'关闭插件',exact:true}).click()
  assert.equal(disabled,false)
  assert.equal(applyRequests,0)
  await panel.getByRole('button',{name:'放弃修改',exact:true}).click()
  assert.equal(disabled,false)
  await panel.getByRole('button',{name:'关闭插件',exact:true}).click()
  await panel.getByRole('button',{name:'应用修改（1）',exact:true}).click()
  await until(async()=> (await page.title())==='聊天')
  await panel.getByRole('button',{name:'启用插件',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'外观与入场',exact:true}).count(),0)
  for(const label of ['小窝设置','小窝大脑','一起玩','共同回忆']) assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),0)
  assert.equal(await page.getByText('糖人小窝 · v0.1.0',{exact:true}).count(),0)
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundImage),'none')
  await page.locator('.core-appearance>summary').click()
  const appearance=page.getByRole('region',{name:'外观预设'})
  assert.equal(await appearance.getByRole('button').count(),4)
  await appearance.getByRole('button',{name:/森林绿/}).click()
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--pink-deep').trim()),'#32785d')
  await page.reload()
  await panel.getByRole('button',{name:'启用插件',exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.corePalette),'green')
  await page.locator('.core-appearance>summary').click()
  await page.getByRole('region',{name:'外观预设'}).getByRole('button',{name:/石墨灰/}).click()
  await page.keyboard.press('Escape')
  let navigations=0
  const navigation=frame=>{if(frame===page.mainFrame())navigations++}
  page.on('framenavigated',navigation)
  await panel.getByRole('button',{name:'隐藏入口',exact:true}).click()
  assert.equal(hidden,false)
  await panel.getByRole('button',{name:'应用修改（1）',exact:true}).click()
  await panel.getByText('没有待应用修改',{exact:true}).waitFor()
  await new Promise(resolve=>setTimeout(resolve,500))
  assert.equal(navigations,0,'visibility-only changes do not reload the frontend')
  assert.equal(hidden,true)
  page.off('framenavigated',navigation)
  await mkdir(path.join(source,'artifacts/plugins'),{recursive:true})
  await page.screenshot({path:path.join(source,'artifacts/plugins/theme-disabled.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.screenshot({path:path.join(source,'artifacts/plugins/theme-disabled-mobile.png'),fullPage:true})
  resourceMode=true
  await page.getByRole('button',{name:'角色资源',exact:true}).click()
  const resources=page.getByRole('region',{name:'角色资源'})
  await resources.getByLabel('目标档案').selectOption('characters:demo')
  await resources.getByLabel('上传图片').setInputFiles({name:'test.png',mimeType:'image/png',buffer:imageBytes})
  await resources.getByText('已保存“测试角色”的头像。重新进入角色页可查看。',{exact:true}).waitFor()
  assert.equal(uploaded&&assigned,true)
  await until(()=>resources.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0))
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.screenshot({path:path.join(source,'artifacts/plugins/character-assets-mobile.png'),fullPage:true})
  await page.getByRole('button',{name:'插件管理',exact:true}).click()
  const packs=page.getByRole('region',{name:'角色包',exact:true})
  await packs.getByRole('button',{name:'预览角色包',exact:true}).click()
  await packs.getByRole('region',{name:'角色包安装预览'}).waitFor()
  assert.equal(packImported,false)
  await packs.getByText('测试向导 · 新增角色',{exact:true}).waitFor()
  packConfirmed=true
  await packs.getByRole('button',{name:'确认导入（保留已有修改）',exact:true}).click()
  await packs.getByRole('button',{name:'卸载角色包',exact:true}).waitFor()
  assert.equal(packInstalled,true)
  page.once('dialog',dialog=>dialog.accept())
  await packs.getByRole('button',{name:'卸载角色包',exact:true}).click()
  await packs.getByText('1.0.0 · 已卸载，角色保留',{exact:true}).waitFor()
  assert.equal(packImported,true)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.setViewportSize({width:1280,height:900})
  await page.getByRole('button',{name:/角色介绍/}).click()
  await page.getByRole('button',{name:/测试向导/}).click()
  await page.getByRole('button',{name:'移除角色档案',exact:true}).waitFor()
  assert.equal(await page.getByText('此角色因酒馆模式关闭而隐藏。开启酒馆模式后可进入她的聊天。',{exact:true}).count(),0)
  await page.locator('.visual-main-nav').getByRole('button',{name:/设置/}).click()
  await page.getByRole('button',{name:'插件管理',exact:true}).click()
  await panel.getByRole('button',{name:'启用插件',exact:true}).click()
  assert.equal(disabled,true)
  await panel.getByRole('button',{name:'应用修改（1）',exact:true}).click()
  await until(async()=> (await page.title())!=='聊天')
  await panel.getByRole('button',{name:'关闭插件',exact:true}).waitFor()
  assert.deepEqual(errors,[])
  console.log('PASS: plugin controls survive real Vite restarts; theme neutral/re-enable; desktop/mobile resources; character pack preview, explicit import and data-preserving uninstall.')
} finally {
  await browser?.close()
  child?.kill()
  if(child && child.exitCode===null) await new Promise(resolve=>child.once('exit',resolve))
  await rm(path.join(frontend,'node_modules'),{recursive:true,force:true})
  await rm(path.join(root,'features'),{recursive:true,force:true})
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:500}).catch(error=>console.warn('Temporary test directory cleanup:',error.message))
}
