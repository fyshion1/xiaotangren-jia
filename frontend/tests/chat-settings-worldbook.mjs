import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import SessionList from './src/components/SessionList';
import {useTavernMode} from './src/lib/tavernMode';
function App(){ const [mode,change]=useTavernMode(); return <>
<button onClick={()=>change(!mode)}>切换酒馆</button>
<div style={{height:600}}><SessionList sessions={[]} activeId="" onSelect={()=>{}} onImport={()=>{}}
cardDisplayMode="chat" onCardDisplayModeChange={()=>{}} /></div></> }
createRoot(document.getElementById('root')).render(<App/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
define: { 'process.env.NODE_ENV': '"production"' } })
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html; charset=utf-8')
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.argv[2] })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let mode = false, reads = 0
  await page.route('**/api/settings', route => {
    if (route.request().method() === 'PUT') mode = route.request().postDataJSON().tavern_mode === 'true'
    return route.fulfill({ json: { tavern_mode: String(mode) } })
  })
  await page.route('**/api/worldbook*', route => {
    reads++
    assert.equal(new URL(route.request().url()).searchParams.get('owner'), '')
    return route.fulfill({ json: [{ id: 'shared', title: '原有共用词条', content: '原始内容', keywords: '关键词', enabled: true, priority: 1, owner: '' }] })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  assert.equal(await page.getByRole('button', { name: '共用世界书', exact: true }).count(), 0)
  assert.equal(reads, 0)
  await page.getByRole('button', { name: '切换酒馆' }).click()
  const entry = page.getByRole('button', { name: '共用世界书', exact: true })
  await entry.waitFor()
  assert.equal(reads, 0)
  await entry.click()
  const dialog = page.getByRole('dialog', { name: '共用世界书', exact: true })
  await dialog.getByText('原有共用词条').waitFor()
  assert.equal(reads, 1)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '切换酒馆' }).click()
  await entry.waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.deepEqual(errors, [])
  console.log('Shared worldbook passed: tavern-only footer, lazy loading, existing data, Escape dismissal, mode-off removal')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
