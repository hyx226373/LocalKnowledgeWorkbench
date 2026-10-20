import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMaterial } from '../src/shared/agentLive/types';
import { atomicWriteFile, promoteEntryFiles, promoteIfComplete } from '../src/main/agentLive/entry/atomic';
import {
  AGREEMENT,
  CURSOR_HINT,
  STABILITY,
  UNTRUSTED,
  createLiveEntryWriter,
  estimateTokens,
  formatTotal,
  type EntryScene,
  type LiveEntryController,
} from '../src/main/agentLive/entry';

const ROOT = 'D:\\kb-r13-work\\al-3\\unit';
const HEX = 'ab'.repeat(32);
const NOW = () => new Date('2026-10-08T07:00:00.000Z');

let writer: LiveEntryController | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fresh(): { dir: string; bridge: string } {
  fs.mkdirSync(ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  const bridge = path.join(dir, 'agent-bridge');
  fs.mkdirSync(bridge, { recursive: true });
  return { dir, bridge };
}

function item(i: number, tier: 'session' | 'pinned' = 'session', absPath?: string): AgentMaterial {
  const nn = String(i).padStart(2, '0');
  return {
    materialId: `m${nn}`,
    tier,
    resourceId: `r${nn}`,
    sourceId: 'src1',
    relPath: `第三章/实验${nn}.md`,
    absPath: absPath ?? `D:\\论文\\第三章\\实验${nn}.md`,
    name: `实验${nn}.md`,
    purpose: i % 5 === 0 ? null : '对照数据',
    order: i,
    status: 'ok',
    contentHash: `sha256:${HEX}`,
    contentVersion: 1,
    readable: null,
    addedAt: '2026-10-08T00:00:00.000Z',
    bytes: 12_000,
    estTokens: 800,
    hasText: true,
  };
}

function plantContent(bridge: string, workspaceId: string, materialId: string): void {
  const dir = path.join(bridge, 'live', 'ws', workspaceId, 'content', materialId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${HEX}.txt`), '已有正文');
}

function open(
  bridge: string,
  scene: EntryScene | ((rev: number) => EntryScene | Promise<EntryScene>),
  extra: Partial<Parameters<typeof createLiveEntryWriter>[0]> = {},
): LiveEntryController {
  const next = createLiveEntryWriter({
    bridgeRoot: bridge,
    now: NOW,
    loadScene: (typeof scene === 'function' ? (_id, rev) => scene(rev) : () => scene),
    ...extra,
  });
  writer = next;
  return next;
}

function readEntry(bridge: string, workspaceId = 'ws-m'): string {
  return fs.readFileSync(path.join(bridge, 'live', 'ws', workspaceId, 'ENTRY.md'), 'utf8');
}

afterEach(async () => {
  if (writer) {
    await writer.whenIdle();
    writer = null;
  }
});

describe('agent live 入口', () => {
  it('空清单入口含六块、原文约定，且不超过 3KB', async () => {
    const box = fresh();
    const live = open(box.bridge, { workspaceName: '论文第三章' });
    await live.render('ws-m', 1);
    const text = readEntry(box.bridge);
    const marker = '<!-- kb-live schemaVersion=1 revision=1 generatedAt=2026-10-08T07:00:00.000Z -->\n';
    expect(text).toContain(marker);
    expect(text.indexOf('## 规则（必须遵守）')).toBeLessThan(text.indexOf(marker));
    expect(text).not.toContain('## 上下文底座');
    expect(text.indexOf('## 1. 工作区')).toBeLessThan(text.indexOf('## 2. 已打开的资料'));
    expect(text.indexOf('## 2. 已打开的资料')).toBeLessThan(text.indexOf('## 3. 工作资料'));
    expect(text.indexOf('## 3. 工作资料')).toBeLessThan(text.indexOf('## 4. 导航'));
    expect(text.indexOf('## 4. 导航')).toBeLessThan(text.indexOf('## 5. 版本'));
    expect(text.indexOf('## 5. 版本')).toBeLessThan(text.indexOf('## 6. 接入约定'));
    expect(text).toContain(AGREEMENT);
    expect(text).toContain(UNTRUSTED);
    expect(text).toContain(STABILITY);
    expect(text).toContain(CURSOR_HINT);
    expect(text).toContain('清单为空。仅了解基本现场和导航。');
    expect(text).toContain('nav/structure.md');
    expect(text).toContain('../../../AGENT_START_HERE.md');
    expect(text).toContain('0 项 · 0B · 约 0 tokens');
    const legacyStart = text.indexOf(marker);
    expect(text).not.toContain('历史摘录');
    expect(text).not.toContain('对话目录');
    expect(Buffer.byteLength(text.slice(legacyStart))).toBeLessThanOrEqual(3072);
    expect(fs.existsSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'marker.json'))).toBe(false);
    const guide = fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'nav', 'guide.md'), 'utf8');
    expect(guide).toContain(STABILITY);
    expect(text).toContain('可直接读取');
    expect(guide).toContain('可直接读取');
    expect(guide).toContain('本机真实绝对路径');
    expect(guide).toContain('不用另走请求');
    expect(text).not.toContain('不能直接读');
    expect(guide).not.toContain('不能直接读');
    expect(text).not.toContain('须走请求');
    expect(guide).not.toContain('须走请求');
    expect(guide).toContain('监视 `live/<scope>/` 这个目录，不要只监视 `marker.json` 这一个文件');
    expect(guide).toContain('300ms');
    expect(guide).toContain(CURSOR_HINT);
    const arch = fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'nav', 'architecture.md'), 'utf8');
    expect(arch).toContain('批准只在人类界面');
    expect(arch).toContain('不另建逐文件监视');
    expect(arch).not.toContain('agent-token.json');
    expect(guide).not.toContain('agent-token.json');
  });

  it('两区、前 50 项和快照字段', async () => {
    const box = fresh();
    const materials = [
      item(1, 'session'),
      item(2, 'pinned'),
      ...Array.from({ length: 50 }, (_, n) => item(n + 3, 'session')),
    ];
    for (const material of materials) plantContent(box.bridge, 'ws-m', material.materialId);
    const live = open(box.bridge, {
      workspaceName: '论文第三章',
      purpose: '写实验',
      panels: [{ panelId: 'p1', name: '实验01.md', absPath: 'D:\\论文\\第三章\\实验01.md', materialId: 'm01' }],
      reading: { panelId: 'p1', name: '实验01.md', absPath: 'D:\\论文\\第三章\\实验01.md', materialId: 'm01' },
      materials,
    });
    await live.render('ws-m', 8);
    const text = readEntry(box.bridge);
    expect(text).toContain('### 本轮资料');
    expect(text).toContain('### 固定资料');
    expect(text.indexOf('### 本轮资料')).toBeLessThan(text.indexOf('### 固定资料'));
    expect(text).toContain('当前阅读：实验01.md · D:\\论文\\第三章\\实验01.md');
    expect(text).toContain('入口只列出前 50 项');
    expect(text).not.toContain('实验52.md');
    const snapshot = JSON.parse(fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
      schemaVersion: number;
      appVersion: string;
      generatedAt: string;
      sections: string[];
      purpose?: string;
      materials: Array<{ tier?: string; materialId: string; contentStatus?: string }>;
      sessionMaterials: unknown[];
      pinnedMaterials: Array<{ materialId: string }>;
      nav: { structure: string };
    };
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.appVersion).toBe('0.2.0');
    expect(snapshot.generatedAt).toBe('2026-10-08T07:00:00.000Z');
    expect(snapshot.purpose).toBe('写实验');
    expect(snapshot.sections).toEqual([
      'workspace',
      'purpose',
      'panels',
      'reading',
      'materials',
      'sessionMaterials',
      'pinnedMaterials',
      'nav',
    ]);
    expect(snapshot.materials).toHaveLength(52);
    expect(snapshot.sessionMaterials.length + snapshot.pinnedMaterials.length).toBe(52);
    expect(snapshot.pinnedMaterials.map((row) => row.materialId)).toEqual(['m02']);
    expect(snapshot.nav.structure).toBe('nav/structure.md');
    expect(snapshot.materials.every((row) => row.contentStatus === 'ready')).toBe(true);
  });

  it('索引里已有的 PDF 在快照之前落盘，缺索引则标生成中且不阻塞', async () => {
    const box = fresh();
    const order: string[] = [];
    let indexed = 0;
    let release: (value: { text: string }) => void = () => undefined;
    const gate = new Promise<{ text: string }>((resolve) => {
      release = resolve;
    });
    const ready: string[][] = [];
    const pdf = item(1, 'session', path.join(box.dir, '未提取.pdf'));
    pdf.name = '未提取.pdf';
    pdf.relPath = '未提取.pdf';
    pdf.estTokens = null;
    pdf.bytes = null;
    const hit = item(2, 'pinned', path.join(box.dir, '已索引.pdf'));
    hit.name = '已索引.pdf';
    hit.relPath = '已索引.pdf';
    hit.materialId = 'mpdf';
    hit.contentHash = `sha256:${'cd'.repeat(32)}`;
    const md = item(3, 'session', path.join(box.dir, '笔记.md'));
    const live = open(
      box.bridge,
      { workspaceName: '论文', materials: [pdf, hit, md] },
      {
        trace: (step) => {
          order.push(step);
          if (step === 'snapshot') {
            const file = path.join(box.bridge, 'live', 'ws', 'ws-m', 'content', 'mpdf', `${'cd'.repeat(32)}.txt`);
            expect(fs.readFileSync(file, 'utf8')).toBe('第一页\f第二页');
          }
        },
        readIndexedText: (material) => {
          indexed += 1;
          if (material.materialId !== 'mpdf') return null;
          return { pageTexts: ['第一页', '第二页'], pages: 2 };
        },
        extractText: (material) => (material.name.endsWith('.pdf') ? gate : Promise.resolve(null)),
        onContentReady: (_workspaceId, ids) => ready.push(ids),
      },
    );
    await live.render('ws-m', 3);
    expect(order).toEqual(['content', 'nav', 'snapshot', 'entry']);
    expect(indexed).toBe(2);
    const text = readEntry(box.bridge);
    expect(text).toContain('内容生成中');
    expect(text).toContain(`content/mpdf/${'cd'.repeat(32)}.txt`);
    const snapshot = JSON.parse(fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
      materials: Array<{ materialId: string; contentStatus: string; pages?: number; hasText?: boolean }>;
    };
    const pdfRow = snapshot.materials.find((row) => row.materialId === 'm01');
    const hitRow = snapshot.materials.find((row) => row.materialId === 'mpdf');
    expect(pdfRow?.contentStatus).toBe('generating');
    expect(hitRow?.contentStatus).toBe('ready');
    expect(hitRow?.pages).toBe(2);
    expect(hitRow?.hasText).toBe(true);
    expect(ready).toEqual([]);
    const before = readEntry(box.bridge);
    release({ text: '后来的正文' });
    await live.whenIdle();
    expect(readEntry(box.bridge)).toBe(before);
    expect(ready).toEqual([['m01', 'm03']]);
    expect(fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'content', 'm01', `${HEX}.txt`), 'utf8')).toBe('后来的正文');
    await live.render('ws-m', 4);
    expect(readEntry(box.bridge)).toContain(`content/m01/${HEX}.txt`);
    expect(readEntry(box.bridge)).not.toContain('内容生成中');
  });

  it('不读源文件，不把噪声目录写进结构', async () => {
    const box = fresh();
    const source = path.join(box.dir, '实验.md');
    fs.writeFileSync(source, '正文不应被入口读入');
    fs.mkdirSync(path.join(box.dir, 'noise'));
    fs.writeFileSync(path.join(box.dir, 'noise', 'noise-999.txt'), '噪声');
    const material = item(1, 'session', source);
    material.contentHash = null;
    material.estTokens = null;
    const live = open(box.bridge, {
      workspaceName: '论文',
      materials: [material],
      structure: [{ name: '论文', children: [{ name: '实验.md', relPath: '实验.md' }] }],
    });
    await live.render('ws-m', 2);
    const structure = fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'nav', 'structure.md'), 'utf8');
    expect(structure).toContain('实验.md');
    expect(structure).not.toContain('noise-999');
    expect(structure).not.toContain('没有遍历根目录');
    const entry = readEntry(box.bridge);
    expect(entry).not.toContain('正文不应被入口读入');
    expect(entry).toContain('内容生成中');
    expect(fs.existsSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'changes'))).toBe(false);
  });

  it('凭据文件不出现在入口、快照和导航里', async () => {
    const box = fresh();
    const secret = path.join(box.dir, 'agent-token.json');
    fs.writeFileSync(secret, 'SUPERSECRET');
    const material = item(1, 'session', secret);
    material.name = 'agent-token.json';
    material.relPath = 'agent-token.json';
    const live = open(box.bridge, {
      workspaceName: '论文',
      materials: [material],
      panels: [{ panelId: 'p1', name: 'agent-token.json', absPath: secret }],
      structure: [{ name: 'agent-token.json', relPath: 'agent-token.json' }],
    });
    await live.render('ws-m', 1);
    const root = path.join(box.bridge, 'live', 'ws', 'ws-m');
    const files: string[] = [];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) stack.push(full);
        else files.push(full);
      }
    }
    const blob = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(blob).not.toContain('agent-token.json');
    expect(blob).not.toContain('SUPERSECRET');
    expect(blob).toContain('已隐藏');
    expect(fs.existsSync(path.join(root, 'content'))).toBe(false);
  });

  it('当前入口只在活动工作区更新，链接从 current 出发', async () => {
    const box = fresh();
    fs.mkdirSync(path.join(box.bridge, 'live', 'current'), { recursive: true });
    fs.writeFileSync(path.join(box.bridge, 'live', 'current', 'ENTRY.md'), 'KEEP\n');
    const idle = open(box.bridge, { workspaceName: '乙' }, { isCurrent: () => false });
    await idle.render('ws-b', 1);
    expect(fs.readFileSync(path.join(box.bridge, 'live', 'current', 'ENTRY.md'), 'utf8')).toBe('KEEP\n');
    expect(fs.existsSync(path.join(box.bridge, 'live', 'current', 'snapshot.json'))).toBe(false);
    const live = open(box.bridge, { workspaceName: '甲' }, { isCurrent: (id) => id === 'ws-m' });
    await live.render('ws-m', 6);
    const current = fs.readFileSync(path.join(box.bridge, 'live', 'current', 'ENTRY.md'), 'utf8');
    expect(current).toContain('revision=6 ');
    expect(current).toContain('../ws/ws-m/nav/structure.md');
    expect(current).toContain('../../AGENT_START_HERE.md');
    expect(current).toContain('../ws/ws-m/snapshot.json');
    expect(fs.existsSync(path.join(box.bridge, 'live', 'current', 'snapshot.json'))).toBe(false);
    expect(fs.existsSync(path.join(box.bridge, 'live', 'current', 'marker.json'))).toBe(false);
    expect(readEntry(box.bridge)).toContain('../../../AGENT_START_HERE.md');
  });

  it('启动时先用已有入口，后台再更新', async () => {
    const box = fresh();
    const entry = path.join(box.bridge, 'live', 'ws', 'ws-m', 'ENTRY.md');
    const snapshot = path.join(box.bridge, 'live', 'ws', 'ws-m', 'snapshot.json');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '<!-- kb-live schemaVersion=1 revision=1 generatedAt=2026-10-08T00:00:00.000Z -->\n旧入口\n');
    fs.writeFileSync(snapshot, '{}\n');
    let loads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = open(box.bridge, async () => {
      loads += 1;
      await gate;
      return { workspaceName: '新现场' };
    });
    const mode = await live.startup('ws-m', 2);
    expect(mode).toBe('cached');
    expect(fs.readFileSync(entry, 'utf8')).toContain('旧入口');
    expect(fs.readFileSync(entry, 'utf8')).not.toContain('新现场');
    await delay(20);
    expect(loads).toBe(1);
    release();
    await live.whenIdle();
    expect(fs.readFileSync(entry, 'utf8')).toContain('新现场');
    expect(fs.readFileSync(entry, 'utf8')).toContain('revision=2 ');
  });

  it('同一轮里的多次 render 只写最后的版本', async () => {
    const box = fresh();
    let calls = 0;
    const live = open(box.bridge, (_rev) => {
      calls += 1;
      return { workspaceName: '论文' };
    });
    await Promise.all([live.render('ws-m', 1), live.render('ws-m', 2), live.render('ws-m', 3)]);
    expect(calls).toBe(1);
    expect(readEntry(box.bridge)).toContain('revision=3 ');
  });

  it('manifest 生成应用功能，失效项保留', async () => {
    const box = fresh();
    fs.writeFileSync(
      path.join(box.bridge, 'manifest.json'),
      JSON.stringify({
        capabilityDetails: [{ name: 'query', description: '列根', availability: 'available', approvalRequired: false }],
      }),
    );
    const gone = item(1, 'session', path.join(box.dir, '不见了.md'));
    gone.status = 'missing';
    const live = open(box.bridge, { workspaceName: '论文', materials: [gone] });
    await live.render('ws-m', 1);
    const actions = fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'nav', 'actions.md'), 'utf8');
    expect(actions).toContain('| query | 列根 | available | 否 |');
    expect(actions).toContain('| agent.getContent | 否 |');
    expect(actions).toContain('| agent.materials.clearSession | 是 |');
    const text = readEntry(box.bridge);
    expect(text).toContain('missing');
    expect(text).toContain('失效，条目保留');
    const relations = fs.readFileSync(path.join(box.bridge, 'live', 'ws', 'ws-m', 'nav', 'relations.md'), 'utf8');
    expect(relations).toContain('不扫描资料库');
  });

  it('合计超过 150k tokens 只提示', async () => {
    const box = fresh();
    const big = item(1);
    big.estTokens = 150_001;
    big.bytes = 12_000;
    plantContent(box.bridge, 'ws-m', big.materialId);
    const live = open(box.bridge, { workspaceName: '论文', materials: [big] });
    await live.render('ws-m', 1);
    expect(readEntry(box.bridge)).toContain('合计超过 150k tokens，只提示，不拦截。');
    const edge = item(2);
    edge.estTokens = 150_000;
    expect(formatTotal([edge])).not.toContain('超过');
  });

  it('非法工作区 id 拒绝写入', async () => {
    const box = fresh();
    const live = open(box.bridge, { workspaceName: '论文' });
    expect(() => live.render('../ws', 1)).toThrow(/workspaceId/);
    expect(fs.existsSync(path.join(box.bridge, 'live', 'ws', '..'))).toBe(false);
  });

  it('原子写失败留下 tmp，完整 tmp 会提升，不碰 marker', async () => {
    const box = fresh();
    const dest = path.join(box.dir, 'snapshot.json');
    const waits: number[] = [];
    let tries = 0;
    await atomicWriteFile(dest, '{"ok":1}\n', {
      rename: async (from, to) => {
        tries += 1;
        if (tries < 3) {
          const err = new Error('busy') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        await fs.promises.rename(from, to);
      },
      delay: async (ms) => {
        waits.push(ms);
      },
    });
    expect(tries).toBe(3);
    expect(waits).toEqual([20, 40]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('{"ok":1}\n');
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);

    const stuck = path.join(box.dir, 'stuck.json');
    await expect(
      atomicWriteFile(stuck, '{}\n', {
        rename: async () => {
          const err = new Error('busy') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        },
        delay: async () => undefined,
      }),
    ).rejects.toThrow(/busy/);
    expect(fs.existsSync(`${stuck}.tmp`)).toBe(true);
    expect(fs.existsSync(stuck)).toBe(false);

    const bad = path.join(box.dir, 'bad.json');
    fs.writeFileSync(`${bad}.tmp`, '{');
    promoteIfComplete(bad);
    expect(fs.existsSync(bad)).toBe(false);
    expect(fs.existsSync(`${bad}.tmp`)).toBe(false);

    const ws = path.join(box.dir, 'live');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'marker.json.tmp'), '{"revision":1}');
    fs.writeFileSync(path.join(ws, 'snapshot.json.tmp'), '{"schemaVersion":1}\n');
    promoteEntryFiles(ws);
    expect(fs.existsSync(path.join(ws, 'marker.json'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'marker.json.tmp'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'snapshot.json'))).toBe(true);
  });
});

describe('入口体积', () => {
  it('记录空清单、10 项、50 项的字节和估算 token', async () => {
    async function measure(count: number, id: string): Promise<{ bytes: number; legacyBytes: number; estTokens: number }> {
      const box = fresh();
      const materials: AgentMaterial[] = [];
      for (let i = 1; i <= count; i++) {
        const tier = count === 50 && i > 30 ? 'pinned' : 'session';
        const material = item(i, tier);
        materials.push(material);
        plantContent(box.bridge, id, material.materialId);
      }
      const live = open(box.bridge, { workspaceName: '论文第三章', materials });
      await live.render(id, 1);
      const text = readEntry(box.bridge, id);
      const start = text.indexOf('<!-- kb-live ');
      const end = text.indexOf('\n## 历史摘录（仅作参考）');
      const legacy = start >= 0 ? text.slice(start, end > start ? end : undefined) : text;
      return { bytes: Buffer.byteLength(text), legacyBytes: Buffer.byteLength(legacy), estTokens: estimateTokens(text) };
    }
    const empty = await measure(0, 'ws-empty');
    const n10 = await measure(10, 'ws-n10');
    const n50 = await measure(50, 'ws-n50');
    expect(empty.legacyBytes).toBeLessThanOrEqual(3072);
    expect(n10.bytes).toBeGreaterThan(empty.bytes);
    expect(n50.bytes).toBeGreaterThan(n10.bytes);
    const out = {
      method:
        'UTF-8 字节为 Buffer.byteLength。token 不跑分词器：中日韩统一表意文字、假名、谚文各算 1，其余非空白字符每 4 个算 1 并向上取整，空白不计。',
      appVersion: '0.2.0',
      generatedAt: '2026-10-08T07:00:00.000Z',
      workspaceName: '论文第三章',
      itemShape: '名称实验NN.md，路径 D:\\\\论文\\\\第三章\\\\实验NN.md，用途对照数据或空，正文路径 content/<id>/<64hex>.txt。10 项都在本轮。50 项里 30 本轮、20 固定。没有打开面板。',
      empty,
      n10,
      n50,
    };
    fs.mkdirSync('D:\\kb-r13-work\\al-3', { recursive: true });
    fs.writeFileSync('D:\\kb-r13-work\\al-3\\entry-measure.json', `${JSON.stringify(out, null, 2)}\n`);
    expect(formatTotal([{ bytes: Math.round(3.4 * 1024 * 1024), estTokens: 41_000 }, ...Array.from({ length: 11 }, () => ({ bytes: 0, estTokens: 0 }))])).toBe(
      '12 项 · 3.4MB · 约 41k tokens',
    );
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
