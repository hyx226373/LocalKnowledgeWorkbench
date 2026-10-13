export const MAX_MATERIALS = 200;
export const ENTRY_LIST_CAP = 50;

export class MaterialLimitError extends Error {
  constructor() {
    super('MAX_MATERIALS');
    this.name = 'MaterialLimitError';
  }
}

export function isMaterialLimit(error: unknown): boolean {
  return error instanceof MaterialLimitError || (error instanceof Error && error.message === 'MAX_MATERIALS');
}
