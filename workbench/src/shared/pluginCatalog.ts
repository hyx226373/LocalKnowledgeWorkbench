/**
 * 插件清单：本地 fixture JSON + 可选远程/覆盖 URL。
 * 与应用更新器无关。
 * 校验：sha256 必校验（远程 zip 必填）；远程包强制 Ed25519 签名（requireSignature）；本地可无签名。签名消息为 sha256 hex 的 UTF-8。
 * 可信来源：内置 fixture（testOnly，仅测试）+ 用户配置的清单 URL / KB_PLUGIN_CATALOG。
 * 尚无公开 CDN 公钥时，仅内置 fixture 测试公钥可用于验签；生产 CDN 公钥待补。
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const PLUGIN_CATALOG_LAYOUT_KEY = 'settings.pluginCatalogUrl';
export const PLUGIN_CATALOG_ENV = 'KB_PLUGIN_CATALOG';

/** signature 前缀：ed25519:<base64>，消息 = sha256 hex（小写）的 UTF-8 字节 */
export const PLUGIN_CATALOG_SIG_PREFIX = 'ed25519:';

/**
 * 内置可信公钥（SPKI DER base64）。
 * 当前仅 fixture 测试钥；公开 CDN 发布钥尚未配置（见 REPORT 缺项）。
 */
export const PLUGIN_CATALOG_TRUSTED_PUBKEYS_SPKI_B64: readonly string[] = [
  // fixture test-only Ed25519（对应 resources/plugin-catalog 签名）
  'MCowBQYDK2VwAyEAKDO0euM5pDz7vgbDxZaitMy6k4SGeQ+1jb//X7Nlp1Q=',
];

export interface PluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** http(s) / file: / 相对清单文件的路径；指向 .zip 或本地插件文件夹 */
  packageUrl: string;
  /** 包文件 sha256（hex）。远程 zip 必填；本地文件夹可空 */
  sha256?: string | null;
  /**
   * 可选签名。格式 `ed25519:<base64>`，对 sha256 hex（小写 UTF-8）做 Ed25519。
   * 远程安装（http(s) 包或远程清单）强制要求；有值则必须通过内置可信公钥验签，否则拒绝安装。本地 file 路径可无签名。
   */
  signature?: string | null;
}

export interface PluginCatalog {
  v: 1;
  name?: string;
  updatedAt?: string;
  /** 内置/测试清单标记：仅测试，不可当作生产源 */
  testOnly?: boolean;
  plugins: PluginCatalogEntry[];
}

export type PluginCatalogSourceKind = 'env' | 'settings' | 'fixture';

export interface PluginCatalogView {
  source: string;
  sourceKind: PluginCatalogSourceKind;
  /** 设置中保存的清单 URL（可空）；与当前实际 source 可能不同（env 优先） */
  configuredUrl: string | null;
  name: string;
  updatedAt: string | null;
  testOnly: boolean;
  plugins: PluginCatalogEntry[];
  /** 已安装（adapter 源）的插件 id */
  installedIds: string[];
}

export function parsePluginCatalog(raw: unknown): PluginCatalog {
  if (!raw || typeof raw !== 'object') throw new Error('插件清单不是对象');
  const doc = raw as Record<string, unknown>;
  if (doc.v !== 1) throw new Error(`不支持的插件清单版本：${String(doc.v)}`);
  if (!Array.isArray(doc.plugins)) throw new Error('plugins 必须是数组');
  const plugins: PluginCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const p of doc.plugins) {
    if (!p || typeof p !== 'object') continue;
    const e = p as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const version = typeof e.version === 'string' ? e.version.trim() : '';
    const packageUrl = typeof e.packageUrl === 'string' ? e.packageUrl.trim() : '';
    if (!id || !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) throw new Error(`非法插件清单 id：${id || '（空）'}`);
    if (!name) throw new Error(`插件 ${id} 缺少 name`);
    if (!version) throw new Error(`插件 ${id} 缺少 version`);
    if (!packageUrl) throw new Error(`插件 ${id} 缺少 packageUrl`);
    if (seen.has(id)) throw new Error(`插件清单 id 重复：${id}`);
    seen.add(id);
    const sha256 = e.sha256 == null || e.sha256 === '' ? null : String(e.sha256).trim().toLowerCase();
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`插件 ${id} 的 sha256 无效`);
    const signature = e.signature == null || e.signature === '' ? null : String(e.signature).trim();
    if (signature && !signature.startsWith(PLUGIN_CATALOG_SIG_PREFIX)) {
      throw new Error(`插件 ${id} 的 signature 格式无效（需要 ${PLUGIN_CATALOG_SIG_PREFIX}<base64>）`);
    }
    plugins.push({
      id,
      name,
      version,
      description: typeof e.description === 'string' ? e.description : undefined,
      packageUrl,
      sha256,
      signature,
    });
  }
  return {
    v: 1,
    name: typeof doc.name === 'string' ? doc.name : undefined,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : undefined,
    testOnly: doc.testOnly === true,
    plugins,
  };
}

export async function hashFileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(file, { highWaterMark: 64 * 1024 });
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function hashBufferSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export class PluginSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSignatureError';
  }
}

/**
 * 校验条目签名。
 * - 默认：无 signature 则跳过（仍依赖 sha256）；本地 file 安装可如此。
 * - requireSignature===true：无 signature 则抛 PluginSignatureError（远程包/远程清单强制）。
 * 有 signature：必须是 ed25519:<base64>，且对 sha256 hex 验签通过某一内置可信公钥。
 */
export function verifyPluginPackageSignature(
  entry: {
    id: string;
    sha256?: string | null;
    signature?: string | null;
  },
  opts?: { requireSignature?: boolean },
): void {
  const sig = entry.signature;
  if (!sig) {
    if (opts?.requireSignature) {
      throw new PluginSignatureError(`插件 ${entry.id} 缺少签名：远程插件包必须提供 Ed25519 签名`);
    }
    return;
  }
  if (!entry.sha256) {
    throw new PluginSignatureError(`插件 ${entry.id} 带签名但缺少 sha256，无法验签`);
  }
  if (!sig.startsWith(PLUGIN_CATALOG_SIG_PREFIX)) {
    throw new PluginSignatureError(`插件 ${entry.id} 签名格式无效（需要 ${PLUGIN_CATALOG_SIG_PREFIX}<base64>）`);
  }
  const b64 = sig.slice(PLUGIN_CATALOG_SIG_PREFIX.length).trim();
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(b64, 'base64');
  } catch {
    throw new PluginSignatureError(`插件 ${entry.id} 签名不是合法 base64`);
  }
  if (sigBuf.length !== 64) {
    throw new PluginSignatureError(`插件 ${entry.id} 签名长度无效（Ed25519 应为 64 字节）`);
  }
  const msg = Buffer.from(entry.sha256.toLowerCase(), 'utf8');
  const keys = PLUGIN_CATALOG_TRUSTED_PUBKEYS_SPKI_B64;
  if (keys.length === 0) {
    throw new PluginSignatureError(
      `插件 ${entry.id} 签名无法验证：应用尚未配置可信公钥（无公开 CDN）。请清除 signature 或改用已签名的测试 fixture。`,
    );
  }
  for (const spki of keys) {
    try {
      const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
      if (cryptoVerify(null, msg, key, sigBuf)) return;
    } catch {
      /* try next */
    }
  }
  throw new PluginSignatureError(`插件 ${entry.id} 签名校验失败：不是可信来源签发，已拦装`);
}