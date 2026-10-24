// Run after npm run build: node tests/profile-editing.mjs [path/to/chrome.exe]
// All API requests are intercepted; this test never writes to the application database.
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
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

  let settings = {tavern_installed:'true',tavern_mode:'false'}
  const img = '/visual/images/gal-193cace93192.png'
  const chars = ['dashiyin','xiaohongshutou','imported-test'].map((id,i)=>({id,name:['大诗音','小红薯头','导入测试'][i],jp:i?'':'かほるずき しおん',emoji:'🌸',about:'原有人设',personality:[],likes:[],dislikes:[],portrait:img,forms:[{id:'test-form',name:'测试形态',fields:{likes:[]}}],imported:i===2}))
  chars[2].greeting = '你好，朋友！'
  chars[2].hiddenInProfiles = true
  chars[2].greetingSource = '<style>.card-message{color:rgb(12,34,56)}</style><div class="card-message">你好，朋友！</div>'
  chars[2].tavernRegexScripts = [{findRegex:'/^普通回复$/',replaceString:'<div class="card-message">卡片回复</div>'}]
  chars.push({...chars[2],id:'imported-kanon',name:'朝比奈花音',hiddenInProfiles:false})
  let saved
  await p.route('**/api/**', async r=>{
    const path = new URL(r.request().url()).pathname
    let data={}
    if(path==='/api/characters') data=chars
    else if(path.startsWith('/api/characters/') && r.request().method()==='PUT') {
      saved=r.request().postDataJSON(); Object.assign(chars.find(c=>c.id===saved.id),saved); data=saved
    }
    else if(path==='/api/characters/field-draft') data={value:'烘焙与星空'}
    else if(path==='/api/settings') { if(r.request().method()==='PUT') Object.assign(settings,r.request().postDataJSON()); data=settings }
    else if(path==='/api/profiles') data={profiles:[{...chars[0],id:'dalaoda',name:'大老大'}],active_id:'dalaoda'}
    else if(path==='/api/gallery') data={items:[{id:'g1',orig:img,thumb:img,kind:'image',description:'已有立绘'}]}
    else if(path.includes('worldbook')) data=[]
    else if(path.includes('engines')) data={engines:[]}
    else if(path.includes('voices')) data={voices:[]}
    else if(path==='/api/messages') data=new URL(r.request().url()).searchParams.get('session')==='single-imported-test'
      ? {items:['你好，朋友！','普通回复','<style>body{color:red}</style><p>另一条纯文本</p>'].map((content,i)=>({id:`m-${i}`,seq:i+1,session_id:'single-imported-test',role:'assistant',content,image:'',kind:'text',segments:[]})),has_more:false,total:3}
      : {items:[],has_more:false,total:0}
    else if(path==='/api/nest/features') data={items:[]}
    else if(path.includes('conversations')||path.includes('agents')||path.includes('feed')) data={items:[]}
    await r.fulfill({json:data})
  })
  await p.goto(baseURL)
  await p.getByRole('button',{name:/角色介绍/}).first().click()
  assert.equal(await p.locator('button.member').filter({hasText:'导入测试'}).count(),0)
  assert.equal(await p.locator('button.member').filter({hasText:'朝比奈花音'}).count(),0)
  assert.equal(await p.getByRole('heading',{name:'规则 / 越狱',exact:true}).count(),0)
  await p.getByRole('button',{name:'✎ 编辑资料'}).click()
  for(const field of ['性格（逗号分隔）','喜好（逗号分隔）','讨厌（逗号分隔）']) {
    const input=p.getByLabel(field,{exact:true})
    await input.fill('甜品'); await input.press('End'); await input.pressSequentially(','); assert.equal(await input.inputValue(),'甜品,')
    await input.pressSequentially('游戏，散步、绘画'); assert.equal(await input.inputValue(),'甜品,游戏，散步、绘画')
  }
  await p.getByRole('button',{name:'测试形态',exact:true}).last().click()
  const override=p.getByRole('textbox',{name:'喜好',exact:true})
  await override.fill('饼干'); await override.press('End'); await override.pressSequentially(',曲奇，蛋糕')
  assert.equal(await override.inputValue(),'饼干,曲奇，蛋糕')
  await p.getByRole('button',{name:'基础形态',exact:true}).last().click()
  await p.getByRole('button',{name:'从画廊选择'}).first().click()
  await p.getByRole('button',{name:'已有立绘'}).click()
  await p.getByText('展示与词条设置',{exact:true}).click()
  await p.getByLabel('隐藏胸部',{exact:true}).check()
  await p.getByRole('button',{name:'＋ 新增词条'}).click()
  await p.getByLabel('词条名称',{exact:true}).fill('梦想')
  await p.getByLabel('词条内容',{exact:true}).fill('开一家点心店')
  await p.getByText('生成词条草稿',{exact:true}).click()
  await p.getByLabel('生成哪个词条').selectOption('likes')
  await p.getByRole('button',{name:'生成草稿',exact:true}).click()
  await p.getByLabel('生成的词条草稿').waitFor()
  await p.getByRole('button',{name:'应用到表单',exact:true}).click()
  await p.getByRole('button',{name:'保存',exact:true}).last().click()
  await p.getByRole('button',{name:'✎ 编辑资料'}).waitFor()
  assert.deepEqual(saved.forms[0].fields.likes,['饼干','曲奇','蛋糕'])
  assert.deepEqual(saved.likes,['烘焙与星空'])
  assert.deepEqual(saved.personality,['甜品','游戏','散步','绘画'])
  assert.equal(saved.signature,'Kahoruzuki Shion')
  assert.equal(saved.portrait,img)
  assert(saved.hiddenFields.includes('bust'))
  assert.equal(await p.locator('.attr .k').filter({hasText:/^胸部$/}).count(),0)
  assert.equal(await p.getByRole('heading',{name:/世界书/}).count(),0)
  await p.locator('.member').filter({hasText:'小红薯头'}).click()
  await p.getByRole('button',{name:'✎ 编辑资料'}).click()
  await p.getByText('展示与词条设置',{exact:true}).click()
  await p.getByLabel('在角色介绍中隐藏此角色（可恢复）').check()
  await p.getByRole('button',{name:'保存',exact:true}).last().click()
  await p.getByRole('button',{name:'✎ 编辑资料'}).waitFor()
  assert.equal(await p.locator('button.member').filter({hasText:'小红薯头'}).count(),0)
  await p.getByLabel('显示已隐藏角色').check()
  await p.locator('button.member').filter({hasText:'小红薯头'}).waitFor()
  await p.locator('button.member').filter({hasText:'朝比奈花音'}).click()
  await p.getByText('此角色因酒馆模式关闭而隐藏。开启酒馆模式后可进入她的聊天。',{exact:true}).waitFor()
  await p.getByLabel('显示已隐藏角色').uncheck()
  assert.equal(await p.locator('button.member').filter({hasText:'朝比奈花音'}).count(),0)
  await p.getByLabel('显示已隐藏角色').check()
  await p.locator('button.member').filter({hasText:'朝比奈花音'}).waitFor()
  // Recovery must work for manually hidden imported cards with tavern mode off.
  await p.locator('button.member').filter({hasText:'导入测试'}).click()
  await p.getByRole('button',{name:'✎ 编辑资料'}).click()
  await p.getByText('展示与词条设置',{exact:true}).click()
  await p.getByLabel('在角色介绍中隐藏此角色（可恢复）').uncheck()
  await p.getByRole('button',{name:'保存',exact:true}).last().click()
  await p.getByRole('button',{name:'✎ 编辑资料'}).waitFor()
  assert.equal(chars[2].hiddenInProfiles,false)
  await p.locator('button.member').filter({hasText:'导入测试'}).waitFor()
  await p.getByText('此角色因酒馆模式关闭而隐藏。开启酒馆模式后可进入她的聊天。',{exact:true}).waitFor()
  assert.equal(await p.getByRole('button',{name:'和她聊聊',exact:true}).count(),0)
  await p.getByLabel('显示已隐藏角色').uncheck()
  assert.equal(await p.locator('button.member').filter({hasText:'导入测试'}).count(),0)
  await p.getByLabel('显示已隐藏角色').check()
  await p.locator('button.member').filter({hasText:'导入测试'}).waitFor()
  // The same toggle must repeatedly show and hide native characters, too.
  await p.getByLabel('显示已隐藏角色').uncheck()
  assert.equal(await p.locator('button.member').filter({hasText:'小红薯头'}).count(),0)
  await p.getByLabel('显示已隐藏角色').check()
  await p.locator('button.member').filter({hasText:'小红薯头'}).click()
  await p.getByRole('button',{name:'✎ 编辑资料'}).click()
  await p.getByText('展示与词条设置',{exact:true}).click()
  await p.getByLabel('在角色介绍中隐藏此角色（可恢复）').uncheck()
  await p.getByRole('button',{name:'保存',exact:true}).last().click()
  await p.getByRole('button',{name:'✎ 编辑资料'}).waitFor()
  await p.getByLabel('显示已隐藏角色').uncheck()
  await p.locator('button.member').filter({hasText:'小红薯头'}).waitFor()
  await p.getByRole('button',{name:/聊天.*CONVERSATION/}).click()
  assert.equal(await p.getByRole('button',{name:'导入角色卡（酒馆）'}).count(),0)
  assert.equal(await p.locator('.session-item').filter({hasText:'导入测试'}).count(),0)
  await p.getByRole('button',{name:/糖人小窝.*SUGAR HOME/}).click()
  await p.getByRole('button',{name:/小窝设置/}).click()
  await p.getByRole('button',{name:'酒馆模式',exact:true}).click()
  await p.getByLabel('启用酒馆模式').check()
  await p.waitForFunction(()=>localStorage.getItem('xtr.tavern-mode')==='true')
  await p.getByRole('button',{name:/聊天.*CONVERSATION/}).click()
  await p.getByRole('button',{name:'导入角色卡（酒馆）'}).waitFor()
  await p.locator('.session-item').filter({hasText:'导入测试'}).waitFor()
  await p.locator('.session-item').filter({hasText:'导入测试'}).click()
  await p.getByText('你好，朋友！',{exact:true}).waitFor()
  await p.getByText('另一条纯文本',{exact:true}).waitFor()
  assert.equal(await p.locator('iframe[title="角色卡消息"]').count(),0)
  await p.getByLabel('角色卡显示方式').selectOption('html')
  const greetingFrame=p.frameLocator('iframe[title="角色卡消息"]').first()
  await greetingFrame.locator('.card-message').waitFor()
  assert.equal(await greetingFrame.locator('.card-message').evaluate(el=>getComputedStyle(el).color),'rgb(12, 34, 56)')
  await p.frameLocator('iframe[title="角色卡消息"]').nth(1).getByText('卡片回复',{exact:true}).waitFor()
  assert.equal(await p.frameLocator('iframe[title="角色卡消息"]').nth(1).locator('.card-message').evaluate(el=>getComputedStyle(el).color),'rgb(12, 34, 56)')
  assert.equal(await p.locator('iframe[title="角色卡消息"]').first().getAttribute('sandbox'),'')
  await p.getByLabel('角色卡显示方式').selectOption('chat')
  await p.getByText('普通回复',{exact:true}).waitFor()
  assert.equal(await p.locator('iframe[title="角色卡消息"]').count(),0)
  await p.getByRole('button',{name:/角色介绍/}).first().click()
  await p.getByRole('heading',{name:/世界书/}).waitFor()
  await p.getByRole('heading',{name:'规则 / 越狱',exact:true}).waitFor()
  await p.locator('button.member').filter({hasText:'导入测试'}).click()
  await p.getByRole('button',{name:/糖人小窝.*SUGAR HOME/}).click()
  await p.getByRole('button',{name:/小窝设置/}).click()
  await p.getByRole('button',{name:'酒馆模式',exact:true}).click()
  await p.getByLabel('启用酒馆模式').uncheck()
  await p.getByRole('button',{name:/角色介绍/}).first().click()
  assert.equal(await p.locator('button.member').filter({hasText:'导入测试'}).count(),0)
  assert.equal(await p.getByRole('heading',{name:'规则 / 越狱',exact:true}).count(),0)
  await p.getByRole('button',{name:/聊天.*CONVERSATION/}).click()
  assert.equal(await p.getByLabel('角色卡显示方式').count(),0)
  assert.equal(await p.locator('.session-item').filter({hasText:'导入测试'}).count(),0)
  assert.deepEqual(errors,[])
  // Even when every character is hidden, the recovery toggle stays usable.
  chars.forEach(character => { character.hiddenInProfiles = true })
  await p.reload()
  await p.getByRole('button',{name:/角色介绍/}).first().click()
  assert.equal(await p.locator('button.member').count(),0)
  await p.getByLabel('显示已隐藏角色').check()
  await p.locator('button.member').filter({hasText:'大诗音'}).waitFor()
  await p.locator('button.member').filter({hasText:'小红薯头'}).waitFor()
  await p.locator('button.member').filter({hasText:'导入测试'}).waitFor()
  assert.equal(await p.locator('button.member').count(),chars.length)
  await p.getByLabel('显示已隐藏角色').uncheck()
  assert.equal(await p.locator('button.member').count(),0)
  assert.deepEqual(errors,[])
  console.log('Profile editing, punctuation, gallery selection, field drafts, hiding/recovery and tavern mode passed')
} finally {
  await browser?.close()
  await new Promise(resolve=>server.close(resolve))
}
