export declare class ApiError extends Error {
    readonly httpStatus: number;
    readonly rpcCode: number;
    readonly data?: unknown;
    constructor(httpStatus: number, rpcCode: number, message: string, data?: unknown);
}
export declare class PathRejectedError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
