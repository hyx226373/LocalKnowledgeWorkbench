import type { Db } from './db.js';
import type { ResolvedInside } from './types.js';
/** 词法检查之后再 realpath。真实路径必须仍在该根目录内，否则抛 PathEscapeError。 */
export declare function resolveInsideRoot(db: Db, rootId: string, relPath: string): ResolvedInside;
//# sourceMappingURL=resolve.d.ts.map