import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RootActionButton } from '../src/renderer/dir-view/RootActionButton';

it('根目录操作是键盘可达的 lucide 按钮，保留测试入口和中文提示', () => {
  const html = renderToStaticMarkup(createElement(RootActionButton, { kind: 'detach', title: '从工作区移除（不删除文件）', onActivate: () => {} }));
  expect(html).toContain('type="button"');
  expect(html).toContain('data-testid="root-detach"');
  expect(html).toContain('title="从工作区移除（不删除文件）"');
  expect(html).toContain('aria-label="从工作区移除（不删除文件）"');
  expect(html).toContain('lucide-folder-minus');
  expect(html).not.toContain('tabindex="-1"');
  expect(html).not.toContain('root-delete-disk');
  const sidebar = fs.readFileSync(path.join(process.cwd(), 'src/renderer/dir-view/Sidebar.tsx'), 'utf8');
  expect(sidebar).not.toContain('root-delete-disk');
  expect(sidebar).not.toContain('kind="delete-disk"');
});

it('鼠标和键盘不会冒泡触发根目录，点击只执行传入操作一次', () => {
  let calls = 0;
  let stopped = 0;
  const button = RootActionButton({ kind: 'detach', title: '移除', onActivate: () => calls++ });
  const event = { stopPropagation: () => stopped++ };
  button.props.onMouseDown(event);
  button.props.onKeyDown(event);
  expect(calls).toBe(0);
  button.props.onClick(event);
  expect(calls).toBe(1);
  expect(stopped).toBe(3);
});
