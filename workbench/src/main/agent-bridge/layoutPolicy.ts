/** 工作区布局导出不得带上 agent-bridge。纯函数，不读盘。 */
const MARKER = 'agent-bridge';

export function omitAgentBridgeFromLayout<T>(file: T): T {
  const json = JSON.stringify(file);
  if (!json.includes(MARKER)) return file;
  return strip(JSON.parse(json) as unknown) as T;
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes(MARKER) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value.map(strip).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.includes(MARKER)) continue;
      const next = strip(item);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}
