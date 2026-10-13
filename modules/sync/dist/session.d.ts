import type { MessagePort } from 'node:worker_threads';
import { type ResourceChange } from '@kb/identity-watch';
type Op = 'upsert' | 'delete' | 'relocate';
interface Queued {
    resourceId: string;
    op: Op;
    relPath: string | null;
}
export declare function attachSession(port: MessagePort): void;
/** delete 压过还没执行的 modify。纯改名不升级成 upsert。 */
export declare function mergeQueued(prev: Queued | undefined, event: ResourceChange): Queued | undefined;
export {};
