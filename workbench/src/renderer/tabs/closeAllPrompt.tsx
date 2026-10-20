import React from 'react';
import { dialogs } from '../ui/dialogs';
import type { CloseAllChoice } from './closeAllFiles';

/** 保存 / 不保存 / 取消。点背景或 Esc 走取消，一个标签都不关。 */
export function askCloseAllDirty(dirty: readonly { title: string }[]): Promise<CloseAllChoice> {
  const names = [...new Set(dirty.map((item) => item.title.trim()).filter(Boolean))];
  const listed = names.length ? names.join('、') : '这些文件';
  return dialogs.custom<CloseAllChoice>({
    title: '有未保存的修改',
    testid: 'close-all-dirty-dialog',
    cancelValue: 'cancel',
    render: (done) => (
      <>
        <div className="kb-dialog-body">{`${listed}还没保存。保存后关闭，或不保存就关闭。取消则一个都不关。`}</div>
        <div className="kb-dialog-actions">
          <button type="button" className="kb-button kb-button--secondary" data-testid="close-all-cancel" onClick={() => done('cancel')}>取消</button>
          <button type="button" className="kb-button kb-button--secondary" data-testid="close-all-discard" onClick={() => done('discard')}>不保存</button>
          <button type="button" className="kb-button" data-testid="close-all-save" onClick={() => done('save')}>保存</button>
        </div>
      </>
    ),
  });
}
