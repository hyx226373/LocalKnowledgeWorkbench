// 冷启动计时（docs/07 §4）：尽早标记脚本开始执行；首次绘制由 PerformanceObserver 报告
window.kb.startupMark('modules-evaluated'); // 打包后的入口模块（含 React、dockview、App）已执行完
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.kb.startupMark(e.name, performance.timeOrigin + e.startTime);
  }).observe({ type: 'paint', buffered: true });
} catch {
  /* 不支持时忽略 */
}
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.kb.noteLongTask?.(e.duration);
  }).observe({ type: 'longtask', buffered: true });
} catch {
  /* 不支持长任务时忽略 */
}
import React from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
requestAnimationFrame(() => window.kb.startupMark('first-frame'));
