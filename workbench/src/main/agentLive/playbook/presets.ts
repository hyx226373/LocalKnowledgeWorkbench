/**
 * 内置模板的打包副本。读得到且六份都能解析时用磁盘；否则调用方用内置表。
 * KB_CTX_PLAYBOOKS=none 时不用磁盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinPresets, parsePresetMarkdown, type BuiltinPreset } from '../../../shared/ctxPlaybook';

export function packagedPlaybookDir(): string | null {
  const env = process.env.KB_CTX_PLAYBOOKS;
  if (env) return env === 'none' ? null : path.resolve(env);
  const dir = path.join(process.cwd(), 'resources', 'ctx-playbooks');
  return fs.existsSync(dir) ? dir : null;
}

/** 六份都在且 id 对得上才返回。任一失败就返回 null，让调用方用内置表。 */
export function loadPackagedPresets(dir = packagedPlaybookDir()): BuiltinPreset[] | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const embedded = builtinPresets();
  const out: BuiltinPreset[] = [];
  for (const preset of embedded) {
    const file = path.join(dir, `${preset.id}.md`);
    if (!fs.existsSync(file)) return null;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const parsed = parsePresetMarkdown(text);
    if (!parsed.ok || parsed.preset.id !== preset.id) return null;
    out.push(parsed.preset);
  }
  return out.length === embedded.length ? out : null;
}
