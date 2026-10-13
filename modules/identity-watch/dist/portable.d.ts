import { type Db } from './db.js';
import type { PortableBundle } from './types.js';
export declare function exportPortable(db: Db, rootId: string): PortableBundle;
export declare function importPortable(db: Db, bundle: PortableBundle, options?: {
    localPath?: string;
}): string;
export declare function newResourceId(): string;
//# sourceMappingURL=portable.d.ts.map