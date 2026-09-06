import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [{
    name: 'desktop-dev-csp',
    apply: 'serve',
    transformIndexHtml(html: string) {
      // Vite Dev Server 通过内联 Style 注入 CSS，并使用 WebSocket 发送 HMR 更新；
      // 只在开发服务中放行这两个来源，生产构建继续使用严格 CSP。
      return html
        .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
        .replace(
          "connect-src 'none'",
          "connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173",
        );
    },
  }],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: false,
  },
});
