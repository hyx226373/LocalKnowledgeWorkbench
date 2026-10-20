import { rebirthFewerBlocksDialog } from '../../shared/rebirth';
import { dialogs } from '../ui/dialogs';

type ImportHold = { id?: string; needsConfirm?: boolean; oldBlocks?: number; newBlocks?: number } | null;

/** 第一次不带确认。块数变少时用应用内对话框；取消不再发第二次。 */
export async function confirmFewerImport<T extends ImportHold>(
  run: (confirmFewer: boolean) => Promise<T>,
  confirm: (spec: { title: string; body: string; ok: string; cancel: string }) => Promise<boolean> = (spec) => dialogs.confirm(spec),
): Promise<T | null> {
  const first = await run(false);
  if (!first || first.needsConfirm !== true || typeof first.oldBlocks !== 'number' || typeof first.newBlocks !== 'number') return first;
  const ok = await confirm(rebirthFewerBlocksDialog(first.oldBlocks, first.newBlocks));
  if (!ok) return null;
  return run(true);
}

/** 选文件导入：第一次开文件框；块数变少时确认后用第一次读到的同一份内容重试（pickedText），不再开文件框。 */
export async function confirmPickedImport<T extends (NonNullable<ImportHold> & { pickedText?: string }) | null>(
  run: (picked: string | undefined) => Promise<T>,
  confirm: (spec: { title: string; body: string; ok: string; cancel: string }) => Promise<boolean> = (spec) => dialogs.confirm(spec),
): Promise<T | null> {
  const first = await run(undefined);
  if (!first || first.needsConfirm !== true || typeof first.oldBlocks !== 'number' || typeof first.newBlocks !== 'number') return first;
  if (typeof first.pickedText !== 'string') throw new Error('导入确认缺少已选文件内容，已停止，未写入。');
  const ok = await confirm(rebirthFewerBlocksDialog(first.oldBlocks, first.newBlocks));
  if (!ok) return null;
  return run(first.pickedText);
}
