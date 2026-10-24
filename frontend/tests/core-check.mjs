// Read-only browser smoke for a fresh, isolated core. Never send model requests.
import assert from 'node:assert/strict'
import {chromium} from '@playwright/test'

const url=process.argv[2] || 'http://127.0.0.1:8001'
const browser=await chromium.launch({headless:true,executablePath:process.argv[3]})
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}})
  const errors=[],privateReads=[]
  const speechRequests=[]
  page.on('pageerror',error=>errors.push(error.message))
  page.on('request',request=>{
    if(/\/api\/voice\//.test(request.url()))speechRequests.push(new URL(request.url()).pathname)
    if(/\/api\/(self(?:\/|\?)|personal-db\/|knowledge\/|patrol\/)/.test(request.url()))privateReads.push(new URL(request.url()).pathname)
  })
  const characters=await (await page.request.get(`${url}/api/characters`)).json()
  assert.deepEqual(characters.map(item=>item.id),['assistant'])
  const identities=await (await page.request.get(`${url}/api/profiles`)).json()
  assert.equal(identities.profiles.length,1)
  assert.equal(identities.profiles[0].name,'用户')
  const plugins=await (await page.request.get(`${url}/api/plugins`,{headers:{'X-Exploration-Dashboard':'1'}})).json()
  assert.deepEqual(plugins.items,[])
  await page.goto(url)
  await page.getByPlaceholder('输入消息…',{exact:true}).waitFor()
  const components=await (await page.request.get(`${url}/api/components`)).json()
  assert.equal(components.voice.installed,false,'Run this smoke only on a fresh environment without optional voice components')
  for(const label of ['语音通话','视频通话','按住说话']) {
    assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),0,`Unexpected optional voice control: ${label}`)
  }
  assert.equal(await page.getByRole('button',{name:/语音：/}).count(),0)
  assert(!/小糖人|大诗音|大老大|汐子/.test(await page.locator('body').innerText()))
  await page.getByLabel('外观',{exact:true}).click()
  await page.getByRole('region',{name:'外观预设'}).waitFor()
  await page.getByLabel('外观',{exact:true}).click()
  await page.locator('.visual-nav-link').filter({hasText:'私人空间'}).click()
  await page.getByText('个人记忆库',{exact:true}).waitFor()
  assert.equal(await page.getByRole('region',{name:'个人档案管理'}).count(),0)
  assert.equal(await page.getByRole('region',{name:'个人数据库管理'}).count(),0)
  assert(!/小糖人|大诗音|大老大|汐子/.test(await page.locator('body').innerText()))
  await page.goto(`${url}/#plugins`)
  await page.getByText('暂无已安装插件。',{exact:true}).waitFor()
  await page.getByRole('button',{name:'模型连接',exact:true}).click()
  await page.getByRole('heading',{name:'模型连接',exact:true}).waitFor()
  await page.setViewportSize({width:390,height:844})
  await page.goto(url)
  await page.getByRole('navigation',{name:'手机端主导航'}).getByRole('button',{name:'聊天',exact:true}).click()
  await page.getByPlaceholder('输入消息…',{exact:true}).waitFor()
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  assert.deepEqual(privateReads,[])
  assert.deepEqual(speechRequests,[],'Missing optional voice must not start voice API requests')
  assert.deepEqual(errors,[])
  console.log('PASS: isolated core has one assistant/user, no plugins, core memory and model settings, neutral chat and mobile layout; no optional personal-source requests.')
} finally {await browser.close()}
