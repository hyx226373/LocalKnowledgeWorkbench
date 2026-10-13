import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** tsc 会改写 js 里的 .ts 导入，但 .d.ts 仍保留 .ts。NodeNext 需要 .js。 */
function rewriteSpecifiers(source) {
  return source.replace(
    /(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g,
    (_, a, spec, b) => `${a}${spec}.js${b}`,
  );
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const original = await readFile(abs, 'utf8');
    const next = rewriteSpecifiers(original);
    if (next !== original) await writeFile(abs, next);
  }
}

await walk(path.resolve(dist));
