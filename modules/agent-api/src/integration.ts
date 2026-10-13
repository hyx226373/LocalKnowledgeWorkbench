export interface IntegrationState {
  paths: 'local' | 'identity-watch';
  search: 'local-fallback' | 'indexer';
  fileops: 'local-fallback' | 'fileops';
  detail: string[];
}

const state: IntegrationState = {
  paths: 'local',
  search: 'local-fallback',
  fileops: 'local-fallback',
  detail: ['尚未调用 createWorkbench。'],
};

export function getIntegrationState(): IntegrationState {
  return {
    paths: state.paths,
    search: state.search,
    fileops: state.fileops,
    detail: [...state.detail],
  };
}

export function setIntegrationState(next: IntegrationState): void {
  state.paths = next.paths;
  state.search = next.search;
  state.fileops = next.fileops;
  state.detail = [...next.detail];
}
