import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { mermaidFlowchartOnly } from './scripts/mermaid-flowchart-only.mjs';

export default defineConfig({
  root: path.join(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react(), mermaidFlowchartOnly()],
  build: {
    outDir: path.join(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    chunkSizeWarningLimit: 3000,
  },
  server: { port: 5199, strictPort: true },
});
