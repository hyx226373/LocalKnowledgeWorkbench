import React from 'react';
import { dialogs } from '../ui/dialogs';
import { WILL_MOVE_FILE } from './copy';
import type { MoveDialogModel } from './flow';

export function askMove(model: MoveDialogModel): Promise<'move' | 'rename' | 'cancel'> {
  return dialogs.custom<'move' | 'rename' | 'cancel'>({
    title: model.title,
    testid: 'dnd-move-dialog',
    wide: true,
    cancelValue: 'cancel',
    render: (done) => (
      <div data-testid="dnd-move-body">
        <p data-testid="dnd-will-move">{WILL_MOVE_FILE}</p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{model.body}</p>
        <ul>
          {model.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>
          {model.count} 项{model.totalBytes ? `，约 ${model.totalBytes} 字节` : ''}
        </p>
        <div className="kb-dialog-actions">
          {model.nameClash ? (
            <button type="button" className="kb-button" data-testid="dnd-rename" onClick={() => done('rename')}>
              改名为 (2)
            </button>
          ) : (
            <button type="button" className="kb-button" data-testid="dnd-confirm-move" onClick={() => done('move')}>
              确认移动
            </button>
          )}
          <button type="button" className="kb-button kb-button--secondary" data-testid="dnd-cancel-move" onClick={() => done('cancel')}>
            取消
          </button>
        </div>
      </div>
    ),
  });
}
