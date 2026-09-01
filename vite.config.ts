import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 纯前端 SPA：产物是一堆静态文件，由 Node 服务端直接从内存里发。
export default defineConfig({
  root: 'client',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    proxy: {
      // 开发时前端跑在 Vite，实时连接转发给 Node 服务端
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/healthz': { target: 'http://127.0.0.1:8787' },
    },
  },
});
