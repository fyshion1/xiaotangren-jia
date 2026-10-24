// Isolated browser checks; never start or stop real services.
import { chromium } from '@playwright/test'
import { build } from './feature-build.mjs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import ProcessPanel from './src/components/ProcessPanel';
import BrainHealthDot from './src/components/BrainHealthDot';
createRoot(document.getElementById('root')).render(<><ProcessPanel/><BrainHealthDot/></>);
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
  let saved = { backend: true, frontend: true, qq_bridge: true, desktop_pet: true }
  let writes = 0
  let rejectSave = false
  await page.route('**/api/system/startup', async route => {
    if (route.request().method() === 'PUT') {
      if (rejectSave) return route.fulfill({ status: 500, json: { detail: '测试保存失败' } })
      saved = route.request().postDataJSON(); writes++
      return route.fulfill({ json: { settings: saved, message: '已保存，下次用 BAT 启动时生效' } })
    }
    return route.fulfill({ json: { settings: saved, managed: true } })
  })
  await page.route('**/api/system/processes', route => route.fulfill({ json: { items: [], warnings: [], me: { pid: 100 } } }))
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok', name: 'test', pid: 100, started_at: '2026-10-22', uptime_seconds: 10 } }))
  await page.route('**/api/system/restart', route => route.fulfill({ json: { ok: true, message: 'restarting', log: 'test.log' } }))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const choices = page.getByRole('region', { name: '启动与退出' })
  const backend = choices.getByRole('checkbox', { name: /后端大脑/ })
  const frontend = choices.getByRole('checkbox', { name: /前端页面/ })
  const qq = choices.getByRole('checkbox', { name: /QQ 桥与网关/ })
  const pet = choices.getByRole('checkbox', { name: /^桌宠/ })
  await backend.waitFor()
  for (const box of [backend, frontend, qq, pet]) assert.equal(await box.isChecked(), true)
  await backend.uncheck()
  assert.equal(await qq.isChecked(), false)
  assert.equal(await pet.isChecked(), false)
  assert.equal(await frontend.isChecked(), true)
  await page.getByRole('button', { name: '保存下次启动设置' }).click()
  await page.getByRole('status').filter({ hasText: '下次用 BAT 启动时生效' }).waitFor()
  assert.deepEqual(saved, { backend: false, frontend: true, qq_bridge: false, desktop_pet: false })
  await page.reload()
  await backend.waitFor()
  assert.equal(await backend.isChecked(), false)
  await qq.check()
  assert.equal(await backend.isChecked(), true)
  await frontend.uncheck()
  await choices.getByText(/--configure/).first().waitFor()
  rejectSave = true
  await page.getByRole('button', { name: '保存下次启动设置' }).click()
  await page.getByRole('alert').filter({ hasText: '测试保存失败' }).waitFor()
  assert.equal(writes, 1)
  assert.equal(await qq.isChecked(), true)
  // A healthy old PID used to bypass the timeout forever.
  await page.clock.install()
  await page.getByRole('button', { name: '重启大脑' }).click()
  const restarting = page.getByRole('button', { name: '重启中' })
  assert.equal(await restarting.isDisabled(), true)
  for (let i = 0; i < 14; i++) {
    await page.clock.fastForward(5000)
    await page.waitForTimeout(10)
  }
  assert.equal(await page.getByRole('button', { name: '重启大脑' }).isEnabled(), true)
  assert.match(await page.locator('body').innerText(), /重启超时/)
  assert.deepEqual(errors, [])
  console.log('Process management passed: all-on defaults, dependencies, next-boot persistence, save failure, old-PID restart timeout')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
