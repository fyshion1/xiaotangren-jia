// Run after npm run build: node tests/visual-smoke.mjs [path/to/chrome.exe]
// All API requests are intercepted; this test never writes to the application database.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const artifacts = await mkdtemp(join(tmpdir(), 'xtr-visual-'))
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
  p.on('pageerror', (e) => errors.push(e.stack || e.message))
  const writes = []
  const stored = []
  let privateSticker = false
  const img = '/visual/images/gal-193cace93192.png'
  const chars = ['dashiyin', 'xiaoshiyin', 'xiaobai', 'xiaohongshutou'].map((id, i) => ({
    id,
    name: ['大诗音', '小诗音', '小白', '小红薯头'][i],
    emoji: '🌸',
    avatar: img,
    portrait: img,
    about: '温柔的日常里，一起喝一杯热可可。',
    jp: '',
    personality: [],
    likes: [],
    dislikes: [],
    forms: [],
  }))
  const fixtures = [
    {
      id: 'public1',
      orig: img,
      thumb: img,
      owner: '',
      kind: 'image',
      description: '共同相片',
      private: false,
    },
    {
      id: 'private1',
      orig: img,
      thumb: img,
      owner: '',
      kind: 'image',
      description: '私密测试图',
      private: true,
    },
  ]
  let event={id:'mw-test',persona_id:'dalaoda',text:'今天大老大求职受挫，随后得知周日休息，积极准备。',details:'岗位：AI产品经理；对象：高先生；准备简历，等待工作日回复。',occurred_at:'2026-10-19T01:43:00+08:00',created_at:'2026-10-19T02:00:00+08:00',revision:'v1',category:'experience',scope:'shared',character_ids:['dashiyin'],state:'active',review_status:'pending',source:'01_源记忆/dalaoda/日常/group/2026-10-19.md',inject:false,core:false,path:'03_长期记忆池/待审核/test.md',evidence:[{role:'user',content:'今天求职没人理，原来是周日，我现在积极准备。'}]}
  const reviews=[]
  let extraApproved=[]
  let expired={...event,id:'mw-expired',text:'未审核的昨日小事',review_status:'expired',expires_at:'2026-10-19T03:00:00+08:00'}
  event.related_reviewed=[{id:'reviewed-before',text:'已经核对：周日学习日语，尚未完成。',review_status:'approved',reason:'shared_source_messages',source_ids:['synthetic-source']}]
  let activitySource={source:'japanese_lab',name:'日语学习',receive:true,organize:true,recall:true,archived:false,installed:true,count:1}
  const activityEvent={seq:1,occurred_at:'2026-10-19T12:00:01+08:00',received_at:'2026-10-19T04:00:02Z',source_feature_id:'japanese_lab',event_id:'question-1',revision:1,text:'今天问了は和が如何区分',role:'user',context:'real'}
  await p.route('**/api/**', async (r) => {
    const u = new URL(r.request().url()),
      path = u.pathname,
      method = r.request().method()
    let data = {}
    if(path==='/api/chat/session/web-stream'&&method==='POST'){
      const body=r.request().postDataJSON()
      writes.push(path)
      assert.ok(body.saved_user_id,'web turn must refer to the persisted user message')
      const assistant={id:'server-assistant-1',seq:20,session_id:body.session_id,role:'assistant',content:'界面迁移测试回复',kind:'text',segments:[],image:'',image_source:''}
      return r.fulfill({contentType:'text/event-stream',body:'event: token\ndata: {"text":"界面迁移测试回复"}\n\nevent: done\ndata: '+JSON.stringify({assistant,finish_reason:'stop'})+'\n\n'})
    }
    if(path==='/api/memory/sources/japanese_lab'&&method==='PUT'){
      activitySource={...activitySource,...r.request().postDataJSON()}
      return r.fulfill({json:activitySource})
    }
    if (path === '/api/chat' && method === 'POST') {
      writes.push(path)
      return r.fulfill({
        contentType: 'text/event-stream',
        body: 'event: token\ndata: {"text":"界面迁移测试回复"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
      })
    }
    if (path.endsWith('/review')) {
      const body=r.request().postDataJSON();reviews.push(body)
      if(path.includes('/mw-expired/')){
        expired={...expired,review_status:'pending',keep_pending:true,revision:'restored'}
        return r.fulfill({json:expired})
      }
      event={...event,...body.changes,revision:'v'+(reviews.length+1),review_status:body.action==='approve'?'approved':event.review_status}
      return r.fulfill({json:event})
    }
    if(path==='/api/memory-workflow/organize' && method==='POST'){
      await new Promise(resolve=>setTimeout(resolve,700))
      const body=r.request().postDataJSON()
      assert.ok(body.persona_id)
      assert.equal(body.records,undefined,'one click must not require a selection')
      event={...event,id:'mw-integrated',text:'求职事件完整经过',details:'首次投递，得知休息日后积极准备。',review_status:'pending',revision:'integrated',integration_records:[{id:'mw-test',revision:'original'},{id:expired.id,revision:expired.revision}]}
      return r.fulfill({json:{drafts:[event],detail:'事件草稿已生成，请审核'}})
    }
    if (method !== 'GET') {
      writes.push(path)
      if (path === '/api/messages') {
        const body = r.request().postDataJSON()
        stored.push(body)
        data = { ...body, id: 'saved-' + stored.length, seq: stored.length + 1 }
      }
      return r.fulfill({ json: data })
    }
    if(path==='/api/memory/sources')data={items:[activitySource]}
    else if(path==='/api/memory/events')data={items:[activityEvent],total:1,next_offset:null}
    else if(path==='/api/memory/daily')data={version:'snapshot-1',total:1,sections:[{source_feature_id:'japanese_lab',topic:'日语',count:1,text:activityEvent.text}]}
    else if (path === '/api/memory-workflow') data = { candidates:[...(event.review_status==='pending'?[event]:[]),expired], approved:[...(event.review_status==='approved'?[{...event,summary:event.text,id:'file:mw-test'}]:[]),...extraApproved], fact_candidates:[],source_count:1,sources:[{path:event.source,day:'2026-10-19',session_id:'group',message_count:5}],runs:[{session_id:'group',day:'2026-10-19',status:'blocked',detail:'整理模型拒绝处理；原始聊天和附件已保存在本地'}] }
    else if (path.endsWith('/memory-picks')) data = { persona_id: 'dalaoda', memories: [], database: [], legacy: [] }
    else if (path === '/api/memories/status') data = { available: true, dim: 512 }
    else if (path === '/api/self/status' || path.endsWith('/blocks') || path === '/api/personal-db/tree') data = []
    else if (path === '/api/storage/sessions') data={items:[{session_id:'group',count:1}]}
    else if (path === '/api/attachments/stats') data={sessions:[],orig_bytes:0,thumb_bytes:0,current_session:'group'}
    else if (path === '/api/attachments/list') data={items:[],count:0}
    else if (path === '/api/characters') data = chars
    else if (path === '/api/profiles')
      data = { profiles: [{ ...chars[0], id: 'dalaoda', name: '大老大' }], active_id: 'dalaoda' }
    else if (path === '/api/messages')
      data = {
        items: [
          {
            id: 'm1',
            seq: 1,
            role: 'assistant',
            content: '回来啦，热可可刚刚好。',
            kind: 'text',
            segments: [],
          },
        ],
        total: 1,
        has_more: false,
      }
    else if (path === '/api/gallery') {
      const owner = u.searchParams.get('owner') || ''
      data = {
        items: fixtures.map((g) => ({
          ...g,
          owner,
          private: g.private || (privateSticker && g.id === 'public1'),
        })),
      }
    } else if (path === '/api/nest/features')
      data = [
        {
          id: 'english_study',
          name: '英语学习',
          emoji: '📖',
          desc: '一起学英语',
          status: 'available',
          folder: 'english-study',
          needs_vision: false,
        },
        {
          id: 'qq_bridge',
          name: 'QQ 桥',
          emoji: '💬',
          desc: '接入 QQ',
          status: 'available',
          folder: 'qq',
          needs_vision: false,
        },
      ]
    else if (path.includes('inbox') || path.includes('feed') || path.includes('agents') || path.includes('conversations'))
      data = { items: [], events: [] }
    else if (path.includes('worldbook')) data = []
    else if (path.includes('engines')) data = { engines: [] }
    else if (path.includes('voices')) data = { voices: [] }
    return r.fulfill({ json: data })
  })
  await p.goto(baseURL)
  await p.locator('.visual-chat-header').waitFor()
  await p.waitForLoadState('networkidle')
  if(!await p.getByLabel('聊天输入框',{exact:true}).count()) {
    console.log('Initial page:',(await p.locator('body').innerText()).slice(0,1800),'Errors:',errors)
    await p.screenshot({path:join(artifacts,'initial-state.png')})
  }
  await p.getByLabel('聊天输入框',{exact:true}).fill('跨端共享上下文检查')
  await p.getByRole('button',{name:'发送',exact:true}).click()
  await p.getByText('界面迁移测试回复',{exact:true}).filter({visible:true}).first().waitFor()
  assert.ok(writes.includes('/api/chat/session/web-stream'))
  assert.equal(stored.filter(m=>m.role==='assistant').length,0,'server assistant must not be posted again by the browser')
  assert.equal(await p.getByRole('button',{name:'存储管理',exact:true}).filter({visible:true}).count(),0)
  await p.getByLabel('工具与设置',{exact:true}).click()
  await p.getByRole('button',{name:/^记忆$/}).filter({visible:true}).first().click()
  await p.getByText('短期记忆 · 当前会话',{exact:true}).waitFor()
  assert.equal(await p.locator('.context-notebook input[type=checkbox]').count(),0)
  assert.equal(await p.getByRole('button',{name:'重建长期索引'}).count(),0)
  await p.screenshot({path:join(artifacts,'short-term.png')})
  await p.getByRole('button',{name:'关闭',exact:true}).filter({visible:true}).last().click()
  await p.locator('.visual-main-nav button').nth(1).click()
  await p.getByText('个人记忆库',{exact:true}).waitFor()
  await p.getByText('个人数据库',{exact:true}).waitFor()
  assert.equal(await p.locator('.personal-libraries>section').count(),2)
  await p.locator('.memory-event h3').first().waitFor()
  await p.getByText('与已核对的记忆引用了相同原文，请对照确认',{exact:true}).click()
  await p.getByText('已经核对：周日学习日语，尚未完成。',{exact:true}).waitFor({state:'visible'})
  await p.locator('.memory-event').first().screenshot({path:join(artifacts,'related-review.png')})
  await p.getByRole('button',{name:'编辑记忆',exact:true}).click()
  await p.getByLabel('事件摘要',{exact:true}).fill('大老大向高先生投递 AI 产品经理，积极准备工作日沟通。')
  await p.getByLabel('事件详情',{exact:true}).fill('用户修正：这是首次投递，并非面试失败。')
  await p.getByRole('button',{name:'保存修改',exact:true}).click()
  await p.getByText('大老大向高先生投递 AI 产品经理，积极准备工作日沟通。',{exact:true}).waitFor()
  await p.getByText('批准后允许注入',{exact:false}).uncheck()
  await p.getByRole('button',{name:'批准记忆',exact:true}).click()
  await p.getByText('允许注入',{exact:true}).waitFor()
  assert.equal(reviews.at(-1).changes.inject,false)
  assert.equal(reviews.at(-1).changes.details,'用户修正：这是首次投递，并非面试失败。')
  await p.locator('.personal-libraries').screenshot({path:join(artifacts,'dual-libraries.png')})
  await p.getByText('已过期候选（1）',{exact:true}).click()
  await p.getByRole('button',{name:'恢复待审（不过期）',exact:true}).click()
  await p.getByText('未审核的昨日小事',{exact:true}).waitFor()
  assert.equal(expired.keep_pending,true)
  event={...event,review_status:'pending',revision:'pending-again'}
  await p.locator('#persona-memory').getByRole('button',{name:'刷新',exact:true}).click()
  assert.equal(await p.getByText('选择此条用于事件整合',{exact:true}).count(),0)
  p.once('dialog',dialog=>dialog.accept())
  await p.getByRole('button',{name:'一键整理待审记忆',exact:true}).click()
  await p.getByRole('button',{name:'正在整理…',exact:true}).waitFor()
  assert.equal(await p.getByRole('button',{name:'正在整理…',exact:true}).isDisabled(),true)
  await p.getByText('求职事件完整经过',{exact:true}).waitFor()
  await p.getByText('新生成的事件草稿 · 等待你审核',{exact:true}).waitFor()
  assert.equal(await p.getByText('未审核的昨日小事',{exact:true}).count(),0,'bundled originals should leave 03')
  assert.equal(event.review_status,'pending','integration must preview rather than auto approve')
  await p.locator('.personal-libraries').screenshot({path:join(artifacts,'integration-preview.png')})
  await p.getByRole('button',{name:'当天经历与来源',exact:true}).click()
  await p.getByText('今天问了は和が如何区分',{exact:true}).filter({visible:true}).first().waitFor()
  await p.getByText('管理本体和插件来源',{exact:true}).click()
  await p.getByLabel('允许回忆',{exact:true}).uncheck()
  await p.waitForFunction(()=>[...document.querySelectorAll('label')].some(label=>label.textContent.trim()==='允许回忆'&&!label.querySelector('input')?.checked&&!label.querySelector('input')?.disabled))
  assert.equal(await p.getByLabel('允许回忆',{exact:true}).isChecked(),false)
  for (const width of [1440,390,320]) {
    await p.setViewportSize({width,height:1000})
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'activity '+width)
  }
  await p.setViewportSize({width:1440,height:1000})
  await p.locator('.personal-libraries').screenshot({path:join(artifacts,'shared-activity.png')})
  await p.getByRole('button',{name:'02 AI 处理',exact:true}).click()
  await p.getByText(/模型拒绝处理/).waitFor()
  for (const width of [1440,390,320]) {
    await p.setViewportSize({width,height:1000})
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'private '+width)
  }
  await p.setViewportSize({width:1440,height:1000})
  await p.locator('.visual-main-nav button').nth(0).click()
  await p.getByRole('navigation',{name:'小窝分区'}).getByRole('button',{name:/小窝设置/}).click()
  await p.getByRole('navigation',{name:'小窝设置分类'}).getByRole('button',{name:'存储管理',exact:true}).click()
  await p.getByRole('button',{name:'聊天记录',exact:true}).waitFor()
  await p.getByRole('button',{name:'图片与视频',exact:true}).click()
  await p.screenshot({path:join(artifacts,'storage-settings.png')})
  for (const width of [390,320]) {
    await p.setViewportSize({width,height:1000})
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'storage '+width)
  }
  assert.deepEqual(errors,[])
  console.log('PASS: notebook without manual selection, dual libraries, editable event details, approval with injection off, blocked status, storage moved; desktop/mobile; all API mocked')
  console.log('Screenshots:',artifacts)
} finally {
  await browser?.close()
  await new Promise(resolve=>server.close(resolve))
}
