// Isolated component test; every API call is intercepted, no real data/model/QQ access.
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundled = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Catalog from './src/components/QqStickerCatalog';
    createRoot(document.getElementById('root')).render(<Catalog/>);`,
    resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'import.meta.env.VITE_API_BASE': '""', 'process.env.NODE_ENV': '"production"' },
})
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/bundle.js' ? bundled.outputFiles[0].text
    : '<!doctype html><meta charset="UTF-8"><div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.argv[2] || process.env.CHROME_PATH || undefined })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  let item = { id: 'st-1', url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    description: '比心', emotions: ['喜欢'], status: 'ready', manual: false, detail: '' }
  let reads = 0
  const writes = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/qq-bridge/stickers' && request.method() === 'GET') {
      reads++
      return route.fulfill({ json: { items: [item], emotions: ['喜欢', '开心', '感谢', '疑问'] } })
    }
    if (path === '/api/qq-bridge/stickers/st-1' && request.method() === 'PATCH') {
      const body = request.postDataJSON(); writes.push(body)
      item = { ...item, ...body, manual: true }
      return route.fulfill({ json: item })
    }
    throw Error('unexpected API call: ' + request.method() + ' ' + path)
  })
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.getByText('表情的含义与情绪', { exact: true }).waitFor()
  const description = page.getByLabel('表情描述')
  await description.fill('歪头，好像在问怎么啦')
  await page.getByLabel('疑问', { exact: true }).check()
  await page.getByRole('button', { name: '刷新图库' }).click()
  await page.waitForTimeout(3200) // includes the background refresh interval
  assert.ok(reads >= 3)
  assert.equal(await description.inputValue(), '歪头，好像在问怎么啦')
  assert.equal(await page.getByLabel('疑问', { exact: true }).isChecked(), true)
  await page.getByLabel('开心', { exact: true }).check()
  assert.equal(await page.getByLabel('感谢', { exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '保存含义' }).click()
  await page.getByText('已手动修订', { exact: true }).waitFor()
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], { description: '歪头，好像在问怎么啦', emotions: ['喜欢', '疑问', '开心'] })
  assert.equal(await page.getByRole('button', { name: '重新识别' }).isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log('QQ sticker catalog: draft survives refresh; emotion cap and manual save passed.')
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
