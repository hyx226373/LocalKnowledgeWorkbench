/** 预览壳层图标。预览用 lucide 的改回 lucide-react@0.510；自绘 Mark / WinGlyph 保留。 */
import {
  ArrowRightToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Ellipsis,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  GripVertical,
  Link2,
  Minus,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Settings,
  Star,
  Sun,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

function lucideIcon(Icon: LucideIcon, fallback: number, stroke: number) {
  return function KbLucideIcon({ width, height, size, strokeWidth, ...rest }: LucideProps) {
    const raw = size ?? width ?? height;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN;
    const n = Number.isFinite(parsed) ? parsed : fallback;
    return <Icon {...rest} size={n} strokeWidth={strokeWidth ?? stroke} aria-hidden />;
  };
}

/** 顶栏抽屉：PanelLeft 18 / 1.5 */
export const PanelLeftIcon = lucideIcon(PanelLeft, 18, 1.5);
/** 侧栏展开时的收起图标：PanelLeftClose 18 / 1.5 */
export const PanelLeftCloseIcon = lucideIcon(PanelLeftClose, 18, 1.5);
/** 侧栏收起时的展开图标：PanelLeftOpen 18 / 1.5 */
export const PanelLeftOpenIcon = lucideIcon(PanelLeftOpen, 18, 1.5);
/** 搜索：Search 15 / 1.5 */
export const SearchIcon = lucideIcon(Search, 15, 1.5);
/** 设置：Settings 16 / 1.5 */
export const SettingsIcon = lucideIcon(Settings, 16, 1.5);
/** 外观：Sun 16 / 1.5 */
export const SunIcon = lucideIcon(Sun, 16, 1.5);
/** ChevronDown 14 / 1.5 */
export const ChevronDownIcon = lucideIcon(ChevronDown, 14, 1.5);
/** ChevronRight 14 / 1.5 */
export const ChevronRightIcon = lucideIcon(ChevronRight, 14, 1.5);
/** Plus 13 / 1.6 */
export const PlusIcon = lucideIcon(Plus, 13, 1.6);
/** Ellipsis 15 / 1.5 */
export const EllipsisIcon = lucideIcon(Ellipsis, 15, 1.5);
/** Globe 14 / 1.5 */
export const GlobeIcon = lucideIcon(Globe, 14, 1.5);
/** ExternalLink 14 / 1.5 */
export const ExternalLinkIcon = lucideIcon(ExternalLink, 14, 1.5);
/** FileText 14 / 1.5 */
export const FileTextIcon = lucideIcon(FileText, 14, 1.5);
/** 六卡选中角标：Check 11 / 2.4 */
export const CheckIcon = lucideIcon(Check, 11, 2.4);
/** Folder 15 / 1.5 */
export const FolderIcon = lucideIcon(Folder, 15, 1.5);
/** FolderOpen 15 / 1.5 */
export const FolderOpenIcon = lucideIcon(FolderOpen, 15, 1.5);
/** 引用移除：Minus 14 / 1.5 */
export const MinusIcon = lucideIcon(Minus, 14, 1.5);
/** 右侧分栏：PanelRight 14 / 1.5 */
export const OpenRightIcon = lucideIcon(PanelRight, 14, 1.5);

export function StarIcon({ filled = false, width, height, size, strokeWidth, ...rest }: LucideProps & { filled?: boolean }) {
  const raw = size ?? width ?? height;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN;
  const n = Number.isFinite(parsed) ? parsed : 14;
  return <Star {...rest} size={n} strokeWidth={strokeWidth ?? 1.5} fill={filled ? 'currentColor' : 'none'} aria-hidden />;
}

/** 目录树图标。文件夹开合跟预览 Folder / FolderOpen；文件是 FileText。颜色仍走主题类名。 */
export function TreeGlyph({
  kind,
  open = false,
  ext,
}: {
  kind: 'dir' | 'file' | 'root' | 'web';
  open?: boolean;
  ext?: string;
}) {
  const tone =
    kind === 'root' ? 'icon-root' : kind === 'dir' ? 'icon-dir' : kind === 'web' ? 'icon-file icon-web' : `icon-file icon-${ext || 'file'}`;
  const cls = `kb-file-ic ${tone}`;
  if (kind === 'web') return <GlobeIcon className={cls} />;
  if (kind === 'dir' || kind === 'root') return open ? <FolderOpenIcon className={cls} /> : <FolderIcon className={cls} />;
  return <FileTextIcon className={cls} />;
}

export function GripVerticalIcon(props: LucideProps) {
  return <GripVertical size={12} strokeWidth={1.5} aria-hidden {...props} />;
}

/** 工作区总览：16px 田字格，1.25px 线框，颜色走 currentColor。 */
export function OverviewMark(props: LucideProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <rect x="1.5" y="1.5" width="5.2" height="5.2" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="9.3" y="1.5" width="5.2" height="5.2" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="1.5" y="9.3" width="5.2" height="5.2" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="9.3" y="9.3" width="5.2" height="5.2" rx="1" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

/** 预览自绘窗口字形。restore 是正式版多出的还原态，沿用同一线宽。 */
export function WinGlyph({ kind }: { kind: 'min' | 'max' | 'close' | 'restore' }) {
  if (kind === 'min') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 8.5h10" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  if (kind === 'max') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  if (kind === 'restore') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.2" y="3.2" width="7.4" height="7.4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M3.4 6.2V12a1 1 0 0 0 1 1H10" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4 4 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** DocBar：Eye / Pencil / Columns2，14 / 1.5 */
export const ToolbarEyeIcon = lucideIcon(Eye, 14, 1.5);
export const ToolbarPencilIcon = lucideIcon(Pencil, 14, 1.5);
export const ToolbarColumns2Icon = lucideIcon(Columns2, 14, 1.5);

/** 连接 Agent：Link2 15 / 1.5 */
export const ConnectAgentIcon = lucideIcon(Link2, 15, 1.5);
/** 加入 agent：ArrowRightToLine 14 / 1.5 */
export const AgentAddIcon = lucideIcon(ArrowRightToLine, 14, 1.5);

/** 预览标签关闭是自绘叉，不是 lucide。 */
export function BubbleCloseIcon(props: LucideProps) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path d="M4 4l8 8M12 4 4 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
