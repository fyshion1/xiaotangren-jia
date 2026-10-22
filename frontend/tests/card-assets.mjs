// Inspect the user's actual PNG cards without importing anything into the live database.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const backend = fileURLToPath(new URL('../../backend/', import.meta.url))
const py = spawnSync(`${backend}/.venv/Scripts/python.exe`, ['-X', 'utf8', '-c', `
import json
from pathlib import Path
from app.services.card_import import read_card
print(json.dumps([read_card(p.read_bytes(), p.name) for p in (Path.cwd().parent/'assets'/'酒馆角色卡').glob('*.png')], ensure_ascii=False))
`], { cwd: backend, encoding: 'utf8' })
if (py.status !== 0) throw new Error(py.stderr)
const cards = JSON.parse(py.stdout)
assert.equal(cards.length, 2)
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import CardHtmlPreview from './src/components/CardHtmlPreview';
    import CardChatMessage from './src/components/CardChatMessage';
    const root=createRoot(document.getElementById('root')); const cards=${JSON.stringify(cards)};
    root.render(<>{cards.map(c=><CardHtmlPreview key={c.name} title={c.name} characterName={c.name} html={c.first_mes} rules={c.display_rules} defaultOpen />)}</>);
    window.chat=()=>root.render(<>{cards.map(c=><div key={c.name} data-character={c.name}><CardChatMessage text={c.first_mes}
      character={{name:c.name,greeting:c.first_mes,greetingSource:c.first_mes,tavernRegexScripts:c.display_rules}}
      mode="html" depth={0} streaming={false} /></div>)}</>);
    window.slow=()=>root.render(<CardHtmlPreview title="Timeout" html={'a'.repeat(60000)+'!'}
      rules={[{findRegex:'/(a+)+$/',replaceString:'x'}]} defaultOpen />);`,
    resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
})
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<style>body{max-width:850px;margin:16px auto}iframe{width:100%;height:900px!important}</style><div id="root"></div><script type="module" src="/app.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ executablePath: process.argv[2] || process.env.CHROME_PATH, headless: true })
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' })
  const kanon = page.frameLocator('iframe[title="朝比奈花音"]')
  await kanon.locator('.mx-root.mx-theatre').waitFor()
  assert.equal(await kanon.locator('.mx-scene').count(), 1)
  assert.equal(await kanon.locator('.mx-st').count(), 1)
  assert.equal(await kanon.locator('.mx-op button').count(), 3)
  const color = await kanon.locator('.mx-root').evaluate(el => getComputedStyle(el).getPropertyValue('--ac').trim())
  assert.equal(color, '#f1c86a')
  const kotori = page.frameLocator('iframe[title="南小鸟"]')
  await kotori.locator('h1').waitFor()
  assert.equal(await kotori.locator('h1').textContent(), '南小鸟')
  assert.ok((await kotori.locator('body > div').first().evaluate(el => getComputedStyle(el).backgroundImage)).includes('zle6vq.gif'))
  const output = fileURLToPath(new URL('../../docs/card-preview-evidence/', import.meta.url))
  await mkdir(output, { recursive: true })
  await page.waitForTimeout(2000)
  await page.locator('iframe[title="朝比奈花音"]').screenshot({ path: `${output}/kanon.png` })
  await page.locator('iframe[title="南小鸟"]').screenshot({ path: `${output}/kotori.png` })
  console.log(JSON.stringify({ cards: cards.map(c => ({ name: c.name, rules: c.display_rules.length })),
    kotoriImageLoaded: await kotori.locator('img').first().evaluate(el => el.complete && el.naturalWidth > 0),
    screenshots: output }, null, 2))
  await page.evaluate(() => window.slow())
  await page.getByText('卡内显示规则执行超时，保留原文', { exact: true }).waitFor()
  await page.getByRole('button', { name: '放大预览', exact: true }).click()
  await page.evaluate(() => window.chat())
  const chatKanon = page.frameLocator('[data-character="朝比奈花音"] iframe')
  await chatKanon.locator('.mx-root.mx-theatre').waitFor()
  assert.equal(await chatKanon.locator('.mx-op button').count(), 3)
  assert.equal(await chatKanon.locator('.mx-root').evaluate(el => getComputedStyle(el).getPropertyValue('--ac').trim()), '#f1c86a')
  await page.frameLocator('[data-character="南小鸟"] iframe').locator('h1').waitFor()
  await page.locator('[data-character="朝比奈花音"]').screenshot({ path: `${output}/kanon-chat.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-character="朝比奈花音"]').screenshot({ path: `${output}/kanon-chat-mobile.png` })
  assert.deepEqual(errors, [])
  console.log('PASS: both real cards render in preview and chat; theatre CSS and 3 options load; slow regex is terminated; desktop/mobile screenshots saved.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
