import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// 含帳密的私有資料不准由 dev server 直接吐出（OSM 環境導航，CodeX 審 379cc7f P1）
const blockPrivateData: Plugin = {
  name: 'block-private-data',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      let path = (req.url ?? '').split('?')[0]
      try { path = decodeURIComponent(path) } catch { /* 保留原字串 */ }
      if (/(^|[\\/])(private-data|\.toppath-private)([\\/]|$)/i.test(path)) {
        res.statusCode = 404
        res.end()
        return
      }
      next()
    })
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [blockPrivateData, react()],
  server: {
    host: '0.0.0.0',   // 讓區網其他人也能連
    port: 5173,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/private-data/**', '**/.toppath-private/**'] },
    proxy: {
      // OSM 環境導航頁由 server 驗登入＋權限後下發，dev 也要轉過去
      '/osm-env-nav': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // SSE endpoints — must be listed before the generic /api rule
      '/api/gs/img-compare/capture': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
      '/api/gs/bonus-v2/events': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
      '/api/gs/bonus-v2-client/events': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
      '/api/jira/batch-comment/stream': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
      '/api/integrations/lark/generate-testcases/stream': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Disable compression so SSE frames arrive immediately
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
