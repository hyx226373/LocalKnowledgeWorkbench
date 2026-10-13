/**
 * 插件视图的窗口能力声明（接口草案，第九轮只实现校验与默认值，docs/11 §7）。
 * 适配器（ReaderAdapter / 沙箱 manifest 的 contributes.adapters[]）与侧栏面板（panels 扩展点）以后都可以带 window 字段；
 * 面板管理层按声明决定：能否浮动 / 收起 / 最大化、最小尺寸、默认浮动尺寸、是否原生表面（需要遮挡截图）。
 */
import type { Size } from './types';

export interface ViewWindowDecl {
  /** 最小尺寸（px）。浮动窗口与分屏分组都不小于它；默认 240×140 */
  minSize?: Partial<Size>;
  /** 首次浮动时的尺寸；默认按容器 55%×60% */
  defaultFloatSize?: Partial<Size>;
  /** 可否浮动（自由窗口）；默认 true */
  canFloat?: boolean;
  /** 可否停靠进分屏；默认 true（false = 只能浮动，例如小工具） */
  canDock?: boolean;
  /** 可否收起成气泡；默认 true */
  canCollapse?: boolean;
  /** 可否最大化；默认 true */
  canMaximize?: boolean;
  /** 首次打开的位置；默认 'dock' */
  initialPlacement?: 'dock' | 'float';
  /** 原生表面（网页 WebContentsView、外部程序窗口）：被更高层窗口/菜单遮挡时宿主改显示截图；默认按 displayMode 推断 */
  nativeSurface?: boolean;
  /** 能否拖出主窗口成为独立系统窗口（popout，待产品决定，默认 false） */
  canPopout?: boolean;
}

export interface ResolvedViewWindow {
  minSize: Size;
  defaultFloatSize: Size | null;
  canFloat: boolean;
  canDock: boolean;
  canCollapse: boolean;
  canMaximize: boolean;
  initialPlacement: 'dock' | 'float';
  nativeSurface: boolean;
  canPopout: boolean;
}

const LIMIT = { min: 80, max: 4096 };

/** 校验 + 默认值；errors 非空时宿主拒绝该声明（与 manifest 校验同一路径） */
export function resolveViewWindow(decl: unknown, displayMode?: string): { value: ResolvedViewWindow; errors: string[] } {
  const errors: string[] = [];
  const d = (decl && typeof decl === 'object' ? decl : {}) as Record<string, unknown>;
  if (decl !== undefined && (decl === null || typeof decl !== 'object')) errors.push('window 必须是对象');
  const size = (k: string, raw: unknown, dflt: Size | null): Size | null => {
    if (raw === undefined) return dflt;
    const r = raw as Record<string, unknown>;
    const ok = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= LIMIT.min && v <= LIMIT.max);
    if (!r || typeof r !== 'object' || !ok(r.width) || !ok(r.height)) {
      errors.push(`window.${k} 的宽高须在 ${LIMIT.min}–${LIMIT.max} 之间`);
      return dflt;
    }
    return { width: Math.round((r.width as number) ?? dflt?.width ?? 240), height: Math.round((r.height as number) ?? dflt?.height ?? 140) };
  };
  const bool = (k: string, dflt: boolean) => {
    const v = d[k];
    if (v === undefined) return dflt;
    if (typeof v !== 'boolean') {
      errors.push(`window.${k} 必须是布尔值`);
      return dflt;
    }
    return v;
  };
  const value: ResolvedViewWindow = {
    minSize: size('minSize', d.minSize, { width: 240, height: 140 })!,
    defaultFloatSize: size('defaultFloatSize', d.defaultFloatSize, null),
    canFloat: bool('canFloat', true),
    canDock: bool('canDock', true),
    canCollapse: bool('canCollapse', true),
    canMaximize: bool('canMaximize', true),
    initialPlacement: d.initialPlacement === 'float' ? 'float' : 'dock',
    nativeSurface: bool('nativeSurface', displayMode === 'in-app-web' || displayMode === 'external-managed'),
    canPopout: bool('canPopout', false),
  };
  if (d.initialPlacement !== undefined && d.initialPlacement !== 'dock' && d.initialPlacement !== 'float') errors.push("window.initialPlacement 只能是 'dock' 或 'float'");
  if (!value.canFloat && !value.canDock) errors.push('window.canFloat 与 window.canDock 不能同时为 false');
  if (value.initialPlacement === 'float' && !value.canFloat) errors.push("initialPlacement 为 'float' 时 canFloat 不能为 false");
  if (value.defaultFloatSize && (value.defaultFloatSize.width < value.minSize.width || value.defaultFloatSize.height < value.minSize.height)) errors.push('defaultFloatSize 不能小于 minSize');
  return { value, errors };
}
