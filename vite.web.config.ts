/**
 * 纯 Vite 的渲染层构建（Tauri 用）。
 *
 * 为什么要单独一份：`electron-vite` 的 build 会同时产出 out/main 与 out/preload（1.x 主进程），
 * 而 Tauri 只需要渲染层产物。把渲染层构建解耦出来之后，删掉 1.x 主进程不再影响出包，
 * 且 CI 不必为了渲染层去编译 Electron 侧配置。
 *
 * 输出到 `out/web`（与 electron-vite 的 out/renderer 分开，两套构建互不覆盖），
 * `src-tauri/tauri.conf.json` 的 `build.frontendDist` 指向 `../out/web`。
 *
 * 与 electron.vite.config.ts 的 renderer 段必须保持一致的部分只有两项：
 *  - `@renderer` 别名
 *  - `@vitejs/plugin-react`
 * 其余（base、outDir、target）是给 Tauri/WebKit 用的差异项。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig(({ command }) => ({
  root: resolve(__dirname, 'src/renderer'),
  // 构建用相对路径：与 1.x electron-vite 产物（`./assets/...`）保持一致，
  // 也避免 Tauri 自定义协议根（tauri://localhost / http://tauri.localhost）在不同平台上
  // 对绝对路径的解析差异。dev 模式（`vite` 起 HMR 服务、Tauri 通过 devUrl 连过来）必须是
  // 绝对根，否则模块请求会拼到错误的路径上。
  base: command === 'serve' ? '/' : './',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react()],
  // 本地开发：`npm run dev:web` 起这个服务（固定端口，tauri.conf.json 的 devUrl 指向它）；
  // 配合 `cargo tauri dev` 就有 HMR + devtools，等价于 1.x 的 `npm run dev`。
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1'
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    // 目标平台是系统 WebView：Windows=WebView2(Chromium 常新)、Linux=WebKitGTK 2.4x、macOS=WKWebView。
    // 取三者的公共下界 es2020，避免吐出 WebKit 不认的新语法。
    target: 'es2020',
    sourcemap: false
  }
}))
