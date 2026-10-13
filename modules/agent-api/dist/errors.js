export class ApiError extends Error {
    httpStatus;
    rpcCode;
    data;
    constructor(httpStatus, rpcCode, message, data) {
        super(message);
        this.name = 'ApiError';
        this.httpStatus = httpStatus;
        this.rpcCode = rpcCode;
        this.data = data;
    }
}
export class PathRejectedError extends Error {
    reason;
    constructor(reason) {
        super('path_rejected');
        this.name = 'PathRejectedError';
        this.reason = reason;
    }
}
//# sourceMappingURL=errors.js.map