import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InboxEngine } from '../src/main/aiWrite/inboxCopy';
import { performDrop, type FlowPorts } from '../src/renderer/dnd/flow';
import { onDropTarget } from '../src/renderer/dnd/resolve';
import type { CopyReviewOp, DragPayload, DropDecision } from '../src/renderer/dnd/types';
import { HINT_COPY_REVIEW } from '../src/renderer/dnd/copy';

describe('跨区写进真实文件夹走审核计划 (planDrop)', () => {
  let tmpDir: string;
  let inboxDir: string;
  let rootDir: string;
  let sourceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dnd-test-'));
    inboxDir = path.join(tmpDir, 'inbox');
    rootDir = path.join(tmpDir, 'root');
    sourceDir = path.join(tmpDir, 'source');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('跨区 drop 生成审核计划，在批准前绝不直接落盘', async () => {
    const srcFile = path.join(sourceDir, 'note.md');
    fs.writeFileSync(srcFile, 'hello world from workbench', 'utf8');

    const backupFn = vi.fn();
    const engine = new InboxEngine({
      dir: path.join(tmpDir, 'agent-data', 'ai-write'),
      now: () => new Date('2026-10-18T12:00:00Z'),
      trash: async () => {},
      inboxRoot: () => inboxDir,
      discardConfirm: () => true,
      backup: backupFn,
      assertSafe: () => {},
      writeFile: (file, bytes) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      },
    });

    const targetFolder = path.join(rootDir, 'docs');
    fs.mkdirSync(targetFolder, { recursive: true });
    const targetDestFile = path.join(targetFolder, 'note.md');

    // 生成计划
    const planResult = engine.planDrop(inboxDir, targetFolder, [
      { name: 'note.md', sourceAbs: srcFile },
    ]);

    expect(planResult.sessionId).toBeTruthy();
    expect(planResult.fileIds.length).toBe(1);
    expect(planResult.nameClash).toBe(false);

    // 核心断言：生成计划后，目标文件绝不直接落盘
    expect(fs.existsSync(targetDestFile)).toBe(false);

    // 收件箱里保留了副本
    const sessionDir = path.join(inboxDir, planResult.sessionId);
    expect(fs.existsSync(path.join(sessionDir, 'note.md'))).toBe(true);

    // 批准后才写入目标文件
    const applyRes = await engine.apply({
      sessionId: planResult.sessionId,
      fileId: planResult.fileIds[0],
      decision: 'approve',
    });
    expect(applyRes).toEqual({ ok: true });
    expect(fs.existsSync(targetDestFile)).toBe(true);
    expect(fs.readFileSync(targetDestFile, 'utf8')).toBe('hello world from workbench');
  });

  it('目标已有同名文件时：标记 conflict，approve 绝不自动覆盖，只有 overwrite 才会覆盖', async () => {
    const srcFile = path.join(sourceDir, 'clash.txt');
    fs.writeFileSync(srcFile, 'new content', 'utf8');

    const targetDestFile = path.join(rootDir, 'clash.txt');
    fs.writeFileSync(targetDestFile, 'original content', 'utf8');

    const backupFn = vi.fn();
    const engine = new InboxEngine({
      dir: path.join(tmpDir, 'agent-data', 'ai-write'),
      now: () => new Date('2026-10-18T12:00:00Z'),
      trash: async () => {},
      inboxRoot: () => inboxDir,
      discardConfirm: () => true,
      backup: backupFn,
      assertSafe: () => {},
      writeFile: (file, bytes) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      },
    });

    const planResult = engine.planDrop(inboxDir, rootDir, [
      { name: 'clash.txt', sourceAbs: srcFile },
    ]);

    expect(planResult.nameClash).toBe(true);

    // 普通 approve 拒绝覆盖，返回 conflict
    const rejectOverwrite = await engine.apply({
      sessionId: planResult.sessionId,
      fileId: planResult.fileIds[0],
      decision: 'approve',
    });
    expect(rejectOverwrite.ok).toBe(false);
    expect((rejectOverwrite as any).reason).toBe('conflict');
    expect(fs.readFileSync(targetDestFile, 'utf8')).toBe('original content');

    // 必须显式 overwrite
    const overwriteRes = await engine.apply({
      sessionId: planResult.sessionId,
      fileId: planResult.fileIds[0],
      decision: 'overwrite',
    });
    expect(overwriteRes).toEqual({ ok: true });
    expect(fs.readFileSync(targetDestFile, 'utf8')).toBe('new content');
    // 覆盖前执行了备份
    expect(backupFn).toHaveBeenCalled();
  });

  it('performDrop 遇到 copy-review 触发 ports.planDrop', async () => {
    let plannedOps: CopyReviewOp[] | null = null;
    const mockPorts: FlowPorts = {
      propose: vi.fn(),
      approve: vi.fn(),
      getLayout: vi.fn(),
      setLayout: vi.fn(),
      addWorkspaceRefs: vi.fn(),
      removeWorkspaceRef: vi.fn(),
      open: vi.fn(),
      confirmMove: vi.fn(),
      confirm: vi.fn(),
      alert: vi.fn(),
      planDrop: async (ops) => {
        plannedOps = ops;
      },
    };

    const decision: DropDecision = {
      action: {
        type: 'copy-review',
        ops: [
          {
            name: 'doc.md',
            resourceId: 'r1',
            toRootId: 'A',
            toRelPath: 'folder/doc.md',
            entryKind: 'file',
          },
        ],
        nameClash: false,
      },
      dropEffect: 'copy',
      hint: HINT_COPY_REVIEW,
    };

    const res = await performDrop(decision, mockPorts);
    expect(res.status).toBe('done');
    expect(plannedOps).not.toBeNull();
    expect(plannedOps![0].name).toBe('doc.md');
  });
});
