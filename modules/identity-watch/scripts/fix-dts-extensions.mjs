import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) {
      walk(file);
      continue;
    }
    if (!file.endsWith('.d.ts')) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');
    if (after !== before) fs.writeFileSync(file, after);
  }
}

walk(dist);
