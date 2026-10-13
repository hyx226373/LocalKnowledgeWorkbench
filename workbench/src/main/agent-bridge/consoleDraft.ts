import type { ConsoleDraftInput } from './types';

function yamlQuote(value: string): string {
  if (/^[\w\u4e00-\u9fff ._-]+$/.test(value) && !/^(true|false|null|yes|no)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/** F1 的 buildConsoleDraft 未合入时使用的最小模板。不执行打开。 */
export function defaultConsoleDraft(input: ConsoleDraftInput): string {
  const block = {
    kind: 'console' as const,
    version: 1,
    index: {
      titleNote: input.description ?? '',
      items: (input.items ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        note: item.note,
        ref: item.ref,
        order: item.order,
        openAs: item.openAs,
        targetPanel: item.targetPanel,
        includeInGroupOpen: item.includeInGroupOpen !== false,
      })),
    },
  };
  const titleLine = input.title.replace(/\r?\n/g, ' ');
  const body = input.description?.trim() ? `${input.description.trim()}\n\n` : '';
  const fence = '```kb-console v=1\n' + JSON.stringify(block, null, 2) + '\n```\n';
  return (
    `---\nkbConsole: 1\ntitle: ${yamlQuote(input.title)}\ndescription: ${yamlQuote(input.description ?? '')}\n---\n\n` +
    `# ${titleLine}\n\n${body}${fence}`
  );
}
