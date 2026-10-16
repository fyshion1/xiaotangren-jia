import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
