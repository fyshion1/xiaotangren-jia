// Run after npm run build: node tests/chat-attachments.mjs [path/to/chrome.exe]
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
  p.on('pageerror', (e) => {errors.push(e.message); console.error(e.stack)})
  const turnRequests = []
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
  await p.route('**/api/**', async (r) => {
    const u = new URL(r.request().url()),
      path = u.pathname,
      method = r.request().method()
    let data = {}
    if (path === '/api/nest/api-config') return r.fulfill({json:{config:{base_url:'http://test.invalid/v1',model:'test',api_key:''}}})
    if (path === '/api/chat/session/web-stream' && method === 'POST') {
      turnRequests.push(r.request().postDataJSON())
      const n=turnRequests.length
      const result={assistant:{id:'answer-'+n,seq:100+n,role:'assistant',content:'回复正文'+n,kind:'text',segments:[]},reply_suggestions:['下一句'+n,'好呀']}
      return r.fulfill({contentType:'text/event-stream',body:'event: token\ndata: '+JSON.stringify({text:'回复正文'+n})+'\n\nevent: done\ndata: '+JSON.stringify(result)+'\n\n'})
    }
    if (path === '/api/attachments/batch' && method === 'POST') {
      return r.fulfill({ json: { saved: [{orig: '/api/files/test/orig/image.png',thumb:img}], errors: [] } })
    }
    if (path === '/api/media/video/analyze' && method === 'POST') {
      return r.fulfill({ json: {task_id:'test',frames:Array.from({length:8},(_,i)=>`/api/media-files/test/frames/frame-${i}.jpg`)} })
    }
    if (path === '/api/chat' && method === 'POST') {
      writes.push(path)
      return r.fulfill({
        contentType: 'text/event-stream',
        body: 'event: token\ndata: {"text":"界面迁移测试回复"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
      })
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
    if (path === '/api/characters') data = chars
    else if (path === '/api/profiles')
      data = { profiles: [{ ...chars[0], id: 'dalaolao', name: '大老大' }], active_id: 'dalaolao' }
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
    else if (path.includes('inbox') || path.includes('feed') || path.includes('agents'))
      data = { items: [], events: [] }
    else if (path.includes('worldbook')) data = []
    else if (path.includes('engines')) data = { engines: [] }
    else if (path.includes('voices')) data = { voices: [] }
    return r.fulfill({ json: data })
  })
  await p.goto(baseURL)
  await p.locator('.visual-chat-header').waitFor()
  assert.equal(await p.locator('.reply-suggestion-chips button').count(),0)
  for (let turn=0; turn<3; turn++) {
    if (turn===2) await p.getByRole('button',{name:'收起候选',exact:true}).click()
    await p.locator('.composer-textarea').fill('测试候选'+turn)
    await p.locator('.composer-send').click()
    await p.waitForFunction(()=>!document.querySelector('.composer-send').disabled)
    assert.equal(turnRequests.length,turn+1,'one generation request per user turn')
    assert.equal(turnRequests[turn].reply_suggestions,turn!==2)
    if (turn<2) {
      const chips=p.locator('.reply-suggestion-chips button')
      await p.getByRole('button',{name:'下一句'+(turn+1),exact:true}).waitFor()
      assert.equal(await chips.count(),2)
      await chips.first().click()
      assert.equal(await p.locator('.composer-textarea').inputValue(),'下一句'+(turn+1))
      assert.equal(turnRequests.length,turn+1,'selecting a candidate does not generate')
    } else assert.equal(await p.locator('.reply-suggestion-chips button').count(),0)
  }
  assert.deepEqual(errors,[])
  console.log('PASS: same-response dynamic candidates, replacement, click fills input, collapse disables generation, no additional request')
} finally {
  await browser?.close()
  await new Promise(resolve=>server.close(resolve))
}
