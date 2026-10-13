# 本地知识工作台 · LocalKnowledgeWorkbench

一个围绕现有本地资料搭建工作现场的 Windows 桌面工作台。

## 当前能力

- 登记文件夹或单个文件来源，保留原文件位置。
- 工作区独立编排根目录，保存布局并恢复阅读现场。
- Markdown、文本、图片、PDF 与网页在同一应用内阅读。
- 分屏、浮动窗口、气泡收纳、收藏、搜索和内容缩放。
- 插件与主题扩展，以及向外部 agent 交接资料的本地文件入口。

## 0.2.5 交付状态

安装版和便携版作为 GitHub Release 附件提供。当前 Release 保持草稿：打包报告中的原生数据库模块检查未通过，尚未在本次上传中复验。

完整的 Agent 工作区共用模型仍停留在设计冻结阶段；原生窗口托管仍是实验功能。

## 源码结构

- `workbench/`：Electron、TypeScript、React 主应用。
- `modules/`：文件操作、资料身份、计划、同步、索引与 agent 接口模块。
- `modules-r11-E-3888323/indexer/`：主应用引用的正文索引分支。
- `kb-adapter-sdk/`：插件适配器 SDK。
- `SOURCE-PROVENANCE.json`：导出的原始提交和交付边界。

主应用来自提交 `84e1dd5a6e2d07ad0f8574f2f8b2bc241a07d10e`。本仓以独立源码快照提交，未复制正在修改的工作树、用户数据库、登录凭据、安装目录或私人资料。外部模块按记录的提交导出；本次未进行重新构建，源码到安装包的完整复现尚未验证。

## 开发

各模块的安装、构建入口见相应 `package.json`；模块完成构建后，在 `workbench/` 中安装依赖并运行 `npm run dev` 或 `npm run build`。详细架构与接口资料见 `workbench/docs/`。应用内部的历史 README 和 MODULES-PIN.md 属于原始快照，当前导出来源以根目录 SOURCE-PROVENANCE.json 为准。

目前通过手动下载和覆盖更新程序，用户数据单独保存在 `%LOCALAPPDATA%\LocalKnowledgeWorkbench`。
