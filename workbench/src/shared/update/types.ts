/** 更新状态。进度只含已写入的字节和声明的总字节，没有百分比字段。 */

export interface ByteProgress {
  transferred: number;
  total: number;
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'rolling-back'
  | 'failed';

export interface UpdateAvailable {
  version: string;
  notes: string;
  fileName: string;
  sha512: string;
  size: number;
  blockMapSize: number | null;
  unsigned: true;
  /** 公开 https 下载链接；有新版时由检查更新写入。 */
  downloadUrl?: string | null;
}

export interface BackupListItem {
  id: string;
  createdAt: string;
  version: string;
}

export interface UpdateSnapshot {
  currentVersion: string;
  feed: string;
  autoCheck: boolean;
  rateLimitBytesPerSec: number | null;
  lastCheckAt: string | null;
  phase: UpdatePhase;
  available: UpdateAvailable | null;
  /** 只在下载安装包时有值。transferred 是已经写入磁盘的字节。简化更新后检查阶段恒为 null。 */
  progress: ByteProgress | null;
  error: string | null;
  info: string | null;
  backups: BackupListItem[];
  unsignedNotice: '未签名';
  installOnQuit: boolean;
  /** 简化更新：有可打开的 downloadUrl 即为 true（不再表示本机已下载安装包）。 */
  downloaded: boolean;
  layout?: 'nsis' | 'dirpack';
  /** 目录包 current.json 里的上一版。工作台只读，没有则为 null。 */
  previousVersion?: string | null;
}

export interface UpdateSettings {
  feed: string;
  autoCheck: boolean;
  rateLimitBytesPerSec: number | null;
}

export interface BackupRecord {
  id: string;
  createdAt: string;
  version: string;
  dir: string;
}

export interface PendingUpdate {
  fromVersion: string;
  toVersion: string;
  backupId: string;
  at: string;
}

export interface UpdateJournal {
  lastCheckAt?: string;
  installOnQuit?: boolean;
  pending?: PendingUpdate;
  backups: BackupRecord[];
  lastSelfCheck?: { ok: boolean; reason?: string; at: string; version: string };
  available?: {
    version: string;
    notes: string;
    fileName: string;
    sha512: string;
    size: number;
    blockMapSize: number | null;
    downloadedPath?: string;
    verified?: boolean;
    downloadUrl?: string;
  };
}

/** 人机界面调用。文件桥不能借这条 IPC 绕过批准。 */
export type UpdateApplyRequest =
  | { actionId: 'app.checkUpdate' }
  | { actionId: 'app.installUpdate'; when: 'now' | 'quit' }
  | { actionId: 'app.rollbackUpdate' };
