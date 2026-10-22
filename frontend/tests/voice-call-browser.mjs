// Vite must be running on :5173. Isolated harness, fake media, intercepted services.
// No application data, provider credentials, or external services are used.
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks'],
})
try {
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error('page error:', error.message) })
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  await page.route('**/api/voice/call/config', route => route.fulfill({ json: {
    asr_provider: 'bailian', asr_model: 'fake-asr', asr_region: 'beijing',
    bailian_configured: false, soniox_configured: false, fish_configured: false,
    fish_model: 's2.1-pro-free', voice_id: '', local_asr_ready: false, piper_voices: [], cosyvoice_ready: false,
  } }))
  let microphonePackets = 0, acknowledgements = 0, interrupted = 0
  await page.routeWebSocket('**/api/voice/call/ws', socket => {
    let answered = false
    socket.onMessage(message => {
      if (typeof message === 'string') {
        const event = JSON.parse(message)
        if (event.character_id) socket.send(JSON.stringify({ type: 'ready' }))
        if (event.type === 'played') {
          acknowledgements++
          socket.send(JSON.stringify({ type: 'done', generation: 1 }))
        }
        if (event.type === 'interrupt') interrupted++
      } else {
        microphonePackets++
        assert.equal(message.byteLength, 3200)
        if (answered) return
        answered = true
        for (const event of [
          { type: 'transcript', text: '你好', final: true },
          { type: 'reply-start', text: '你好', generation: 1 },
          { type: 'delta', text: '我在这里，听得到你。', generation: 1 },
          { type: 'audio-start', generation: 1, segment: 1, sample_rate: 24000 },
        ]) socket.send(JSON.stringify(event))
        const pcm = Buffer.alloc(8 + 4800)
        pcm.writeUInt32LE(1, 0); pcm.writeUInt32LE(1, 4)
        for (let i = 0; i < 2400; i++) pcm.writeInt16LE(Math.round(2000 * Math.sin(i * 0.1)), 8 + i * 2)
        socket.send(pcm)
        socket.send(JSON.stringify({ type: 'audio-end', generation: 1, segment: 1 }))
      }
    })
  })
  await page.route('**/voice-call-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <style>:root{--surface:#fff;--bg:#faf6f4;--text:#333;--text-2:#555;--text-3:#777;--border:#eee}body{margin:0}</style>
    </head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import Panel from '/src/components/VoiceCallPanel.tsx';import '/src/index.css';
    const root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(Panel,{name:'测试角色',setup:{character_id:'test',persona_id:'me',session_id:'single-test',base_url:'https://fake.invalid',api_key:'fake',model:'fake',max_tokens:800,uncensored:false,auto_memory:false},onClose:()=>root.unmount(),onHistory:()=>{}}));
    </script></body></html>` }))
  await page.goto('http://localhost:5173/voice-call-harness')
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 10000 })
  assert.equal(await page.getByRole('button', { name: '开始通话' }).isDisabled(), true)
  await page.getByLabel('识别 API Key', { exact: true }).fill('fake-asr-secret')
  await page.getByLabel('Fish Audio API Key', { exact: true }).fill('fake-fish-secret')
  await page.getByLabel('测试角色的 Fish 音色 ID', { exact: true }).fill('test-voice')
  await page.getByRole('button', { name: '开始通话' }).click()
  await page.getByText('我在这里，听得到你。', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent === '正在听')
  assert.ok(microphonePackets > 0)
  assert.equal(acknowledgements, 1)
  await page.getByRole('button', { name: '静音', exact: true }).click()
  await page.getByRole('button', { name: '开启麦克风', exact: true }).waitFor()
  await page.getByRole('button', { name: '停一下', exact: true }).click()
  await page.getByRole('button', { name: '挂断', exact: true }).click()
  await page.getByText('通话已结束', { exact: true }).waitFor()
  assert.ok(interrupted >= 1)
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('fake-asr-secret') || value.includes('fake-fish-secret'))), false)
  assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false)
  await page.keyboard.press('Escape')
  assert.equal(await dialog.count(), 0)
  await page.route('**/api/voice/call/config', route => route.fulfill({ json: {
    asr_provider: 'bailian', asr_model: 'fake-asr', asr_region: 'beijing',
    bailian_configured: false, soniox_configured: false, fish_configured: false,
    fish_model: 's2.1-pro-free', voice_id: '', local_asr_ready: true,
    piper_voices: ['zh_CN-huayan-medium', 'zh_CN-xiao_ya-medium'], cosyvoice_ready: false,
  } }))
  await page.goto('about:blank')
  await page.goto('http://localhost:5173/voice-call-harness')
  await page.getByLabel(/本地音色/).waitFor()
  assert.equal(await page.getByRole('button', { name: '开始通话' }).isEnabled(), true)
  assert.equal(await page.locator('input[type=password]').count(), 0)
  assert.equal(await page.getByLabel(/语音识别/).inputValue(), 'local')
  await page.screenshot({ path: 'artifacts/voice-local-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '开始通话' }).click()
  await page.getByText('我在这里，听得到你。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '挂断', exact: true }).click()
  assert.deepEqual(errors, [])
  console.log('PASS: mobile dialog, real AudioWorklet/AudioContext, PCM socket, playback ACK, mute, interrupt, hangup, secret lifetime')
} finally {
  await browser.close()
}
