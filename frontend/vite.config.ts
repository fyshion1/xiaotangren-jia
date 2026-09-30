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
    },
  },
})
