/** 快捷键 when 子句（总包 §2.3）；缺省 global */
export type KeybindingWhen = 'global' | 'editorFocus' | 'treeFocus' | 'webFocus';

export const WHEN_LABELS: Record<KeybindingWhen, string> = {
  global: '全局',
  editorFocus: '编辑器',
  treeFocus: '目录树',
  webFocus: '网页',
};

export const WHEN_OPTIONS: KeybindingWhen[] = ['global', 'editorFocus', 'treeFocus', 'webFocus'];

/** KV `settings.keybindings` */
export interface KeybindingsStoreV1 {
  v: 1;
  /** null = 用户清除（无快捷键）；缺省键 = 使用命令默认 */
  overrides: Record<string, string | null>;
  /** 可选：用户覆盖 when；缺省用命令声明 */
  whenOverrides?: Record<string, KeybindingWhen>;
}

export interface CommandKeyInfo {
  id: string;
  title: string;
  category?: string;
  /** 命令声明的默认快捷键 */
  defaultKeybinding?: string;
  /** 命令声明的默认 when */
  defaultWhen?: KeybindingWhen;
  /** 归属插件；builtin.workbench 等 */
  owner?: string;
  /** 插件已卸载但 override 仍在 */
  missingPlugin?: boolean;
}

export interface EffectiveBinding {
  commandId: string;
  /** 规范化后的快捷键；null = 无 */
  key: string | null;
  when: KeybindingWhen;
  isDefault: boolean;
  isCleared: boolean;
}
