export class PathEscapeError extends Error {
    code = 'PATH_ESCAPE';
    constructor(message = 'path escapes root') {
        super(message);
        this.name = 'PathEscapeError';
    }
}
export class ReconcileCancelledError extends Error {
    code = 'RECONCILE_CANCELLED';
    constructor() {
        super('reconcile cancelled');
        this.name = 'ReconcileCancelledError';
    }
}
//# sourceMappingURL=errors.js.map