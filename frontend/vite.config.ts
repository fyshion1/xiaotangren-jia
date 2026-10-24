import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 素材目录放在**仓库根**（assets/），不在 frontend 里 —— Live2D 的 model3.json 是
// 一堆相对路径引用的散文件（moc3 / 贴图 / 动作 / 物理），拷进 frontend/public 会多一份副本，
// 更容易漏文件。
const ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url))
const HERE = fileURLToPath(new URL('.', import.meta.url))
const BACKEND_URL = process.env.SHIONARIUM_BACKEND_URL || 'http://127.0.0.1:8000'
const configuredPlugins = process.env.SHIONARIUM_PLUGINS_DIR
if (configuredPlugins && !path.isAbsolute(configuredPlugins)) throw new Error('SHIONARIUM_PLUGINS_DIR must be an absolute directory')
const PLUGINS_DIR = configuredPlugins ? path.resolve(configuredPlugins) : path.resolve(HERE, '../features')
const THEME_DIR = path.join(PLUGINS_DIR, 'xiaotangren-theme')
const PLUGIN_STATE = path.resolve(HERE, '../backend/data/plugin-state.json')
function pluginEnabled(id: string) {
  try { return JSON.parse(fs.readFileSync(PLUGIN_STATE, 'utf8'))[id]?.disabled !== true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}
function hasTheme() { return pluginEnabled('xiaotangren_theme') && fs.existsSync(path.join(THEME_DIR, 'xiaotangren_theme/__init__.py')) }
function hasPanel(folder:string,id:string) {
  try {
    const manifest=JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR,folder,'plugin.json'),'utf8'))
    return manifest.id===id&&manifest.kind==='personal-space-panel'&&manifest.host_api===1
  } catch {return false}
}
function hasGemini() {
  try {
    const folder=path.join(PLUGINS_DIR,'gemini-sync')
    const manifest=JSON.parse(fs.readFileSync(path.join(folder,'plugin.json'),'utf8'))
    return manifest.id==='gemini_sync'&&manifest.kind==='integration'&&manifest.host_api===1&&fs.existsSync(path.join(folder,'gemini_sync_plugin/__init__.py'))
  } catch {return false}
}
function watchPlugins(): Plugin {
  return {name:'watch-plugin-state', configureServer(server) {
    const files=[PLUGIN_STATE,...['personal-profile','personal-database','gemini-sync'].map(folder=>path.join(PLUGINS_DIR,folder,'plugin.json'))]
    server.watcher.add(files)
    const current=()=>JSON.stringify([hasTheme(),pluginEnabled('tavern'),hasPanel('personal-profile','personal_profile'),hasPanel('personal-database','personal_database'),hasGemini()])
    let signature=current()
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = (file: string) => {
      if(!files.includes(path.resolve(file))) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        const next=current()
        if(next===signature)return
        signature=next
        void server.restart()
      }, 150)
    }
    server.watcher.on('add', changed).on('change', changed).on('unlink', changed)
    server.httpServer?.once('close', () => { clearTimeout(timer); server.watcher.off('add',changed).off('change',changed).off('unlink',changed) })
  }}
}

// The optional theme owns its public files; the host does not retain copies.
function optionalTheme(): Plugin {
  const HAS_THEME = hasTheme()
  let output = ''
  let building = false
  const publicRoot = path.join(THEME_DIR, 'public')
  return {
    name: 'optional-xiaotangren-theme',
    configResolved(config) {
      output = path.resolve(config.root, config.build.outDir)
      building = config.command === 'build'
    },
    transformIndexHtml(html) {
      const head = HAS_THEME ? fs.readFileSync(path.join(THEME_DIR, 'frontend/head.html'), 'utf8') : ''
      return (HAS_THEME ? html.replace(/<title>.*?<\/title>/, '') : html)
        .replace('<!-- optional-theme-head -->', head)
    },
    configureServer(server) {
      if (!HAS_THEME) return
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        let pathname: string
        try { pathname = decodeURIComponent((req.url || '/').split('?')[0]) } catch { return next() }
        if (!/^\/(characters|visual)\//.test(pathname)) return next()
        const file = path.resolve(publicRoot, '.' + pathname)
        const relative = path.relative(publicRoot, file)
        if (relative.startsWith('..') || path.isAbsolute(relative)) return next()
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
        const mime: Record<string, string> = {'.webp':'image/webp', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.txt':'text/plain; charset=utf-8'}
        res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
        if (req.method === 'HEAD') return res.end()
        fs.createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      if (building && HAS_THEME && output && fs.existsSync(publicRoot)) fs.cpSync(publicRoot, output, {recursive:true})
    },
  }
}

// 为什么不用 publicDir 指过去：Vite 会把 publicDir 的内容**按 URL 根**吐出来
// （默认的 frontend/public/ 就是靠这个，所以它的 vendor/ 在 /vendor/ 下），
// 想要 /assets/ 前缀就得改写成 /live2d/... 这种根路径 URL。更麻烦的是 build 时
// 会把整个 publicDir 复制进 dist —— 而 assets/live2d 里是 Cubism 官方样例，
// **不可再分发**（见 assets/LICENSE.md）。所以这里改成 dev-only 的中间件：
// dev 照常从 /assets/... 取，构建产物里一份都不带。
function serveRepoAssets(): Plugin {
  const MIME: Record<string, string> = {
    '.json': 'application/json',
    '.moc3': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.vrm': 'model/gltf-binary',
    '.glb': 'model/gltf-binary',
    '.fbx': 'application/octet-stream',
    '.obj': 'text/plain',
    '.mtl': 'text/plain',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.bin': 'application/octet-stream',
    '.url': 'text/plain',
  }

  return {
    name: 'serve-repo-assets',
    apply: 'serve',
    configureServer(server) {
      // 不带 `return () => {}`：这样中间件排在 Vite 内部那些（transform / SPA 兜底）
      // **前面**，否则 /assets/xxx 会被 index.html 接走。
      server.middlewares.use('/assets', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()

        const raw = (req.url ?? '/').split('?')[0].split('#')[0]
        let decoded: string
        try {
          decoded = decodeURIComponent(raw)
        } catch {
          return next()
        }

        // 拼完必须仍在 ASSETS_DIR 里，挡掉 /assets/../../ 这类穿越。
        const file = path.resolve(ASSETS_DIR, '.' + path.posix.normalize(decoded))
        const rel = path.relative(ASSETS_DIR, file)
        if (rel.startsWith('..') || path.isAbsolute(rel)) return next()

        let stat: fs.Stats
        try {
          stat = fs.statSync(file)
          if (!stat.isFile()) return next()
        } catch {
          return next()
        }

        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Content-Length', String(stat.size))
        res.setHeader('Cache-Control', 'no-cache')
        if (req.method === 'HEAD') return res.end()
        fs.createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig(() => ({
  // Keep isolated test workspaces from rewriting the live optimizer cache
  // through their shared node_modules junction.
  cacheDir: path.resolve(HERE, '.vite'),
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '#shionarium': path.join(HERE,'src'),
      '#theme': path.resolve(HERE, hasTheme()
        ? path.join(THEME_DIR,'frontend') : 'src/optional/theme'),
      '#personal-profile': hasPanel('personal-profile','personal_profile')?path.join(PLUGINS_DIR,'personal-profile/frontend'):path.join(HERE,'src/optional/personal-profile'),
      '#personal-database': hasPanel('personal-database','personal_database')?path.join(PLUGINS_DIR,'personal-database/frontend'):path.join(HERE,'src/optional/personal-database'),
      '#gemini-sync':hasGemini()?path.join(PLUGINS_DIR,'gemini-sync/frontend'):path.join(HERE,'src/optional/gemini-sync'),
      '#tavern': pluginEnabled('tavern') && fs.existsSync(path.join(PLUGINS_DIR, 'tavern/tavern_feature/__init__.py'))
      ? path.join(PLUGINS_DIR,'tavern/frontend') : path.join(HERE,'src/optional/tavern') },
  },
  plugins: [react(), tailwindcss(), serveRepoAssets(), optionalTheme(), watchPlugins()],
  server: {
    fs: {allow: [path.resolve(HERE,'..'), PLUGINS_DIR]},
    // 监听所有网卡 —— 手机连同一校园网时，用电脑局域网 IP 也能打开（默认只监听 localhost 会被拒）。
    host: true,
    // 允许用 IP / 局域网主机名访问；仅本地开发用，别拿去公网裸奔。
    allowedHosts: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/voice/call/ws': {
        target: BACKEND_URL,
        ws: true,
        changeOrigin: false,
      },
      // 后端留 127.0.0.1 即可：代理发生在电脑本机，手机只跟 Vite 打交道，
      // /api 由 Vite 转发给后端，所以手机侧不需要、也不应该直连 8000。
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
      // 小窝里的「日语实验室」面板（feature `japanese_lab`）：它自己的服务绑在 8765，
      // 走这个前缀直连，**别挂到 /api 下面** —— /api 是本体(8000)的地盘。
      // 没起那个功能时这里会 502 —— 面板自己会按注册表把 serve 拉起来（不用手动去点）。
      '/jplab': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      // 小窝里的「英语学习」面板（feature `english_study`）：它自己的服务绑在 8766，
      // 同样的道理 —— 走自己的前缀，别挂到 /api 下面。和日语是姐妹项目，各自的库、各自的端口，
      // 只共用本体的「小窝大脑」那一套。/english/api/* 全由那个功能自己处理。
      '/english': {
        target: 'http://127.0.0.1:8766',
        changeOrigin: true,
      },
    },
  },
}))
