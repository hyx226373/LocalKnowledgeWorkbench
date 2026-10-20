/**
 * ActionId wiring for native-app-host (01 §6).
 * propose* are cancellable; layoutAdjust only reflects layout.* (no host.setBounds).
 */
import type { NativeHostCandidate } from '../../../shared/nativeAppHost';
import { NATIVE_APP_HOST_COMMANDS } from './constants';
import { getHostClient, type NativeHostClient } from './hostClient';
import { layoutAdjustReflect, emptyLayoutUiState, type LayoutUiState } from './layoutEvents';
import { createHostPanel } from './openBridge';
import {
  defaultConfirm,
  proposeAttach,
  proposeDetach,
  type ConfirmFn,
  type ProposeAttachResult,
  type ProposeDetachResult,
} from './proposeAttach';

export interface ActionContext {
  client?: NativeHostClient;
  confirm?: ConfirmFn;
  panelId?: string;
  candidate?: NativeHostCandidate;
  bindingId?: string;
  titleHint?: string;
  layoutUi?: LayoutUiState;
}

export async function runNativeAppHostAction(
  actionId: string,
  ctx: ActionContext = {},
): Promise<unknown> {
  const client = ctx.client ?? getHostClient();
  const confirm = ctx.confirm ?? defaultConfirm;

  switch (actionId) {
    case NATIVE_APP_HOST_COMMANDS.createHostPanel:
      return { ok: true, itemId: await createHostPanel() };

    case NATIVE_APP_HOST_COMMANDS.listHosts:
      return client.list();

    case NATIVE_APP_HOST_COMMANDS.proposeAttach: {
      if (!ctx.candidate) {
        return { ok: false, code: 'NO_CANDIDATE', message: 'proposeAttach requires candidate' };
      }
      if (!ctx.panelId) {
        return { ok: false, code: 'NO_PANEL', message: 'proposeAttach requires panelId' };
      }
      const result: ProposeAttachResult = await proposeAttach({
        client,
        panelId: ctx.panelId,
        candidate: ctx.candidate,
        confirm,
      });
      return result;
    }

    case NATIVE_APP_HOST_COMMANDS.layoutAdjust:
      return layoutAdjustReflect(ctx.layoutUi ?? emptyLayoutUiState());

    case NATIVE_APP_HOST_COMMANDS.proposeDetach: {
      if (!ctx.bindingId) {
        return { ok: false, code: 'NO_BINDING', message: 'proposeDetach requires bindingId' };
      }
      const result: ProposeDetachResult = await proposeDetach({
        client,
        bindingId: ctx.bindingId,
        titleHint: ctx.titleHint,
        confirm,
      });
      return result;
    }

    default:
      return { ok: false, code: 'UNKNOWN_ACTION', message: `unknown action: ${actionId}` };
  }
}

export const ACTION_ID_LIST = [
  NATIVE_APP_HOST_COMMANDS.createHostPanel,
  NATIVE_APP_HOST_COMMANDS.listHosts,
  NATIVE_APP_HOST_COMMANDS.proposeAttach,
  NATIVE_APP_HOST_COMMANDS.layoutAdjust,
  NATIVE_APP_HOST_COMMANDS.proposeDetach,
] as const;
