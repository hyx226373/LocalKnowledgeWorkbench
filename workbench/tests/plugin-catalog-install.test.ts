/**
 * 插件点装收尾：URL 保存、sha256 失败、签名失败、正常安装、安装失败。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { makeService, tmpDir, write } from './helpers';
import {
  parsePluginCatalog,
  hashFileSha256,
  verifyPluginPackageSignature,
  PluginSignatureError,
  PLUGIN_CATALOG_LAYOUT_KEY,
  PLUGIN_CATALOG_SIG_PREFIX,
} from '../src/shared/pluginCatalog';
import { PluginCatalogInstaller, PluginCatalogError } from '../src/main/service/pluginCatalogInstall';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_CATALOG = path.join(ROOT, 'resources/plugin-catalog/fixture-catalog.json');
const FIXTURE_ZIP = path.join(ROOT, 'resources/plugin-catalog/fixtures/catalog.hello.zip');
const FIXTURE_DIR = path.join(ROOT, 'resources/plugin-catalog/fixtures/catalog.hello');

/** 与内置 fixture 测试公钥配对的私钥（仅测试；不进运行时） */
const FIXTURE_TEST_PRIV_PKCS8_B64 = 'MC4CAQAwBQYDK2VwBCIEIJe93ydEh7CJqsb29/Bd/1c1ts/c4Xjo2in0iBkr+W7s';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function installerFor(svc: Awaited<ReturnType<typeof makeService>>['svc']) {
  return new PluginCatalogInstaller(svc, svc.plugins, () => FIXTURE_CATALOG);
}

function signSha256Hex(sha256Hex: string): string {
  const key = createPrivateKey({ key: Buffer.from(FIXTURE_TEST_PRIV_PKCS8_B64, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = cryptoSign(null, Buffer.from(sha256Hex.toLowerCase(), 'utf8'), key);
  return PLUGIN_CATALOG_SIG_PREFIX + sig.toString('base64');
}

describe('parsePluginCatalog + verifyPluginPackageSignature', () => {
  it('解析 fixture：testOnly、保留签名，并验签通过', () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_CATALOG, 'utf8'));
    const doc = parsePluginCatalog(raw);
    expect(doc.v).toBe(1);
    expect(doc.testOnly).toBe(true);
    expect(doc.plugins.length).toBeGreaterThanOrEqual(1);
    const zip = doc.plugins.find((p) => p.id === 'catalog.hello');
    expect(zip?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(zip?.signature?.startsWith(PLUGIN_CATALOG_SIG_PREFIX)).toBe(true);
    expect(() => verifyPluginPackageSignature(zip!)).not.toThrow();
  });

  it('拒绝坏 sha256 / 缺 packageUrl / 坏签名格式', () => {
    expect(() =>
      parsePluginCatalog({
        v: 1,
        plugins: [{ id: 'a.b', name: 'x', version: '1', packageUrl: 'http://x', sha256: 'dead' }],
      }),
    ).toThrow(/sha256/);
    expect(() => parsePluginCatalog({ v: 1, plugins: [{ id: 'a.b', name: 'x', version: '1', packageUrl: '' }] })).toThrow(/packageUrl/);
    expect(() =>
      parsePluginCatalog({
        v: 1,
        plugins: [{ id: 'a.b', name: 'x', version: '1', packageUrl: 'http://x', sha256: '0'.repeat(64), signature: 'bad' }],
      }),
    ).toThrow(/signature/);
  });

  it('签名校验失败抛 PluginSignatureError', () => {
    expect(() =>
      verifyPluginPackageSignature({
        id: 'x',
        sha256: '0'.repeat(64),
        signature: PLUGIN_CATALOG_SIG_PREFIX + Buffer.alloc(64).toString('base64'),
      }),
    ).toThrow(PluginSignatureError);
    expect(() =>
      verifyPluginPackageSignature({
        id: 'x',
        sha256: '0'.repeat(64),
        signature: PLUGIN_CATALOG_SIG_PREFIX + Buffer.alloc(64).toString('base64'),
      }),
    ).toThrow(/签名校验失败|拦装/);
  });
});

describe('PluginCatalogInstaller', () => {
  it('从本地 fixture zip + sha256 + 签名安装，写入 plugins 并可被 list 发现', async () => {
    process.env.KB_PLUGIN_CATALOG = FIXTURE_CATALOG;
    cleanups.push(() => {
      delete process.env.KB_PLUGIN_CATALOG;
    });
    const { svc, dataDir } = await makeService();
    cleanups.push(() => svc.close());
    const inst = installerFor(svc);
    const cat = await inst.loadCatalog();
    expect(cat.plugins.some((p) => p.id === 'catalog.hello')).toBe(true);
    expect(cat.source).toBe(FIXTURE_CATALOG);
    expect(cat.testOnly).toBe(true);
    expect(cat.sourceKind).toBe('env');

    const dto = await inst.installFromCatalog('catalog.hello');
    expect(dto).toMatchObject({ id: 'catalog.hello', enabled: true, source: 'dev' });
    expect(dto.errors).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'catalog.hello', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'plugin-download-cache'))).toBe(true);
    expect(svc.plugins.list().map((p) => p.id)).toContain('catalog.hello');
    expect(svc.listPlugins().find((p) => p.id === 'catalog.hello')?.source).toBe('adapter');
  });

  it('设置页 URL 保存后 listPluginCatalog 使用新 URL（settings 优先于 fixture）', async () => {
    delete process.env.KB_PLUGIN_CATALOG;
    const custom = path.join(tmpDir('kbcat-url-'), 'custom.json');
    const sha = await hashFileSha256(FIXTURE_ZIP);
    write(
      custom,
      JSON.stringify({
        v: 1,
        name: 'custom-url-catalog',
        testOnly: true,
        plugins: [
          {
            id: 'catalog.hello',
            name: 'Custom',
            version: '0.1.0',
            packageUrl: FIXTURE_ZIP,
            sha256: sha,
            signature: signSha256Hex(sha),
          },
        ],
      }),
    );
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const inst = installerFor(svc);
    // 未配置：走 fixture
    const before = await inst.loadCatalog();
    expect(before.sourceKind).toBe('fixture');
    expect(before.configuredUrl).toBeNull();

    svc.setLayout(PLUGIN_CATALOG_LAYOUT_KEY, custom);
    expect(inst.configuredUrl()).toBe(custom);
    const after = await inst.loadCatalog();
    expect(after.sourceKind).toBe('settings');
    expect(after.source).toBe(custom);
    expect(after.configuredUrl).toBe(custom);
    expect(after.name).toBe('custom-url-catalog');
    const dto = await inst.installFromCatalog('catalog.hello');
    expect(dto.id).toBe('catalog.hello');

    // 清空
    svc.setLayout(PLUGIN_CATALOG_LAYOUT_KEY, null);
    const cleared = await inst.loadCatalog();
    expect(cleared.sourceKind).toBe('fixture');
    expect(cleared.configuredUrl).toBeNull();
  });

  it('本地文件夹源（无 hash）可安装；错 sha256 拒绝拦装', async () => {
    process.env.KB_PLUGIN_CATALOG = FIXTURE_CATALOG;
    cleanups.push(() => {
      delete process.env.KB_PLUGIN_CATALOG;
    });
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const inst = installerFor(svc);
    const dto = await inst.installFromCatalog('catalog.hello-dir');
    expect(dto.id).toBe('catalog.hello');

    const badCat = path.join(tmpDir('kbcat-'), 'bad.json');
    const sha = await hashFileSha256(FIXTURE_ZIP);
    write(
      badCat,
      JSON.stringify({
        v: 1,
        plugins: [
          {
            id: 'catalog.hello',
            name: 'x',
            version: '0.1.0',
            packageUrl: FIXTURE_ZIP,
            sha256: '0'.repeat(64),
            signature: null,
          },
        ],
      }),
    );
    process.env.KB_PLUGIN_CATALOG = badCat;
    const { svc: svc2 } = await makeService();
    cleanups.push(() => svc2.close());
    const inst2 = installerFor(svc2);
    await expect(inst2.installFromCatalog('catalog.hello')).rejects.toBeInstanceOf(PluginCatalogError);
    await expect(inst2.installFromCatalog('catalog.hello')).rejects.toThrow(/sha256/);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(FIXTURE_DIR)).toBe(true);
  });

  it('签名错误：拦装并提示', async () => {
    const sha = await hashFileSha256(FIXTURE_ZIP);
    const badCat = path.join(tmpDir('kbcat-sig-'), 'bad-sig.json');
    write(
      badCat,
      JSON.stringify({
        v: 1,
        testOnly: true,
        plugins: [
          {
            id: 'catalog.hello',
            name: 'x',
            version: '0.1.0',
            packageUrl: FIXTURE_ZIP,
            sha256: sha,
            signature: PLUGIN_CATALOG_SIG_PREFIX + Buffer.alloc(64, 7).toString('base64'),
          },
        ],
      }),
    );
    process.env.KB_PLUGIN_CATALOG = badCat;
    cleanups.push(() => {
      delete process.env.KB_PLUGIN_CATALOG;
    });
    const { svc, dataDir } = await makeService();
    cleanups.push(() => svc.close());
    const inst = installerFor(svc);
    await expect(inst.installFromCatalog('catalog.hello')).rejects.toBeInstanceOf(PluginCatalogError);
    await expect(inst.installFromCatalog('catalog.hello')).rejects.toThrow(/签名|拦装/);
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'catalog.hello'))).toBe(false);
  });

  it('安装失败：包内缺 manifest 时明确报错', async () => {
    const emptyZipDir = tmpDir('kbcat-empty-');
    const emptyZip = path.join(emptyZipDir, 'empty.zip');
    // minimal zip with one text file, no manifest
    const { execFileSync } = await import('node:child_process');
    const staging = path.join(emptyZipDir, 'pkg');
    fs.mkdirSync(staging, { recursive: true });
    write(path.join(staging, 'readme.txt'), 'no manifest');
    // use powershell Compress-Archive on Windows
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${staging}\\*' -DestinationPath '${emptyZip}' -Force`],
      { stdio: 'pipe' },
    );
    const sha = await hashFileSha256(emptyZip);
    const catPath = path.join(emptyZipDir, 'cat.json');
    write(
      catPath,
      JSON.stringify({
        v: 1,
        plugins: [
          {
            id: 'catalog.broken',
            name: 'Broken',
            version: '0.0.1',
            packageUrl: emptyZip,
            sha256: sha,
            signature: null,
          },
        ],
      }),
    );
    process.env.KB_PLUGIN_CATALOG = catPath;
    cleanups.push(() => {
      delete process.env.KB_PLUGIN_CATALOG;
    });
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const inst = installerFor(svc);
    await expect(inst.installFromCatalog('catalog.broken')).rejects.toThrow(/manifest|安装失败/);
  });


  it('闭环：安装启用后关闭再开，重启后状态仍正确', async () => {
    process.env.KB_PLUGIN_CATALOG = FIXTURE_CATALOG;
    cleanups.push(() => {
      delete process.env.KB_PLUGIN_CATALOG;
    });
    const dataDir = tmpDir('kbcat-restart-');
    const { svc } = await makeService({ dataDir });
    const inst = installerFor(svc);
    const dto = await inst.installFromCatalog('catalog.hello');
    expect(dto.enabled).toBe(true);
    svc.plugins.setEnabled('catalog.hello', true);
    svc.close();

    const { svc: svc2 } = await makeService({ dataDir });
    cleanups.push(() => svc2.close());
    const listed = svc2.plugins.list();
    const again = listed.find((p) => p.id === 'catalog.hello');
    expect(again).toBeTruthy();
    expect(again!.enabled).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'catalog.hello', 'manifest.json'))).toBe(true);
  });

  it('HTTP 清单 + zip：下载到隔离缓存后安装（带签名）', async () => {
    const zipBuf = fs.readFileSync(FIXTURE_ZIP);
    const sha = await hashFileSha256(FIXTURE_ZIP);
    const sig = signSha256Hex(sha);
    const server = http.createServer((req, res) => {
      if (req.url === '/catalog.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            v: 1,
            name: 'http-fixture',
            testOnly: true,
            plugins: [
              {
                id: 'catalog.hello',
                name: 'Catalog Hello',
                version: '0.1.0',
                packageUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/pkg.zip',
                sha256: sha,
                signature: sig,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/pkg.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(zipBuf);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    );
    process.env.KB_PLUGIN_CATALOG = `http://127.0.0.1:${port}/catalog.json`;
    cleanups.push(() => {
      delete process.env.KB_PLUGIN_CATALOG;
    });
    const { svc, dataDir } = await makeService();
    cleanups.push(() => svc.close());
    const inst = installerFor(svc);
    const cat = await inst.loadCatalog();
    expect(cat.name).toBe('http-fixture');
    const dto = await inst.installFromCatalog('catalog.hello');
    expect(dto.id).toBe('catalog.hello');
    const cached = fs.readdirSync(path.join(dataDir, 'plugin-download-cache'));
    expect(cached.some((n) => n.endsWith('.zip'))).toBe(true);
  });
});
