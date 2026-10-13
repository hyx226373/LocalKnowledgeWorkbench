export class PathEscapeError extends Error {
  readonly code = 'PATH_ESCAPE';

  constructor(message = 'path escapes root') {
    super(message);
    this.name = 'PathEscapeError';
  }
}

export class ReconcileCancelledError extends Error {
  readonly code = 'RECONCILE_CANCELLED';

  constructor() {
    super('reconcile cancelled');
    this.name = 'ReconcileCancelledError';
  }
}
