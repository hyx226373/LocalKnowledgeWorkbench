export class AgentLiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentLiveError';
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeId(value: string, label: string): void {
  if (!ID_RE.test(value)) throw new AgentLiveError('bad_id', `${label} 不能作为目录名`);
}
