export class ApiError extends Error {
  readonly httpStatus: number;
  readonly rpcCode: number;
  readonly data?: unknown;

  constructor(httpStatus: number, rpcCode: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

export class PathRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super('path_rejected');
    this.name = 'PathRejectedError';
    this.reason = reason;
  }
}
