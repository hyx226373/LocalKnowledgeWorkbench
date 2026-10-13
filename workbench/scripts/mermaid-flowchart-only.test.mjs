import test from 'node:test';
import assert from 'node:assert/strict';
import { mermaidImportAction } from './mermaid-flowchart-only.mjs';

const core = 'D:/app/node_modules/mermaid/dist/mermaid.core.mjs';
const layout = 'D:/app/node_modules/mermaid/dist/chunks/mermaid.core/chunk-SVEVUXB4.mjs';

test('流程图和布局器保留，其它图种换成空模块', () => {
  assert.equal(mermaidImportAction(core, './chunks/mermaid.core/flowDiagram-OXPTDLAJ.mjs'), 'keep');
  assert.equal(mermaidImportAction(core, './chunks/mermaid.core/c4Diagram-CRA5TL53.mjs'), 'stub');
  assert.equal(mermaidImportAction(core, './chunks/mermaid.core/sequenceDiagram-ZO4K6R2Y.mjs'), 'stub');
  assert.equal(mermaidImportAction(core, './chunks/mermaid.core/diagram-2UJZ2QOL.mjs'), 'stub');
  assert.equal(mermaidImportAction(core, './chunks/mermaid.core/timeline-definition-YOQAKGHF.mjs'), 'stub');
  assert.equal(mermaidImportAction(core, './chunks/mermaid.core/chunk-VPRB5NB3.mjs'), 'keep');
  assert.equal(mermaidImportAction(layout, './dagre-W4DXFKR2.mjs'), 'keep');
  assert.equal(mermaidImportAction(layout, './elk-IJKZMXRS.mjs'), 'keep');
  assert.equal(mermaidImportAction(layout, './cose-bilkent-JH36ORCC.mjs'), 'keep');
  assert.equal(mermaidImportAction(layout, './swimlanes-N4OXWK64.mjs'), 'keep');
  assert.equal(mermaidImportAction('D:/app/src/load-mermaid.ts', 'mermaid'), 'ignore');
});
