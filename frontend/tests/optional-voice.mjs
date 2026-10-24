// Validate optional voice UI against an isolated core, without microphones or model calls.
import assert from 'node:assert/strict'
import {chromium} from '@playwright/test'

const url=process.argv[2]
if(!url)throw new Error('Provide the isolated core URL')
const browser=await chromium.launch({headless:true,executablePath:process.argv[3]})
try {
  for(const state of [
    {installed:false,tts_available:false},
    {installed:true,tts_available:false},
    {installed:true,tts_available:true},
  ]) {
    const page=await browser.newPage({viewport:{width:1280,height:900}})
    const errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/api/components',route=>route.fulfill({json:{voice:{...state,local_asr_ready:false,cloud_configured:false}}}))
    await page.route('**/api/voice/engines',route=>route.fulfill({json:[
      {id:'edge',name:'Edge 在线',available:false},
      {id:'piper',name:'Piper 本地',available:true},
    ]}))
    await page.route('**/api/voice/voices?*',route=>route.fulfill({json:[{id:'zh_CN-huayan-medium',name:'测试音色'}]}))
    await page.goto(url)
    await page.getByLabel('聊天输入框',{exact:true}).waitFor()
    await page.locator('.session-item').filter({hasText:'助手'}).click()
    if(state.installed)await page.getByRole('button',{name:'语音通话',exact:true}).first().waitFor()
    assert.equal(await page.getByRole('button',{name:'按住说话',exact:true}).count(),state.installed?1:0)
    assert.equal(await page.getByRole('button',{name:'视频通话',exact:true}).count(),0)
    if(state.tts_available) {
      // Only Piper is available: persisted/default Edge must not stay selected.
      await page.getByRole('button',{name:'🗣 语音：Piper 本地',exact:true}).waitFor()
      assert.equal(await page.evaluate(()=>localStorage.getItem('xtr.speakEngine')),'piper')
    } else {
      assert.equal(await page.getByRole('button',{name:/语音：/}).count(),0)
    }
    if(!state.installed)assert.equal(await page.getByRole('button',{name:'语音通话',exact:true}).count(),0)
    assert.deepEqual(errors,[])
    await page.close()
  }
  console.log('PASS: absent, ASR-only and TTS-ready controls; missing Edge falls back to available Piper; no video placeholder.')
} finally {await browser.close()}
