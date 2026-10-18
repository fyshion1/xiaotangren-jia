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

export default defineConfig({
  plugins: [react(), tailwindcss(), serveRepoAssets()],
  server: {
    // 监听所有网卡 —— 手机连同一校园网时，用电脑局域网 IP 也能打开（默认只监听 localhost 会被拒）。
    host: true,
    // 允许用 IP / 局域网主机名访问；仅本地开发用，别拿去公网裸奔。
    allowedHosts: true,
    port: 5173,
    strictPort: false,
    proxy: {
      // 后端留 127.0.0.1 即可：代理发生在电脑本机，手机只跟 Vite 打交道，
      // /api 由 Vite 转发给后端，所以手机侧不需要、也不应该直连 8000。
      '/api': {
        target: 'http://127.0.0.1:8000',
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
})
