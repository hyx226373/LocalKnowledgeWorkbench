/**
 * 文件选择框上次目录的入口键。每个入口各记各的，互不影响。
 * 注册根目录与注册单个文件必须分开；后续 Agent 面板用同一套键。
 */
export const DIALOG_LAST_DIR = {
  registerRoot: 'dialogLastDir.registerRoot',
  registerFile: 'dialogLastDir.registerFile',
  addMaterial: 'dialogLastDir.addMaterial',
  relocateMaterial: 'dialogLastDir.relocateMaterial',
  pluginFolder: 'dialogLastDir.pluginFolder',
  themePack: 'dialogLastDir.themePack',
  importWorkspace: 'dialogLastDir.importWorkspace',
  exportWorkspace: 'dialogLastDir.exportWorkspace',
  migrationExport: 'dialogLastDir.migrationExport',
  migrationPackage: 'dialogLastDir.migrationPackage',
  migrationImportBase: 'dialogLastDir.migrationImportBase',
  migrationLocateRoot: 'dialogLastDir.migrationLocateRoot',
  migrationRemapFolder: 'dialogLastDir.migrationRemapFolder',
  migrationRelocateFile: 'dialogLastDir.migrationRelocateFile',
  migrationPickFile: 'dialogLastDir.migrationPickFile',
  rebirthExportFolder: 'dialogLastDir.rebirthExportFolder',
  rebirthExport: 'dialogLastDir.rebirthExport',
  rebirthCover: 'dialogLastDir.rebirthCover',
  rebirthImportJson: 'dialogLastDir.rebirthImportJson',
  sourceFile: 'dialogLastDir.sourceFile',
  archiveLocation: 'dialogLastDir.archiveLocation',
  /** 设置里更改整个 Agent 数据目录，不和存档目录、注册根混用。 */
  agentDataLocation: 'dialogLastDir.agentDataLocation',
  /** 写入项目时选择目标根目录。 */
  writeProjectRoot: 'dialogLastDir.writeProjectRoot',
  /** 保留键名。新建文件已改为在侧栏抽屉里点选已注册文件夹，不再打开系统选文件夹框。 */
  newFile: 'dialogLastDir.newFile',
} as const;

export type DialogLastDirKey = (typeof DIALOG_LAST_DIR)[keyof typeof DIALOG_LAST_DIR];
