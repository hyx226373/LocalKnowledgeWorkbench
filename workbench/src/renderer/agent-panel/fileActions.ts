/** 删对话前必须确认。取消则不调用删除。 */
export async function confirmedConversationDelete(input: {
  title: string;
  confirm: (spec: { title: string; body: string; ok?: string; cancel?: string; danger?: boolean }) => Promise<boolean>;
  remove: () => Promise<void>;
}): Promise<boolean> {
  const name = input.title.trim() || '此对话';
  const ok = await input.confirm({
    title: '删除对话',
    body: `把「${name}」移到回收站？`,
    ok: '移到回收站',
    danger: true,
  });
  if (!ok) return false;
  await input.remove();
  return true;
}
