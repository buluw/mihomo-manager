import path from 'node:path'
import { copyFileSync, cpSync, readFileSync, rmSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Publish the YAML/JSON editor assets and Simplified Chinese for build and dev.
  const monacoPackage = path.resolve(__dirname, 'node_modules/monaco-editor')
  const monacoVersion = JSON.parse(readFileSync(path.join(monacoPackage, 'package.json'), 'utf8')).version
  const monacoPublic = path.resolve(__dirname, 'public/assets/monaco-editor', monacoVersion)
  const monacoAmd = path.join(monacoPackage, 'min/vs')
  rmSync(monacoPublic, { recursive: true, force: true })
  cpSync(monacoAmd, path.join(monacoPublic, 'vs'), {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(monacoAmd, source).split(path.sep).join('/')
      return !/^assets\/(ts|css|html)\.worker-.*\.js$/.test(relative)
        && !/^nls\.messages\.(?!zh-cn\.)[a-z-]+\.js\.js$/.test(relative)
    },
  })
  copyFileSync(path.join(monacoPackage, 'esm/nls.messages.zh-cn.js'), path.join(monacoPublic, 'nls.messages.zh-cn.js'))
  copyFileSync(path.join(monacoPackage, 'LICENSE'), path.join(monacoPublic, 'LICENSE'))

  const env = loadEnv(mode, '.', 'MIHOMO_')
  if (process.env.MIHOMO_ISOLATED_DEV === '1' && !process.env.MIHOMO_GATEWAY_TARGET) {
    throw new Error('Isolated development requires an explicit MIHOMO_GATEWAY_TARGET for its authenticated fixture gateway.')
  }
  const gatewayTarget = process.env.MIHOMO_GATEWAY_TARGET || env.MIHOMO_GATEWAY_TARGET || 'http://127.0.0.1:9090'

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: { target: 'es2022', sourcemap: false },
    server: {
      proxy: {
        '/api/': { target: gatewayTarget, ws: true, changeOrigin: false },
      },
    },
  }
})
