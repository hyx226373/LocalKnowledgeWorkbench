import type { Database } from "better-sqlite3";

export type Actor = "ui" | `agent:${string}`;

export interface ResolvedInside {
  rootId: string;
  relPath: string;
  absPath: string;
  resourceId: string | null;
}

export type ResolveInsideRoot = (
  db: Database,
  rootId: string,
  relPath: string,
) => ResolvedInside | Promise<ResolvedInside>;

export type EnsureResource = (
  db: Database,
  rootId: string,
  relPath: string,
) => string | Promise<string>;

export interface LocationRef {
  rootId: string;
  relPath: string;
}

export type OnMoved = (
  resourceId: string,
  before: LocationRef,
  after: LocationRef,
) => void | Promise<void>;

export type FileOp =
  | { type: "create"; rootId: string; relPath: string; content: string | Uint8Array }
  | { type: "write"; rootId: string; relPath: string; content: string | Uint8Array }
  | { type: "move"; rootId: string; fromRelPath: string; toRelPath: string; toRootId?: string }
  | { type: "rename"; rootId: string; fromRelPath: string; toRelPath: string }
  | { type: "delete"; rootId: string; relPath: string };

export interface Conflict {
  code: "exists" | "missing" | "outside-root" | "conflict";
  relPath: string;
  message: string;
}

export interface PreviewResult {
  summary: string;
  affected: string[];
  conflicts: Conflict[];
}

export type OnConflict = "cancel" | "rename" | "overwrite";

export interface ApplyResult {
  opId: string;
  status: "ok" | "rejected";
}

export interface FileOpsDeps {
  db: Database;
  dataDir: string;
  resolveInsideRoot: ResolveInsideRoot;
  ensureResource: EnsureResource;
  onMoved: OnMoved;
  /** 删除暂存保留毫秒数，默认 30 天。 */
  retentionMs?: number;
}

export interface ExpiredStaging {
  id: string;
  relPath: string;
  storedPath: string;
  expiresAt: number;
}

export interface RecoveryItem {
  opId: string;
  status: string;
  error: string | null;
}

export interface FileOps {
  migrate(): void;
  preview(op: FileOp): Promise<PreviewResult>;
  apply(op: FileOp, opts: { actor: Actor; overwrite?: boolean }): Promise<ApplyResult>;
  previewRestore(opId: string): Promise<PreviewResult>;
  restore(opId: string, opts: { actor: Actor; onConflict: OnConflict }): Promise<ApplyResult>;
  listExpired(now?: number): Promise<ExpiredStaging[]>;
  purgeExpired(now?: number): Promise<void>;
  recoverIncomplete(): Promise<RecoveryItem[]>;
}
