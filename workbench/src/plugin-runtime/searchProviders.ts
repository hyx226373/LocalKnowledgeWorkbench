/**
 * 沙箱运行时里的搜索提供者注册。不碰 DOM，测试可直接导入。
 * 未在 manifest contributes.searchProviders 里声明的 id 拒绝，与 adapters.register 同一规则。
 */
import type { Disposable } from '../shared/adapter-sdk/types';
import type { SearchProviderRegistration } from '../shared/searchProvider';

export function registerDeclaredSearchProvider(
  declared: readonly { id: string }[] | undefined,
  reg: SearchProviderRegistration,
  store: Map<string, SearchProviderRegistration>,
): Disposable {
  if (!declared?.some((d) => d.id === reg.id)) {
    throw new Error(`搜索提供者 ${reg.id} 未在 manifest 中声明`);
  }
  store.set(reg.id, reg);
  return {
    dispose() {
      if (store.get(reg.id) === reg) store.delete(reg.id);
    },
  };
}
