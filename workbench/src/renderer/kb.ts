import type { KbApi } from '../shared/types';
declare global {
  interface Window {
    kb: KbApi;
  }
}
export const kb: KbApi = window.kb;
