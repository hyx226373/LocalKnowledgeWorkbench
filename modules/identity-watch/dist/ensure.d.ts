import { type Db } from './db.js';
/** 路径必须已存在。会按与 reconcile 相同的规则对齐整棵树，再返回该相对路径的 id。 */
export declare function ensureResource(db: Db, rootId: string, relPath: string): string;
//# sourceMappingURL=ensure.d.ts.map