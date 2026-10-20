import React, { useEffect, useState } from 'react';
import type { HiddenRootItem } from '../../shared/types';
import { dialogs } from '../ui/dialogs';

export function HiddenItemsPanel({
  load,
  restore,
  onClose,
}: {
  load: () => Promise<HiddenRootItem[]>;
  restore: (item: HiddenRootItem) => Promise<void>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<HiddenRootItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => {
    setErr(null);
    void Promise.resolve(load()).then(setItems, (error: unknown) => {
      setErr(error instanceof Error ? error.message : String(error));
    });
  };
  useEffect(() => {
    refresh();
    // 打开时读一次。恢复成功后再由按钮触发 refresh。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = (
    <div className="kb-dialog-actions">
      <button type="button" className="kb-button kb-button--secondary" onClick={onClose}>关闭</button>
    </div>
  );
  if (err) return <><div className="kb-error" data-testid="hidden-items-error">{err}</div>{close}</>;
  if (!items) return <><div data-testid="hidden-items">正在读取…</div>{close}</>;
  if (items.length === 0) return <><div className="kb-hidden-empty" data-testid="hidden-items">没有已隐藏的项。</div>{close}</>;
  return (
    <div data-testid="hidden-items">
      {items.map((item) => (
        <div key={`${item.rootId}\0${item.relPath}`} data-testid="hidden-item" data-root-id={item.rootId} data-relpath={item.relPath}>
          <span>{item.rootName}/{item.relPath}</span>
          <button
            type="button"
            data-testid="hidden-restore"
            onClick={() => {
              void Promise.resolve(restore(item)).then(refresh, (error: unknown) => {
                setErr(error instanceof Error ? error.message : String(error));
              });
            }}
          >
            恢复
          </button>
        </div>
      ))}
      <div className="kb-dialog-actions">
        <button type="button" className="kb-button kb-button--secondary" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

export function openHiddenItemsDialog(o: {
  load: () => Promise<HiddenRootItem[]>;
  restore: (item: HiddenRootItem) => Promise<void>;
}): Promise<null> {
  return dialogs.custom<null>({
    title: '已隐藏项',
    testid: 'hidden-items-dialog',
    cancelValue: null,
    render: (done) => <HiddenItemsPanel load={o.load} restore={o.restore} onClose={() => done(null)} />,
  });
}
