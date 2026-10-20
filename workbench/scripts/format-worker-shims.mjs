import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shimDir = path.join(root, 'src/renderer/plugins/builtin-formats/shims');
const nodeShims = {
  events: path.join(shimDir, 'events.js'),
  stream: path.join(shimDir, 'stream.js'),
  fs: path.join(shimDir, 'fs.js'),
  path: path.join(shimDir, 'path.js'),
  util: path.join(shimDir, 'util.js'),
  zlib: path.join(shimDir, 'zlib.js'),
};
const exceljsBrowser = path.join(root, 'node_modules/exceljs/dist/exceljs.min.js');

export function formatWorkerShims() {
  return {
    name: 'format-worker-shims',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'exceljs') return exceljsBrowser;
      const name = source.startsWith('node:') ? source.slice(5) : source;
      return nodeShims[name] ?? null;
    },
  };
}
