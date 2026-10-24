// Isolated component test: mock every API request; never spend tokens or write to the database.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './feature-build.mjs'
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import CardImportDialog from './src/components/CardImportDialog';
      createRoot(document.getElementById('root')).render(<React.StrictMode><CardImportDialog
        file={new File(['{}'], 'card.json')} route={{baseUrl:'https://example.invalid/v1',apiKey:'',model:'test'}}
        onClose={()=>{}} onImported={()=>{}} /></React.StrictMode>);`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx',
  },
  bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic',
})
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script type="module" src="/app.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ executablePath: process.argv[2] || process.env.CHROME_PATH, headless: true })
  const page = await browser.newPage()
  const calls = []
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    calls.push(url.pathname)
    if (url.pathname.endsWith('/preview')) {
      assert.equal(url.searchParams.get('extract'), 'false')
      return route.fulfill({ json: {
        spec: 'chara_card_v3', creator: '', tags: [], has_greeting: false,
        profile: { name: 'Manual test', about: '<p>Hello <b>world</b></p>' }, warnings: [], duplicates: [],
      } })
    }
    const extract = url.pathname.includes('/extract/')
    return route.fulfill({ contentType: 'text/event-stream', body: extract
      ? 'event: done\ndata: {"fields":{"age":"20"},"extracted":true,"warnings":[]}\n\n'
      : 'event: done\ndata: {"aboutZh":"你好世界"}\n\n' })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: '抽取词条', exact: true }).waitFor()
  await page.waitForTimeout(500)
  const modelCalls = () => calls.filter(p => !p.endsWith('/preview'))
  assert.equal(modelCalls().length, 0, 'opening preview must not call models (including StrictMode)')
  await page.getByRole('button', { name: '显示格式', exact: true }).click()
  assert.equal(await page.frameLocator('iframe[title="卡片原始排版"]').locator('b').filter({ hasText: 'world' }).count(), 1)
  assert.equal(modelCalls().length, 0, 'format preview must not call models')
  await page.getByRole('button', { name: '抽取词条', exact: true }).click()
  await page.getByText('词条已填好', { exact: true }).waitFor()
  assert.deepEqual(modelCalls(), ['/api/imports/tavern-card/extract/stream'])
  await page.getByRole('button', { name: '翻译成中文', exact: true }).click()
  await page.getByText('你好世界', { exact: true }).waitFor()
  assert.deepEqual(modelCalls(), ['/api/imports/tavern-card/extract/stream', '/api/imports/tavern-card/translate/stream'])
  assert.deepEqual(errors, [])
  console.log('PASS: preview uses no model calls; formatting uses no model calls; extract and translate run only on click.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
