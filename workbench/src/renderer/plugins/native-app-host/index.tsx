/**
 * Builtin plugin: native-app-host (host-r1-plugin).
 * Registration shape mirrors other builtins; implementation is isolated from desktopPanel.
 */
import type { PluginModule } from '../../plugin-host/types';
import { HOST_API_VERSION } from '../../plugin-host/types';
import { NATIVE_APP_HOST_VIEW_TYPE } from '../../../shared/nativeAppHost';
import {
  NATIVE_APP_HOST_ADAPTER_ID,
  NATIVE_APP_HOST_COMMAND_META,
  NATIVE_APP_HOST_COMMANDS,
  NATIVE_APP_HOST_REF,
} from './constants';
import { NativeAppHostView } from './NativeAppHostView';
import { createHostPanel } from './openBridge';
import { runNativeAppHostAction } from './actions';
import {
  restoreNativeAppHostState,
  serializeNativeAppHostState,
  type NativeAppHostViewState,
} from './persistView';
import { getHostClient } from './hostClient';
import { reduceInteraction } from './interaction';

const plugin: PluginModule = {
  manifest: {
    id: 'builtin.native-app-host',
    name: '原生应用窗口托管',
    version: '0.1.0',
    engines: { workbench: `^${HOST_API_VERSION}` },
    description: 'host-r1：native-app-host 空白容器 / 选窗 / 交互态（与 desktopPanel 目录隔离）',
    activationEvents: ['onStartup', `onCommand:${NATIVE_APP_HOST_COMMANDS.createHostPanel}`],
    contributes: {
      adapters: [
        {
          id: NATIVE_APP_HOST_ADAPTER_ID,
          title: '原生应用托管',
          sourceKinds: ['app'],
          displayMode: 'external-managed',
          match: { appProfiles: [NATIVE_APP_HOST_REF] },
          stateSchemaVersion: 1,
        },
      ],
      commands: NATIVE_APP_HOST_COMMAND_META.map((c) => ({
        id: c.id,
        title: c.title,
        keybinding: c.keybinding,
      })),
    },
  },
  activate(api) {
    api.adapters.register<NativeAppHostViewState>({
      id: NATIVE_APP_HOST_ADAPTER_ID,
      title: '原生应用托管',
      sourceKinds: ['app'],
      displayMode: 'external-managed',
      stateSchemaVersion: 1,
      reportsReady: true,
      match: (t) =>
        t.sourceKind === 'app' &&
        (t.appProfileId === NATIVE_APP_HOST_REF || t.appProfileId === NATIVE_APP_HOST_VIEW_TYPE)
          ? 200
          : 0,
      component: NativeAppHostView,
      serializeState: (s) => serializeNativeAppHostState(s),
      restoreState: (raw) => restoreNativeAppHostState(raw),
    });

    for (const meta of NATIVE_APP_HOST_COMMAND_META) {
      api.commands.register({
        id: meta.id,
        title: meta.title,
        category: meta.category,
        keybinding: meta.keybinding,
        run: async (...args: unknown[]) => {
          switch (meta.id) {
            case NATIVE_APP_HOST_COMMANDS.createHostPanel:
              return createHostPanel();
            case NATIVE_APP_HOST_COMMANDS.enterInteraction:
            case NATIVE_APP_HOST_COMMANDS.exitInteraction:
              // View handles Escape via document keydown; command is a stable ActionId entry.
              return { ok: true, action: meta.id };
            default: {
              const ctxArg = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<
                string,
                unknown
              >;
              return runNativeAppHostAction(meta.id, {
                client: getHostClient(),
                panelId: typeof ctxArg.panelId === 'string' ? ctxArg.panelId : undefined,
                candidate: ctxArg.candidate as never,
                bindingId: typeof ctxArg.bindingId === 'string' ? ctxArg.bindingId : undefined,
                titleHint: typeof ctxArg.titleHint === 'string' ? ctxArg.titleHint : undefined,
              });
            }
          }
        },
      });
    }

    // Silence unused in activate tree (interaction helper used by view).
    void reduceInteraction;
  },
};

export default plugin;
export {
  NATIVE_APP_HOST_ADAPTER_ID,
  NATIVE_APP_HOST_REF,
  NATIVE_APP_HOST_VIEW_TYPE,
  NATIVE_APP_HOST_COMMANDS,
};
