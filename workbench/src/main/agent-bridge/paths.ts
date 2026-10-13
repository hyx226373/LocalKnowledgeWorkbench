import path from 'node:path';

export const BRIDGE_DIR_NAME = 'agent-bridge';

const UNSAFE = /[<>:"|?*\u0000]/;

/**
 * 默认 `<userData>/agent-bridge`。
 * `override` 或环境变量 `KB_AGENT_BRIDGE_ROOT` 可改桥根（绝对路径，或相对 userData）。
 */
export function resolveBridgeRoot(userDataDir: string, override?: string): string {
  const fromEnv = process.env.KB_AGENT_BRIDGE_ROOT?.trim();
  const chosen = (override?.trim() || fromEnv || BRIDGE_DIR_NAME);
  const abs = path.isAbsolute(chosen) ? path.resolve(chosen) : path.resolve(userDataDir, chosen);
  const userData = path.resolve(userDataDir);
  if (abs === userData) throw new Error('桥根不能等于 userData 本身');
  if (UNSAFE.test(path.basename(abs))) throw new Error('桥根目录名不合法');
  return abs;
}

export function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** 响应文件名只接受 UUID，避免请求把路径写进 responses/。 */
export function responseFileName(requestId: string): string {
  if (!isUuidV4(requestId)) throw new Error('requestId 不是 UUID v4');
  return `${requestId}.json`;
}
