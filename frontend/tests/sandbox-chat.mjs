// Isolated conversation UI; every API request is intercepted, no paid model or QQ.
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundled = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
  import ChatView from './src/components/ChatView';
  const c = {id:'dashiyin',name:'大诗音',emoji:'🌸',avatar:'',portrait:'',about:'',jp:'',personality:[],likes:[],dislikes:[],forms:[]};
  createRoot(document.getElementById('root')).render(<ChatView characters={[c]} onOpenProfile={()=>{}} onOpenSelf={()=>{}} onOpenMemoryPicks={()=>{}} onOpenNest={()=>{}} onSwitchForm={()=>{}}/>);`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
})
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/bundle.js' ? bundled.outputFiles[0].text : '<!doctype html><meta charset="UTF-8"><div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.argv[2] || process.env.CHROME_PATH || undefined })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], writes = [], life = []
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message) })
  await page.route('**/api/**', async route => {
    const req = route.request(), u = new URL(req.url()), path = u.pathname
    if (path === '/api/expert') return route.fulfill({json:{enabled:true,autonomy_installed:true}})
    if (path === '/api/nest/api-config') return route.fulfill({json:{configured:true,config:{base_url:'http://fixture/v1',model:'fixture',api_key:'',vision_model:'fixture'}}})
    if (req.method() === 'POST') writes.push({ path, body: req.postDataJSON() })
    if (path === '/api/exploration-projects/conversations') return route.fulfill({ json: { items: [{
      id: 'sandbox-dashiyin', kind: 'single', name: '大诗音 · 沙盒生活', emoji: '🌱', subtitle: '持续生活 · 独立钱包', characterIds: ['dashiyin'], sandbox: true,
    }] } })
    if (path === '/api/exploration-projects/conversations/message') {
      assert.equal(req.headers()['x-exploration-dashboard'], '1')
      const body = req.postDataJSON()
      assert.equal(body.persona, 'dalaoda'); assert.equal(body.speaker, 'dashiyin')
      life.push({ id: 'owner', seq: 1, role: 'user', content: body.text, kind: 'text' })
      return route.fulfill({ json: { accepted: true, message: '已送到沙盒，使用现有额度' } })
    }
    if (path === '/api/messages') return route.fulfill({ json: { items: u.searchParams.get('session') === 'sandbox-dashiyin' ? life : [], next_cursor: null, has_more: false, total: life.length } })
    if (path === '/api/settings') return route.fulfill({ json: { group_roster: '[]' } })
    if (path === '/api/characters') return route.fulfill({ json: [] })
    return route.fulfill({ json: { items: [], engines: [], voices: [] } })
  })
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.getByText('大诗音 · 沙盒生活', { exact: true }).first().click()
  await page.locator('textarea').fill('你今天想探索些什么？')
  await page.locator('textarea').press('Enter')
  await page.getByText('你今天想探索些什么？', { exact: true }).waitFor()
  assert.deepEqual(writes.map(w => w.path), ['/api/exploration-projects/conversations/message'])
  life.push({ id: 'life-response', seq: 2, role: 'assistant', content: '我刚读了大家的聊天，想画一条蓝色大肥鱼。', kind: 'text' })
  await page.getByText('我刚读了大家的聊天，想画一条蓝色大肥鱼。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '语音通话', exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('Sandbox conversation: independent session, wallet-only text intake and polled replies passed.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
