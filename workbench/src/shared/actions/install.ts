import { registerAgentLivePackage } from './packages/agentLive';
import { registerAppUpdatePackage } from './packages/appUpdate';
import { registerBuiltinBridgePackage } from './packages/builtinBridge';
import { registerConsolePackage } from './packages/console';
import { registerSourcesPackage } from './packages/sources';
import { registerWebSitePackage } from './packages/webSite';

let installed = false;

/** 装上已合入的包。缩放不在这里引用。 */
export function installActionPackages(): void {
  if (installed) return;
  installed = true;
  registerBuiltinBridgePackage();
  registerAgentLivePackage();
  registerConsolePackage();
  registerSourcesPackage();
  registerWebSitePackage();
  registerAppUpdatePackage();
}
