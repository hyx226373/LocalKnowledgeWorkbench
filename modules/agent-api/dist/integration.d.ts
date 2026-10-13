export interface IntegrationState {
    paths: 'local' | 'identity-watch';
    search: 'local-fallback' | 'indexer';
    fileops: 'local-fallback' | 'fileops';
    detail: string[];
}
export declare function getIntegrationState(): IntegrationState;
export declare function setIntegrationState(next: IntegrationState): void;
