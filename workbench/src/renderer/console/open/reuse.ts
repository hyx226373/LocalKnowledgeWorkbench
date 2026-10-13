/** tab 才复用已有面板。分屏和自由窗口必须再开一份，不能按 resourceId 吞掉。 */
export function shouldReusePanel(input: {
  openAs: string;
  resourceId: string;
  panels: ReadonlyArray<{ itemId: string; resourceId?: string }>;
}): { kind: 'focus'; itemId: string } | { kind: 'create' } {
  if (input.openAs === 'tab') {
    const hit = input.panels.find((panel) => panel.resourceId === input.resourceId);
    if (hit) return { kind: 'focus', itemId: hit.itemId };
  }
  return { kind: 'create' };
}
