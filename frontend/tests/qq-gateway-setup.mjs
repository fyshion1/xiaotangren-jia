// Mock-only onboarding acceptance; never downloads or starts a real gateway.
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Setup from './src/components/QqGatewaySetup';createRoot(document.getElementById('root')).render(<Setup/>);`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' })
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html;charset=utf-8')
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/bundle.js"></script>')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.argv[2] })
  const page = await browser.newPage()
  let installed = false, installs = 0
  await page.route('**/api/qq-bridge/setup/**', route => {
    const path = route.request().url().split('/').at(-1)
    assert.equal(route.request().headers()['x-exploration-dashboard'], '1')
    if (path === 'audio') return route.fulfill({ json: { ready: false, checks: { pilk: false, model_files: false }, engine: 'qq', fallback: 'local', instructions: '安装本地语音', note: '静态依赖检查' } })
    if (path === 'diagnostics') return route.fulfill({ json: { installed, folder: 'test-only', versions: ['9.9.30'], message: 'QQ版本较旧', password_hint: '查看初始密码', install_supported: true } })
    if (path === 'release') return route.fulfill({ json: { version: 'v-test', name: 'full.zip', size: 100, notes: '<script>unsafe()</script>' } })
    if (path === 'initial-password') return route.fulfill({ json: { notice: 'initial password: test-only' } })
    installs++; assert.deepEqual(route.request().postDataJSON(), { consent: true, version: 'v-test' }); installed = true
    return route.fulfill({ json: { message: '安装完成，尚未启动' } })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button', { name: '查看官方版本并准备安装' }).click()
  const confirm = page.getByRole('button', { name: '确认安装这个版本' })
  await confirm.waitFor(); assert.equal(await confirm.isDisabled(), true); assert.equal(installs, 0)
  assert.equal(await page.locator('pre script').count(), 0)
  await page.getByRole('checkbox').check(); await confirm.click()
  await page.getByText('安装完成，尚未启动', { exact: true }).waitFor(); assert.equal(installs, 1)
  await page.getByRole('button', { name: '查看启动日志中的初始密码提示' }).click()
  await page.getByText('initial password: test-only', { exact: true }).waitFor()
  await page.getByRole('button', { name: '隐藏密码提示' }).click()
  assert.equal(await page.getByText('initial password: test-only', { exact: true }).count(), 0)
  console.log('gateway onboarding: consent, install, escaped notes, password reveal passed')
} finally { await browser?.close(); await new Promise(r => server.close(r)) }
