import React from 'react';

/** 数据还没到时的占位。不抢焦点。颜色走主题变量。 */
export function LoadingLabel({ testId = 'kb-loading' }: { testId?: string }) {
  return (
    <div className="kb-loading" data-testid={testId} role="status" aria-live="polite">
      <span className="kb-loading-spin" aria-hidden="true" />
      <span>加载中</span>
    </div>
  );
}
