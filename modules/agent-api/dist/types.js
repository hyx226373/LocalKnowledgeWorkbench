export const RPC_METHODS = [
    'roots.list',
    'fs.list',
    'fs.read',
    'search.query',
    'ops.preview',
    'ops.apply',
    'ops.restore',
    'ops.log',
    'plans.create',
    'plans.preview',
    'plans.approve',
    'plans.apply',
    'plans.get',
    'tokens.rotate',
];
/** 只读令牌不能调用这些方法。批准、执行和直接 restore 对任何令牌都另外拒绝。 */
export const WRITE_METHODS = new Set([
    'ops.apply',
    'ops.restore',
    'plans.approve',
    'plans.apply',
]);
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
export const HARD_MAX_READ_BYTES = 1024 * 1024;
export const TOKEN_FILE_NAME = 'agent-tokens.json';
//# sourceMappingURL=types.js.map