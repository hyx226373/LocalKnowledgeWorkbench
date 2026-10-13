# build/（electron-builder 打包资源）

- `icon.png`、`icon-512.png`、`icon.ico`（16–256 px）：由 `npm run icon`（`scripts/gen-icon.py`）从 `src/renderer/assets/brand-icon.png` 生成。`icon.png` 是品牌图的字节复制。
- `installer.nsh`：NSIS 安装包的自定义脚本。卸载时询问是否删除用户数据（默认“否”= 保留；静默卸载与升级覆盖安装也保留）。
