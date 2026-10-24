// Synthetic cards only; no personal PNG files, prompts or live database.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from './feature-build.mjs'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const pluginRoot = process.env.SHIONARIUM_PLUGINS_DIR || resolve(root, '../features')
const tavern = resolve(pluginRoot, 'tavern/frontend')
if (!existsSync(resolve(tavern, 'components/CardHtmlPreview.tsx'))) {
  console.log('SKIP: install the optional tavern plugin or set SHIONARIUM_PLUGINS_DIR to test card rendering.')
  process.exit(0)
}
const cards = [
  { name: '示例角色 A', display_rules: [], first_mes: '<div class="mx-root mx-theatre" style="--ac:#f1c86a"><div class="mx-scene">合成场景</div><div class="mx-st">合成状态</div><div class="mx-op"><button>A</button><button>B</button><button>C</button></div></div>' },
  { name: '示例角色 B', display_rules: [], first_mes: '<div style="background-image:linear-gradient(red,blue)"><h1>示例角色 B</h1></div>' },
]
const bundle = await build({
  alias: { '#tavern': tavern, '#shionarium': resolve(root, 'src') },
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import CardHtmlPreview from './src/components/CardHtmlPreview';
    import CardChatMessage from './src/components/CardChatMessage';
    const root=createRoot(document.getElementById('root')); const cards=${JSON.stringify(cards)};
    root.render(<>{cards.map((c,i)=><CardHtmlPreview key={i} title={c.name} characterName={c.name} html={c.first_mes} rules={c.display_rules} defaultOpen />)}</>);
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
  const kanon = page.frameLocator('iframe[title="示例角色 A"]')
  await kanon.locator('.mx-root.mx-theatre').waitFor()
  assert.equal(await kanon.locator('.mx-scene').count(), 1)
  assert.equal(await kanon.locator('.mx-st').count(), 1)
  assert.equal(await kanon.locator('.mx-op button').count(), 3)
  const color = await kanon.locator('.mx-root').evaluate(el => getComputedStyle(el).getPropertyValue('--ac').trim())
  assert.equal(color, '#f1c86a')
  const kotori = page.frameLocator('iframe[title="示例角色 B"]')
  await kotori.locator('h1').waitFor()
  assert.equal(await kotori.locator('h1').textContent(), '示例角色 B')
  assert.ok((await kotori.locator('body > div').first().evaluate(el => getComputedStyle(el).backgroundImage)).includes('linear-gradient'))
  const output = fileURLToPath(new URL('../artifacts/card-preview/', import.meta.url))
  await mkdir(output, { recursive: true })
  await page.waitForTimeout(2000)
  await page.locator('iframe[title="示例角色 A"]').screenshot({ path: `${output}/kanon.png` })
  await page.locator('iframe[title="示例角色 B"]').screenshot({ path: `${output}/kotori.png` })
  console.log(JSON.stringify({ cards: cards.map(c => ({ name: c.name, rules: c.display_rules.length })),
    screenshots: output }, null, 2))
  await page.evaluate(() => window.slow())
  await page.getByText('卡内显示规则执行超时，保留原文', { exact: true }).waitFor()
  await page.getByRole('button', { name: '放大预览', exact: true }).click()
  await page.evaluate(() => window.chat())
  const chatKanon = page.frameLocator('[data-character="示例角色 A"] iframe')
  await chatKanon.locator('.mx-root.mx-theatre').waitFor()
  assert.equal(await chatKanon.locator('.mx-op button').count(), 3)
  assert.equal(await chatKanon.locator('.mx-root').evaluate(el => getComputedStyle(el).getPropertyValue('--ac').trim()), '#f1c86a')
  await page.frameLocator('[data-character="示例角色 B"] iframe').locator('h1').waitFor()
  await page.locator('[data-character="示例角色 A"]').screenshot({ path: `${output}/kanon-chat.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-character="示例角色 A"]').screenshot({ path: `${output}/kanon-chat-mobile.png` })
  assert.deepEqual(errors, [])
  console.log('PASS: both synthetic cards render in preview and chat; theatre CSS and 3 options load; slow regex is terminated; desktop/mobile screenshots saved.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
