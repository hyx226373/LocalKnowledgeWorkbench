/**
 * 适配器宿主的主进程模块（第 9 轮起新增代码放在这里）：
 *  - appBackup.ts：外部程序启动前备份（只备份目标文件 + 声明的附加文件；上限与保留期）
 *  - appLauncher.ts：外部程序进程代理（授权、校验、固定参数模板、备份、spawn、退出后比较）
 *  - winVerify.ts：Windows 上的签名/哈希/版本校验
 *  - displayModes.ts：三类适配器显示方式的如实说明（主进程/文档/界面共用）
 * 接线（IPC、界面、发布阶段）尚未完成，见 docs/09-接口请求.md。
 */
export * from './appBackup';
export * from './appLauncher';
export * from './winVerify';
export * from './displayModes';
export * from './appHost';
