import fs from 'node:fs';
import path from 'node:path';
import { bridgeCapabilityDetails } from '../../shared/actions/capabilityDetails';
import { installActionPackages } from '../../shared/actions/install';
import { AGENT_START_HERE, SCHEMA_FILES } from './embedded';
import { APP_COMMIT, CAPABILITIES, MODULES_COMMIT, REQUEST_STATES, type Manifest } from './types';

export function buildManifest(appCommit = APP_COMMIT, modulesCommit = MODULES_COMMIT): Manifest {
  installActionPackages();
  return {
    bridgeVersion: 1,
    appCommit,
    modulesCommit,
    capabilities: CAPABILITIES,
    capabilityDetails: bridgeCapabilityDetails(),
    requestStates: REQUEST_STATES,
    notes: '批准只在界面；文件内 approved 字段无效',
  };
}

/** 启动时保证目录树与模板。只覆盖说明、manifest、schemas，不动 requests/responses/drafts/snapshots。 */
export function initBridgeTree(root: string, manifest: Manifest): void {
  for (const name of ['schemas', 'snapshots', 'drafts', 'requests', 'responses']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'AGENT_START_HERE.md'), AGENT_START_HERE, 'utf8');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  for (const [name, json] of Object.entries(SCHEMA_FILES)) {
    const text = json.endsWith('\n') ? json : `${json}\n`;
    fs.writeFileSync(path.join(root, 'schemas', name), text, 'utf8');
  }
}
