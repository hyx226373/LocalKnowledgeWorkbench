import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { mermaidFlowchartOnly } from './scripts/mermaid-flowchart-only.mjs';
import { pptCfbBinding } from './scripts/ppt-cfb-binding.mjs';
import { formatWorkerShims } from './scripts/format-worker-shims.mjs';

export default defineConfig({
  root: path.join(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react(), mermaidFlowchartOnly(), pptCfbBinding()],
  // 版式 Worker 单独打包。主插件管不到里面的 ppt.js，Node 内置模块也要换成浏览器垫片。
  worker: {
    plugins: () => [formatWorkerShims(), pptCfbBinding()],
  },
  build: {
    outDir: path.join(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    chunkSizeWarningLimit: 3000,
  },
  server: { port: 5199, strictPort: true },
});
