/**
 * 壳层偏好。只读写 layout 键 settings.uiChrome，不碰别的键，也不在这里写库。
 */

export const UI_CHROME_PREFS_KEY = 'settings.uiChrome';

export interface UiChromePrefs {
  v: 1;
  reduceMotion: boolean;
  documentTabs: boolean;
  drawerOpenByDefault: boolean;
  /** 顶栏可见；关闭后可通过顶缘呼出条或命令恢复 */
  topBarVisible: boolean;
}

export const DEFAULT_UI_CHROME_PREFS: UiChromePrefs = {
  v: 1,
  reduceMotion: false,
  documentTabs: true,
  drawerOpenByDefault: true,
  topBarVisible: true,
};

export interface UiChromeLayoutPort {
  getLayout(key: string): Promise<unknown>;
  setLayout(key: string, value: unknown): Promise<void>;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 缺键、空值、非对象、v 不是 1：整份默认。v 缺省时按 v1 读已知布尔，未知字段丢掉。 */
export function parseUiChromePrefs(raw: unknown): UiChromePrefs {
  const base = { ...DEFAULT_UI_CHROME_PREFS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const record = raw as Record<string, unknown>;
  if (record.v !== undefined && record.v !== 1) return base;
  return {
    v: 1,
    reduceMotion: boolOr(record.reduceMotion, base.reduceMotion),
    documentTabs: boolOr(record.documentTabs, base.documentTabs),
    drawerOpenByDefault: boolOr(record.drawerOpenByDefault, base.drawerOpenByDefault),
    topBarVisible: boolOr(record.topBarVisible, base.topBarVisible),
  };
}

/** 只留下 v 和三个布尔。不修改入参。 */
export function serializeUiChromePrefs(prefs: UiChromePrefs): UiChromePrefs {
  return parseUiChromePrefs(prefs);
}

export function withUiChromePrefs(
  current: UiChromePrefs,
  patch: Partial<Pick<UiChromePrefs, 'reduceMotion' | 'documentTabs' | 'drawerOpenByDefault' | 'topBarVisible'>>,
): UiChromePrefs {
  return serializeUiChromePrefs({
    v: 1,
    reduceMotion: patch.reduceMotion !== undefined ? patch.reduceMotion : current.reduceMotion,
    documentTabs: patch.documentTabs !== undefined ? patch.documentTabs : current.documentTabs,
    drawerOpenByDefault: patch.drawerOpenByDefault !== undefined ? patch.drawerOpenByDefault : current.drawerOpenByDefault,
    topBarVisible: patch.topBarVisible !== undefined ? patch.topBarVisible : current.topBarVisible,
  });
}

/** 只 get 本键。缺键得到默认。失败原样抛出，不写成默认。 */
export async function loadUiChromePrefs(port: Pick<UiChromeLayoutPort, 'getLayout'>): Promise<UiChromePrefs> {
  return parseUiChromePrefs(await port.getLayout(UI_CHROME_PREFS_KEY));
}

/** 只 set 本键。失败原样抛出，调用方不得当成已保存。 */
export async function saveUiChromePrefs(port: Pick<UiChromeLayoutPort, 'setLayout'>, prefs: UiChromePrefs): Promise<UiChromePrefs> {
  const stored = serializeUiChromePrefs(prefs);
  await port.setLayout(UI_CHROME_PREFS_KEY, stored);
  return stored;
}
