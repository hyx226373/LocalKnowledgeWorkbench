/** 应用内对话框（可主题化，替代 window.confirm/prompt）。React 外部也可调用：dialogs.confirm / dialogs.prompt */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';

export interface Field {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
}
type Req =
  | { kind: 'confirm'; title: string; body: string; ok: string; cancel: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; body?: string; fields: Field[]; ok: string; resolve: (v: Record<string, string> | null) => void }
  | { kind: 'alert'; title: string; body: string; resolve: () => void }
  /** 自定义对话框（授权、批量计划、卸载）：render 自己画内容并调用 done；点背景/Esc 等于 cancelValue */
  | { kind: 'custom'; title: string; render: (done: (v: unknown) => void) => React.ReactNode; cancelValue: unknown; testid?: string; wide?: boolean; seq: number; resolve: (v: unknown) => void };
let seq = 0;

let queue: Req[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const push = (r: Req) => {
  queue = [...queue, r];
  emit();
};
const pop = () => {
  queue = queue.slice(1);
  emit();
};

export const dialogs = {
  confirm(o: { title: string; body: string; ok?: string; cancel?: string; danger?: boolean }) {
    return new Promise<boolean>((resolve) => push({ kind: 'confirm', ok: '确定', cancel: '取消', ...o, resolve }));
  },
  prompt(o: { title: string; body?: string; fields: Field[]; ok?: string }) {
    return new Promise<Record<string, string> | null>((resolve) => push({ kind: 'prompt', ok: '确定', ...o, resolve }));
  },
  alert(o: { title: string; body: string }) {
    return new Promise<void>((resolve) => push({ kind: 'alert', ...o, resolve }));
  },
  custom<T>(o: { title: string; render: (done: (v: T) => void) => React.ReactNode; cancelValue: T; testid?: string; wide?: boolean }) {
    return new Promise<T>((resolve) => push({ kind: 'custom', ...o, seq: ++seq, render: o.render as (done: (v: unknown) => void) => React.ReactNode, resolve: resolve as (v: unknown) => void }));
  },
};

export function DialogHost() {
  const q = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => queue,
  );
  const cur = q[0];
  const [vals, setVals] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  useEffect(() => {
    if (cur?.kind === 'prompt') setVals(Object.fromEntries(cur.fields.map((f) => [f.name, f.value ?? ''])));
    setTimeout(() => firstRef.current?.focus(), 0);
  }, [cur]);
  if (!cur) return null;
  if (cur.kind === 'custom') {
    const finish = (v: unknown) => {
      cur.resolve(v);
      pop();
    };
    return (
      <div className="kb-dialog-backdrop" onMouseDown={() => finish(cur.cancelValue)}>
        <div
          className={'kb-dialog' + (cur.wide ? ' kb-dialog--wide' : '')}
          role="dialog"
          aria-modal="true"
          aria-label={cur.title}
          data-testid={cur.testid ?? 'custom-dialog'}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.key === 'Escape' && finish(cur.cancelValue)}
        >
          <div className="kb-dialog-title">{cur.title}</div>
          <React.Fragment key={cur.seq}>{cur.render(finish)}</React.Fragment>
        </div>
      </div>
    );
  }
  const done = (ok: boolean) => {
    if (cur.kind === 'confirm') cur.resolve(ok);
    else if (cur.kind === 'prompt') cur.resolve(ok ? vals : null);
    else cur.resolve();
    pop();
  };
  return (
    <div className="kb-dialog-backdrop" onMouseDown={() => done(false)}>
      <div
        className="kb-dialog"
        role="dialog"
        aria-modal="true"
        data-testid="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') done(false);
          if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) done(true);
        }}
      >
        <div className="kb-dialog-title">{cur.title}</div>
        <div className="kb-dialog-body">
          {cur.kind !== 'prompt' && cur.body}
          {cur.kind === 'prompt' && cur.body && <div>{cur.body}</div>}
          {cur.kind === 'prompt' &&
            cur.fields.map((f, i) => (
              <label key={f.name}>
                {f.label}
                <input
                  ref={i === 0 ? (el) => void (firstRef.current = el) : undefined}
                  className="kb-input"
                  data-testid={`dialog-field-${f.name}`}
                  placeholder={f.placeholder}
                  value={vals[f.name] ?? ''}
                  onChange={(e) => setVals((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              </label>
            ))}
        </div>
        <div className="kb-dialog-actions">
          {cur.kind !== 'alert' && (
            <button className="kb-button kb-button--secondary" data-testid="dialog-cancel" onClick={() => done(false)}>
              {cur.kind === 'confirm' ? cur.cancel : '取消'}
            </button>
          )}
          <button
            ref={cur.kind !== 'prompt' ? (el) => void (firstRef.current = el) : undefined}
            className={'kb-button' + (cur.kind === 'confirm' && cur.danger ? ' kb-button--danger' : '')}
            data-testid="dialog-ok"
            onClick={() => done(true)}
          >
            {cur.kind === 'alert' ? '知道了' : cur.ok}
          </button>
        </div>
      </div>
    </div>
  );
}
