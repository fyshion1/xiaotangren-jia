// Browser checks for actual iframe rendering and the sandbox boundary.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './feature-build.mjs'
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const source = `<style>body{background:rgb(10,20,30)}.card{color:rgb(12,34,56)}</style>
  <div class="card" id="card">Original card</div>
  <img id="picture" src="https://assets.example.invalid/pixel.png">
  <details><summary>More</summary><span>Details work</span></details>
  <button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>
  <script>
    document.getElementById('card').dataset.ran='yes';
    try { parent.document.body.dataset.escaped='yes'; } catch { document.getElementById('card').dataset.parentBlocked='yes'; }
    try { localStorage.setItem('stolen','yes'); } catch { document.getElementById('card').dataset.storageBlocked='yes'; }
    fetch('/api/forbidden').catch(()=>document.getElementById('card').dataset.fetchBlocked='yes');
  </script>`
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import CardHtmlPreview from './src/components/CardHtmlPreview';
    const root=createRoot(document.getElementById('root'));
    window.changeSource=()=>root.render(<CardHtmlPreview html={'<div id="changed">Changed card</div>'} defaultOpen />);
    root.render(<CardHtmlPreview html={${JSON.stringify(source)}} defaultOpen />);`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
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
  const forbidden = []
  const images = []
  await page.route('**/api/**', route => { forbidden.push(route.request().url()); return route.abort() })
  await page.route('https://assets.example.invalid/**', route => {
    images.push(route.request().url())
    return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=', 'base64') })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const frame = page.frameLocator('iframe')
  await frame.locator('#card').waitFor()
  assert.equal(await frame.locator('#card').evaluate(el => getComputedStyle(el).color), 'rgb(12, 34, 56)')
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
  assert.equal(await frame.locator('#card').getAttribute('data-ran'), null)
  await frame.locator('#counter').click()
  assert.equal(await frame.locator('#counter').textContent(), '0', 'scripts default off')
  await frame.locator('summary').click()
  assert.equal(await frame.locator('details').getAttribute('open'), '')
  await page.getByRole('checkbox', { name: '启用卡内交互脚本' }).check()
  await frame.locator('#card[data-ran="yes"]').waitFor()
  assert.equal(await frame.locator('#card').getAttribute('data-parent-blocked'), 'yes')
  assert.equal(await frame.locator('#card').getAttribute('data-storage-blocked'), 'yes')
  await frame.locator('#card[data-fetch-blocked="yes"]').waitFor()
  await frame.locator('#counter').click()
  assert.equal(await frame.locator('#counter').textContent(), '1', 'opt-in enables card interaction')
  assert.equal(await frame.locator('#picture').evaluate(el => el.complete && el.naturalWidth > 0), true)
  assert.ok(images.length > 0)
  assert.equal(await page.locator('body').getAttribute('data-escaped'), null)
  assert.deepEqual(forbidden, [], 'card scripts cannot call application APIs')
  await page.getByRole('button', { name: '重置预览' }).click()
  await frame.locator('#counter').waitFor()
  assert.equal(await frame.locator('#counter').textContent(), '0')
  await page.evaluate(() => window.changeSource())
  await frame.locator('#changed').waitFor()
  assert.equal(await page.getByRole('checkbox').isChecked(), false, 'new sources require opt-in again')
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), '')
  console.log('PASS: card CSS, images, details, opt-in scripts, reset and host/storage/API isolation.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
