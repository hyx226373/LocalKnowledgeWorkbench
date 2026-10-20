/**
 * 主程序和 Obsidian 工作台桥之间的调用形状。
 * 文件交换格式见 reports/item6_interface.md。这里不写 obsidian.json。
 */

export const JUNCTION_WARNING = '在 Obsidian 里改名、删除或移动文件，会直接作用到原文件。';

export const DEFAULT_EXCHANGE_DIR = 'lkw-exchange';
export const DEFAULT_RELAY_VAULT_NAME = 'LKW-Relay-Vault';

export interface ObsidianBridgeSettings {
  /** 实际使用的中转库绝对路径。 */
  relayVaultDir: string;
  /** 没单独指定时的默认路径。 */
  defaultRelayVaultDir: string;
  usingDefault: boolean;
  /** 与中转库 data.json 的 crossVolumeJunction 一致。缺省或不是 true 时为 false。 */
  crossVolumeJunction: boolean;
  /** 中转库里已经有 .obsidian。 */
  vaultReady: boolean;
  /** 开关打开时的风险提示。关闭时为空。 */
  warning: string;
}

export interface ObsidianOpenRequest {
  absPath: string;
  block?: string;
  heading?: string;
}

export interface ObsidianOpenResult {
  ok: boolean;
  uri?: string;
  via?: 'vault' | 'relay';
  message?: string;
}

export interface ObsidianInitResult {
  ok: boolean;
  vaultRoot?: string;
  pluginInstalled?: boolean;
  instructions?: string;
  message?: string;
}
