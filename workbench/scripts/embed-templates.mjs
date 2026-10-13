import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates = path.join(root, 'src', 'main', 'agent-bridge', 'templates');
const start = fs.readFileSync(path.join(templates, 'AGENT_START_HERE.md'), 'utf8');
const schemaDir = path.join(templates, 'schemas');
const schemas = {};
for (const name of fs.readdirSync(schemaDir)) {
  if (!name.endsWith('.json')) continue;
  schemas[name] = fs.readFileSync(path.join(schemaDir, name), 'utf8');
}
const out = `/* 由 scripts/embed-templates.mjs 从 templates/ 生成。改说明或 schema 后重跑该脚本。 */
export const AGENT_START_HERE: string = ${JSON.stringify(start)};

export const SCHEMA_FILES: Record<string, string> = ${JSON.stringify(schemas, null, 2)};
`;
fs.writeFileSync(path.join(root, 'src', 'main', 'agent-bridge', 'embedded.ts'), out, 'utf8');
console.log('embedded.ts updated');
