/**
 * 资料、编排、磁盘 ActionId（冻结草案第 5 节）。
 * installActionPackages 登记本包。本包不注册执行体。
 * 需要批准的不得标 available。桥上这些动作返回 awaiting_approval，不在这里执行。
 * 不需要批准、且主进程挂了执行体的，能力明细才是 available。
 */
import { registerActions } from '../registry';
import type { ActionInput } from '../types';

const str = { type: 'string', minLength: 1 };
const strList = { type: 'array', items: { type: 'string' } };
const idOrNull = { type: ['string', 'null'] };

function args(required: string[], properties: Record<string, object>, description?: string): object {
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    properties,
    ...(description ? { description } : {}),
  };
}

function entry(
  actionId: string,
  title: string,
  category: string,
  approvalRequired: boolean,
  bridgeInvokable: boolean,
  argsSchema: object,
): ActionInput {
  return {
    actionId,
    title,
    category,
    source: 'sources',
    approvalRequired,
    bridgeInvokable,
    argsSchema,
  };
}

/** 现有计划字段。disk.* 不进 invoke，只能 plan-submit。 */
function planArgs(): object {
  return {
    type: 'object',
    additionalProperties: false,
    description: '现有计划字段。不经 invoke，只能 plan-submit。',
    properties: {
      resourceId: str,
      rootId: { type: 'string' },
      relPath: { type: 'string' },
      content: { type: 'string' },
      expectedHash: idOrNull,
      toRelPath: { type: 'string' },
      toRootId: { type: 'string' },
    },
  };
}

/** 冻结草案第 5 节。批准列「要」为 approvalRequired；「可调 / 可提交」为 bridgeInvokable。缺省都是 false。 */
export const SOURCE_ACTIONS: readonly ActionInput[] = [
  entry('source.add.folder', '添加文件夹来源', '资料', true, true, args(['name', 'extensions'], { name: str, extensions: strList })),
  entry(
    'source.add.file',
    '添加文件来源',
    '资料',
    true,
    true,
    args([], { name: str }, '所选文件由界面选择。桥只提交待批准，不传绝对路径。'),
  ),
  entry('source.add.web', '添加网络来源', '资料', true, true, args(['url', 'title'], { url: str, title: str })),
  entry('source.remove', '移除来源', '资料', true, true, args(['sourceId'], { sourceId: str })),
  entry('source.filter.set', '设置访问范围', '资料', true, true, args(['sourceId', 'extensions'], { sourceId: str, extensions: strList })),
  entry(
    'source.remap.preview',
    '预览重映射',
    '资料',
    false,
    true,
    args(['sourceId', 'newLocation'], {
      sourceId: str,
      newLocation: { type: 'string', minLength: 1, description: '本次新位置。预览不写 root_mounts。' },
    }),
  ),
  entry(
    'source.remap.apply',
    '应用重映射',
    '资料',
    true,
    true,
    args(['preview', 'selection'], {
      preview: { type: 'object', description: 'source.remap.preview 的结果，格式 kb-workbench.remap-preview' },
      selection: {
        type: 'object',
        description: '勾选：留下的 pairs、勾上的 pathHints、勾上的 unassigned',
        properties: {
          pairs: { type: 'array', items: { type: 'object' } },
          pathHints: { type: 'array', items: { type: 'object' } },
          unassigned: { type: 'array', items: { type: 'object' } },
        },
      },
    }),
  ),
  entry('catalog.create', '新建编排', '编排', false, true, args(['name'], { name: str })),
  entry('catalog.rename', '重命名编排', '编排', false, true, args(['catalogId', 'name'], { catalogId: str, name: str })),
  entry('catalog.delete', '删除编排', '编排', true, true, args(['catalogId'], { catalogId: str })),
  entry(
    'catalog.switch',
    '切换工作区编排',
    '编排',
    false,
    true,
    args(['workspaceId', 'catalogId'], { workspaceId: str, catalogId: str }, '仅当前工作区可调。'),
  ),
  entry(
    'catalog.folder.create',
    '新建编排目录',
    '编排',
    false,
    true,
    args(['catalogId', 'parentId', 'name'], { catalogId: str, parentId: idOrNull, name: str }),
  ),
  entry(
    'catalog.folder.rename',
    '重命名编排目录',
    '编排',
    false,
    true,
    args(['catalogId', 'folderId', 'name'], { catalogId: str, folderId: str, name: str }),
  ),
  entry('catalog.folder.delete', '删除编排目录', '编排', false, true, args(['catalogId', 'folderId'], { catalogId: str, folderId: str })),
  entry(
    'catalog.folder.move',
    '移动编排目录',
    '编排',
    false,
    true,
    args(['catalogId', 'folderId', 'parentId', 'sort'], {
      catalogId: str,
      folderId: str,
      parentId: idOrNull,
      sort: { type: 'number' },
    }),
  ),
  entry(
    'catalog.ref.add',
    '加入编排引用',
    '编排',
    false,
    true,
    args(['catalogId', 'folderId', 'resourceId'], { catalogId: str, folderId: idOrNull, resourceId: str }),
  ),
  entry(
    'catalog.ref.remove',
    '移出编排引用',
    '编排',
    false,
    true,
    args(['catalogId', 'folderId', 'resourceId'], { catalogId: str, folderId: idOrNull, resourceId: str }),
  ),
  entry('catalog.export', '导出编排', '编排', false, true, args(['catalogId'], { catalogId: str })),
  // baseDigest 不符是拒绝，不是界面批准。本包不校验摘要。
  entry(
    'catalog.import',
    '导入编排',
    '编排',
    false,
    true,
    args(['content', 'baseDigest'], {
      content: { type: 'string', description: '编排文件内容' },
      baseDigest: str,
    }, 'baseDigest 与库内 digest 不符则整份拒绝，不写入。'),
  ),
  entry('disk.mkdir', '磁盘新建文件夹', '磁盘', true, false, planArgs()),
  entry('disk.move', '磁盘移动', '磁盘', true, false, planArgs()),
  entry('disk.copy', '磁盘复制', '磁盘', true, false, planArgs()),
  entry('disk.trash', '磁盘移到回收站', '磁盘', true, false, planArgs()),
  entry('disk.write', '磁盘写入', '磁盘', true, false, planArgs()),
];

let undo: (() => void) | null = null;

export function registerSourcesPackage(): void {
  if (undo) return;
  undo = registerActions('sources', SOURCE_ACTIONS);
}

export function disposeSourcesPackage(): void {
  undo?.();
  undo = null;
}
