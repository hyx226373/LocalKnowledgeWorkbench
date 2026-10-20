/**
 * 插件清单下载 + 校验 + 安装。
 * - 缓存：<dataDir>/plugin-download-cache/（与用户知识库内容目录隔离）
 * - 校验：sha256；远程包/远程清单强制 Ed25519 签名（testOnly/fixture 豁免）；失败拦装
 * - 安装：复用 PluginHostService.installFromFolder（进 plugins/ 并登记 DB，可被启停/胶囊发现）
 * - 不碰应用更新器、不打开前台对话框
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../migration/zip';
import {
  PLUGIN_CATALOG_ENV,
  PLUGIN_CATALOG_LAYOUT_KEY,
  hashBufferSha256,
  hashFileSha256,
  parsePluginCatalog,
  verifyPluginPackageSignature,
  PluginSignatureError,
  type PluginCatalogEntry,
  type PluginCatalogSourceKind,
  type PluginCatalogView,
} from '../../shared/pluginCatalog';
import type { AdapterPluginDto } from '../../shared/pluginIpc';
import type { PluginHostService } from './pluginHost';
import type { WorkbenchService } from './WorkbenchService';

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

export class PluginCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCatalogError';
  }
}

export class PluginCatalogInstaller {
  constructor(
    private svc: WorkbenchService,
    private plugins: PluginHostService,
    private resolveFixtureCatalog: () => string | null,
  ) {}

  cacheDir(): string {
    const d = path.join(this.svc.dataDir, 'plugin-download-cache');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  configuredUrl(): string | null {
    const layout = this.svc.getLayout(PLUGIN_CATALOG_LAYOUT_KEY);
    if (typeof layout === 'string' && layout.trim()) return layout.trim();
    return null;
  }

  /** 解析清单来源：env > 设置 > 内置 fixture */
  resolveCatalogSource(): { source: string; kind: PluginCatalogSourceKind } {
    const env = (process.env[PLUGIN_CATALOG_ENV] ?? '').trim();
    if (env) return { source: env, kind: 'env' };
    const layout = this.configuredUrl();
    if (layout) return { source: layout, kind: 'settings' };
    const fixture = this.resolveFixtureCatalog();
    if (fixture && fs.existsSync(fixture)) return { source: fixture, kind: 'fixture' };
    throw new PluginCatalogError('未配置插件清单（KB_PLUGIN_CATALOG / 设置 pluginCatalogUrl / 内置 fixture）');
  }

  async loadCatalog(): Promise<PluginCatalogView> {
    const { source, kind } = this.resolveCatalogSource();
    const { text, baseDir } = await this.readCatalogText(source);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new PluginCatalogError(`插件清单 JSON 无效：${(e as Error).message}`);
    }
    const doc = parsePluginCatalog(raw);
    const installed = new Set(this.plugins.list().map((p) => p.id));
    const testOnly = doc.testOnly === true || kind === 'fixture';
    return {
      source,
      sourceKind: kind,
      configuredUrl: this.configuredUrl(),
      name: doc.name ?? (testOnly ? '插件清单（仅测试）' : '插件清单'),
      updatedAt: doc.updatedAt ?? null,
      testOnly,
      plugins: doc.plugins.map((p) => ({
        ...p,
        packageUrl: this.resolvePackageUrl(p.packageUrl, source, baseDir),
      })),
      installedIds: [...installed],
    };
  }

  async installFromCatalog(entryId: string): Promise<AdapterPluginDto> {
    const catalog = await this.loadCatalog();
    const entry = catalog.plugins.find((p) => p.id === entryId);
    if (!entry) throw new PluginCatalogError(`清单中没有插件：${entryId}`);
    // 远程包或远程清单强制签名；testOnly/fixture（catalog.testOnly）豁免；本地 file 可无签名
    const remotePackage = /^https?:\/\//i.test(entry.packageUrl);
    const remoteCatalog = /^https?:\/\//i.test(catalog.source);
    const requireSignature = !catalog.testOnly && (remotePackage || remoteCatalog);
    try {
      verifyPluginPackageSignature(entry, { requireSignature });
    } catch (e) {
      if (e instanceof PluginSignatureError) throw new PluginCatalogError(e.message);
      throw e;
    }
    const pkgPath = await this.fetchPackage(entry);
    const folder = await this.materializePackage(entry, pkgPath);
    return this.plugins.installFromFolder(folder);
  }

  private async readCatalogText(source: string): Promise<{ text: string; baseDir: string | null }> {
    if (/^https?:\/\//i.test(source)) {
      const buf = await httpGetBuffer(source, MAX_CATALOG_BYTES);
      return { text: buf.toString('utf8').replace(/^\uFEFF/, ''), baseDir: null };
    }
    const filePath = source.startsWith('file:') ? fileURLToPath(source) : path.resolve(source);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new PluginCatalogError(`插件清单文件不存在：${filePath}`);
    }
    const st = fs.statSync(filePath);
    if (st.size > MAX_CATALOG_BYTES) throw new PluginCatalogError('插件清单过大');
    return {
      text: fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''),
      baseDir: path.dirname(filePath),
    };
  }

  private resolvePackageUrl(packageUrl: string, catalogSource: string, baseDir: string | null): string {
    if (/^https?:\/\//i.test(packageUrl) || packageUrl.startsWith('file:')) return packageUrl;
    if (path.isAbsolute(packageUrl)) return packageUrl;
    if (baseDir) return path.resolve(baseDir, packageUrl);
    if (/^https?:\/\//i.test(catalogSource)) {
      try {
        return new URL(packageUrl, catalogSource).toString();
      } catch {
        throw new PluginCatalogError(`无法解析相对包地址：${packageUrl}`);
      }
    }
    return path.resolve(packageUrl);
  }

  private async fetchPackage(entry: PluginCatalogEntry): Promise<string> {
    const url = entry.packageUrl;
    if (!/^https?:\/\//i.test(url)) {
      const local = url.startsWith('file:') ? fileURLToPath(url) : path.resolve(url);
      if (!fs.existsSync(local)) throw new PluginCatalogError(`插件包不存在：${local}`);
      const st = fs.statSync(local);
      if (st.isDirectory()) {
        if (entry.sha256) throw new PluginCatalogError(`本地文件夹源不支持 sha256 校验：${entry.id}`);
        if (entry.signature) throw new PluginCatalogError(`本地文件夹源不支持签名校验：${entry.id}`);
        return local;
      }
      if (!st.isFile()) throw new PluginCatalogError(`插件包路径无效：${local}`);
      await this.verifyFileHash(local, entry);
      return local;
    }
    if (!entry.sha256) throw new PluginCatalogError(`远程插件包必须提供 sha256：${entry.id}`);
    const dest = path.join(this.cacheDir(), `${safeName(entry.id)}-${safeName(entry.version)}.zip`);
    const part = `${dest}.part-${process.pid}`;
    fs.rmSync(part, { force: true });
    await httpGetToFile(url, part, MAX_PACKAGE_BYTES);
    const actual = await hashFileSha256(part);
    if (actual !== entry.sha256) {
      fs.rmSync(part, { force: true });
      throw new PluginCatalogError(`sha256 不一致（期望 ${entry.sha256}，实际 ${actual}），已拦装`);
    }
    fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
    return dest;
  }

  private async verifyFileHash(file: string, entry: PluginCatalogEntry): Promise<void> {
    if (!entry.sha256) return;
    const actual = await hashFileSha256(file);
    if (actual !== entry.sha256) {
      throw new PluginCatalogError(`sha256 不一致（期望 ${entry.sha256}，实际 ${actual}），已拦装`);
    }
  }

  private async materializePackage(entry: PluginCatalogEntry, pkgPath: string): Promise<string> {
    if (fs.statSync(pkgPath).isDirectory()) return pkgPath;
    const buf = fs.readFileSync(pkgPath);
    if (buf.length > MAX_PACKAGE_BYTES) throw new PluginCatalogError('插件包超过 50 MB');
    if (entry.sha256) {
      const actual = hashBufferSha256(buf);
      if (actual !== entry.sha256) throw new PluginCatalogError(`sha256 不一致（期望 ${entry.sha256}，实际 ${actual}），已拦装`);
    }
    let zipEntries: Map<string, Buffer>;
    try {
      zipEntries = readZip(buf, { maxTotalBytes: MAX_PACKAGE_BYTES, maxEntries: 2000 });
    } catch (e) {
      throw new PluginCatalogError(`插件包解压失败：${(e as Error).message}`);
    }
    const out = path.join(this.cacheDir(), `${safeName(entry.id)}-${safeName(entry.version)}-extracted`);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const [name, data] of zipEntries) {
      const dest = path.join(out, ...name.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    if (fs.existsSync(path.join(out, 'manifest.json'))) return out;
    const kids = fs.readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const k of kids) {
      const nested = path.join(out, k.name);
      if (fs.existsSync(path.join(nested, 'manifest.json'))) return nested;
    }
    throw new PluginCatalogError('插件包内缺少 manifest.json，安装失败');
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function httpGetBuffer(url: string, maxBytes: number, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!/^https?:\/\//i.test(next)) {
          reject(new PluginCatalogError('下载重定向不合法'));
          return;
        }
        httpGetBuffer(next, maxBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new PluginCatalogError(`下载失败 HTTP ${code}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          reject(new PluginCatalogError('下载内容超过上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function httpGetToFile(url: string, dest: string, maxBytes: number, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!/^https?:\/\//i.test(next)) {
          reject(new PluginCatalogError('下载重定向不合法'));
          return;
        }
        httpGetToFile(next, dest, maxBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new PluginCatalogError(`下载插件包失败 HTTP ${code}`));
        return;
      }
      let total = 0;
      const out = fs.createWriteStream(dest);
      let failed = false;
      const fail = (e: Error) => {
        if (failed) return;
        failed = true;
        res.destroy();
        out.destroy();
        fs.rmSync(dest, { force: true });
        reject(e);
      };
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) fail(new PluginCatalogError('插件包超过 50 MB'));
      });
      res.pipe(out);
      out.on('finish', () => {
        if (!failed) resolve();
      });
      out.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', reject);
  });
}