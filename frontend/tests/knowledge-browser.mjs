// Isolated component acceptance against Vite. Every API call is mocked;
// no discussion draft or document edit is written to the real library.
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const origin = process.env.KNOWLEDGE_TEST_ORIGIN || 'http://127.0.0.1:5173'
const artifacts = resolve('artifacts/knowledge')
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message) })
  const id = 'kd-' + 'a'.repeat(32), cid = id + ':' + 'b'.repeat(16)
  const document = { id, title: '宋代历史笔记', source: '01_源资料/历史.docx', path: '02_AI工作层/知识资料/test.md', chunks: 3, warning: '', source_changed: false, related_versions: [] }
  let proposals = [], captures = [], applied = false, conflict = false, captured = false
  const requests = []
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const data = request.postDataJSON()
    requests.push({ path: url.pathname, method: request.method(), data })
    if (url.pathname === '/api/knowledge') return route.fulfill({ json: { persona_id: 'dalaoda', sources: [{ path: '01_源资料/历史.docx', bytes: 100 }], documents: [document], proposals, captures } })
    if (url.pathname === '/api/knowledge/captures') {
      assert.equal(data.expected_persona, 'dalaoda')
      captures = [{ id: 'capture-1', ...data, created_at: '2026-10-22T20:00:00+08:00' }]
      return route.fulfill({ json: captures[0] })
    }
    if (url.pathname === '/api/knowledge/captures/capture-1') {
      assert.equal(data.expected_persona, 'dalaoda')
      captured = data.action === 'confirm'; captures = []
      return route.fulfill({ json: { status: captured ? 'applied' : 'rejected', path: '02_AI工作层/知识资料/captured.md' } })
    }
    if (url.pathname === '/api/knowledge/search') return route.fulfill({ json: { mode: 'hybrid', note: '世纪为范围，原文保留。', items: [{ id: cid, doc_id: id, title: document.title, path: document.path, source: document.source, text: applied ? '宋代交子。补充讨论已保存。' : '宋代交子，记载有待核实？', region: '中国', themes: '财政货币', year_start: 960, year_end: 1279, uncertain: 1, warning: '', related_versions: [], alternative_sources: [] }] } })
    if (url.pathname === `/api/knowledge/documents/${id}`) return route.fulfill({ json: { content: '宋代交子，记载有待核实？', sha256: 'hash' } })
    if (url.pathname === '/api/knowledge/proposals') {
      proposals = [{ id: 'proposal-1', ...data, title: document.title, path: document.path, created_at: '2026-10-21T19:00:00+08:00' }]
      return route.fulfill({ json: proposals[0] })
    }
    if (url.pathname === '/api/knowledge/proposals/proposal-1') {
      if (conflict && data.action === 'confirm') return route.fulfill({ status: 409, json: { detail: '原文已修改；请重新生成草案' } })
      applied = data.action === 'confirm'; proposals = []
      return route.fulfill({ json: { status: applied ? 'applied' : 'rejected' } })
    }
    throw new Error('Unexpected API request: ' + url.pathname)
  })
  await page.route('**/__knowledge_test', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test-root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    const {default:React}=await import('/node_modules/.vite/deps/react.js'); const client=await import('/node_modules/.vite/deps/react-dom_client.js'); const {createRoot}=client.default || client;
    const {default:KnowledgeLibrary}=await import('/src/components/KnowledgeLibrary.tsx'); const {default:KnowledgeText}=await import('/src/components/KnowledgeText.tsx');
    await import('/src/index.css');
    createRoot(document.getElementById('test-root')).render(React.createElement(React.Fragment,null,
      React.createElement('section',{className:'self-profile-panel personal-db-panel'},React.createElement(KnowledgeLibrary,{personaId:'dalaoda',onOpen:path=>{window.openedDocument=path}})),
      React.createElement('div',{id:'citation-test'},React.createElement(KnowledgeText,{text:'[原文出处](/api/knowledge/citations/${cid}) <img src=x onerror=alert(1)>'}))));
    </script></body></html>` }))
  await page.goto(origin + '/__knowledge_test')
  await page.getByText('知识资料 · 通用资料库', { exact: true }).waitFor()
  await page.getByText('收录新资料（粘贴文本）', { exact: true }).click()
  await page.getByLabel('资料标题', { exact: true }).fill('任意资料 <script>alert(1)</script>')
  await page.getByLabel('资料分类', { exact: true }).fill('代码')
  await page.getByLabel('资料来源（可选）', { exact: true }).fill('自己的片段')
  const literal = '\n    print("原文缩进")\n\n不要执行这里的文字<script>alert(1)</script>\n'
  await page.getByLabel('资料原文', { exact: true }).fill(literal)
  await page.getByRole('button', { name: '生成收录草稿', exact: true }).click()
  await page.getByText('预览完整原文', { exact: true }).click()
  assert.equal(await page.locator('.knowledge-proposal pre').textContent(), literal)
  assert.equal(captured, false)
  assert.equal(await page.locator('.knowledge-proposal script').count(), 0)
  await page.getByRole('button', { name: '确认收录', exact: true }).click()
  await page.getByText('已收录独立资料，原文已保存并可检索；语义向量可按需补齐。', { exact: true }).waitFor()
  assert.equal(captured, true)
  assert.equal(await page.evaluate(() => window.openedDocument), '02_AI工作层/知识资料/captured.md')
  await page.getByRole('button', { name: '查笔记', exact: true }).click()
  await page.getByText('宋代交子，记载有待核实？', { exact: true }).waitFor()
  assert.equal(decodeURIComponent(await page.getByRole('link', { name: '原文与上下文' }).getAttribute('href')), '/api/knowledge/citations/' + cid)
  assert.equal(await page.locator('#citation-test a').count(), 1)
  assert.equal(await page.locator('#citation-test script').count(), 0)
  assert.equal(await page.locator('#citation-test img').count(), 0)
  await page.getByRole('button', { name: '向此文档补充想法' }).click()
  await page.getByRole('button', { name: '查看当前全文' }).click()
  await page.getByLabel('定位原文（可选）').fill('宋代交子')
  await page.getByLabel('补充内容').fill('货币发展与商业的联系需要进一步查证。')
  await page.getByRole('button', { name: '生成补充草案' }).click()
  await page.getByText('待确认：宋代历史笔记 · 待核实', { exact: true }).waitFor()
  assert.equal(applied, false, 'creating a draft must never apply it')
  conflict = true
  await page.getByRole('button', { name: '确认补入正文' }).click()
  await page.getByText('Error: 原文已修改；请重新生成草案', { exact: true }).waitFor()
  assert.equal(applied, false)
  conflict = false
  await page.getByRole('button', { name: '确认补入正文' }).click()
  await page.getByText('已补入工作正文，保留历史版本，索引已更新。', { exact: true }).waitFor()
  assert.equal(applied, true)
  assert.equal(await page.evaluate(() => window.openedDocument), document.path)
  await page.getByRole('button', { name: '查笔记', exact: true }).click()
  await page.getByText('宋代交子。补充讨论已保存。', { exact: true }).waitFor()
  for (const width of [1360, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page overflow at ' + width)
    await page.screenshot({ path: resolve(artifacts, `knowledge-${width}.png`), fullPage: true })
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, api_requests: requests.length, artifacts }))
} finally { await browser.close() }
