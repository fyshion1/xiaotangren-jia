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
  p.on('pageerror', (e) => errors.push(e.message))
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
    if (path === '/api/chat/session/web-stream' && method === 'POST') {
      return r.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({type:'done', result:{assistant:{id:'answer',seq:100,role:'assistant',content:'reply',kind:'text',segments:[]}}}) + '\n' })
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
  const images = p.locator('input[type="file"][accept="image/*"]').last()
  const videos = p.locator('input[type="file"][accept="video/*"]').last()
  assert.equal(await images.getAttribute('multiple'), '')
  assert.equal(await videos.getAttribute('multiple'), null)
  const image = i => ({name:`photo-${i}.png`,mimeType:'image/png',buffer:Buffer.from('image')})
  await images.setInputFiles(Array.from({length:10},(_,i)=>image(i)))
  await p.getByRole('button',{name:'移除附件 10',exact:true}).waitFor()
  await images.setInputFiles(image(11))
  await p.getByText('每次最多选择 10 个附件，其中图片最多 10 张',{exact:true}).waitFor()
  assert.equal(await p.getByRole('button',{name:/移除附件/}).count(),10)
  await p.getByRole('button',{name:'移除附件 10',exact:true}).click()
  await p.getByRole('button',{name:'移除附件 9',exact:true}).click()
  await videos.setInputFiles({name:'video-1.mp4',mimeType:'video/mp4',buffer:Buffer.from('video')})
  await p.waitForFunction(()=>!document.querySelector('.composer-send').disabled)
  await videos.setInputFiles({name:'video-2.mp4',mimeType:'video/mp4',buffer:Buffer.from('video')})
  await p.getByText('每次最多上传 1 个视频，视频仅在本地抽帧后发送',{exact:true}).waitFor()
  await p.waitForFunction(()=>!document.querySelector('.composer-send').disabled)
  await p.locator('.composer-textarea').fill('一起看看这些附件')
  const requestPromise = p.waitForRequest(r=>r.url().includes('/api/chat/session/web-stream'))
  await p.locator('.composer-send').click()
  await requestPromise
  assert.equal(stored.filter(m=>m.role==='user').length,9)
  assert.equal(stored.filter(m=>m.image_source==='upload').length,8)
  const sentVideos=stored.filter(m=>m.image_source==='video')
  assert.equal(sentVideos.length,1)
  assert.ok(sentVideos.every(m=>m.frames.length===2),'single video uses remaining frame budget')
  assert.equal(stored[0].content,'一起看看这些附件')
  assert.equal(await p.getByRole('button',{name:/移除附件/}).count(),0)
  assert.deepEqual(errors,[])
  console.log('PASS: 10 image selection, overflow rejection, per-item removal, single video limit, local frame analysis, shared frame budget, saved attachments, single model request')
} finally {
  await browser?.close()
  await new Promise(resolve=>server.close(resolve))
}
