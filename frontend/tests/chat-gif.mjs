// Offline browser check: real animated GIF bytes, no application database writes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from './feature-build.mjs'
import { chromium } from '@playwright/test'

const backend = fileURLToPath(new URL('../../backend/', import.meta.url))
const generated = spawnSync(`${backend}/.venv/Scripts/python.exe`, ['-c',
  "import io,base64; from PIL import Image; b=io.BytesIO(); a=Image.new('RGB',(48,48),'red'); a.save(b,format='GIF',save_all=True,append_images=[Image.new('RGB',(48,48),'blue')],duration=180,loop=0); print(base64.b64encode(b.getvalue()).decode())"],
  { encoding: 'utf8' })
assert.equal(generated.status, 0, generated.stderr)
const gif = Buffer.from(generated.stdout.trim(), 'base64')
const thumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=', 'base64')
const fixtures = [
  ['gif', 'upload', '/api/files/test/orig/animation.gif'],
  ['qq', 'qq', '/api/files/test/orig/disguised.png'],
  ['sticker', 'sticker', '/api/files/test/orig/sticker.png'],
  ['static', 'upload', '/api/files/test/orig/photo.png'],
  ['missing', 'qq', '/api/files/test/orig/missing.gif'],
]
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import ChatAttachmentImage from './src/components/ChatAttachmentImage';
    import {toChatMessage} from './src/api/storage';
    const fixtures=${JSON.stringify(fixtures)};
    createRoot(document.getElementById('root')).render(<>{fixtures.map(([id,source,url])=>{
      const message=toChatMessage({id,seq:1,role:'assistant',content:'',image:url,image_source:source,kind:'text',segments:[]});
      return <div id={id} key={id}><ChatAttachmentImage {...message}/></div>;
    })}</>);`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
})
const requests = []
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/files/')) {
    requests.push(req.url)
    if (req.url.includes('/orig/missing.gif')) { res.writeHead(404); res.end(); return }
    // Static thumbnails have only one frame; originals retain the entire GIF.
    const isThumbnail = req.url.includes('/thumb/')
    res.setHeader('Content-Type', isThumbnail ? 'image/png' : 'image/gif')
    res.end(isThumbnail ? thumbnail : gif)
  } else {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script type="module" src="/app.js"></script>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ executablePath: process.argv[2] || process.env.CHROME_PATH, headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => [...document.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0))
  for (const [id, , original] of fixtures.slice(0, 3)) {
    assert.equal(await page.locator(`#${id} img`).getAttribute('src'), original)
  }
  assert.equal(await page.locator('#static img').getAttribute('src'), '/api/files/test/thumb/photo.jpg')
  assert.equal(await page.locator('#missing img').getAttribute('src'), '/api/files/test/thumb/missing.jpg')
  assert.equal(requests.filter(url => url === '/api/files/test/orig/missing.gif').length, 1)
  const frames = new Set()
  for (let i = 0; i < 6; i++) {
    frames.add((await page.locator('#qq img').screenshot({ animations: 'allow' })).toString('base64'))
    await page.waitForTimeout(100)
  }
  assert(frames.size > 1, 'QQ GIF must advance frames automatically, without hover or clicking')
  assert.deepEqual(errors, [])
  console.log('PASS: GIF and QQ/sticker originals autoplay, mislabeled GIF animates, static images keep thumbnails, missing originals fall back once')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
