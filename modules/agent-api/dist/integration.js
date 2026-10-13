const state = {
    paths: 'local',
    search: 'local-fallback',
    fileops: 'local-fallback',
    detail: ['尚未调用 createWorkbench。'],
};
export function getIntegrationState() {
    return {
        paths: state.paths,
        search: state.search,
        fileops: state.fileops,
        detail: [...state.detail],
    };
}
export function setIntegrationState(next) {
    state.paths = next.paths;
    state.search = next.search;
    state.fileops = next.fileops;
    state.detail = [...next.detail];
}
//# sourceMappingURL=integration.js.map