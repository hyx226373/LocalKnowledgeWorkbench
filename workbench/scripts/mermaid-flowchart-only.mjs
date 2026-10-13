// 阅读器只画流程图。mermaid.core 会动态 import 每一种图；
// 这里把非流程图的图种换成空模块，布局器（dagre / elk）仍走原文件，离线加载。

const DIAGRAM_FILE = /(?:Diagram-|diagram-|definition-)/;

export function mermaidImportAction(importer, source) {
  if (!importer || !source) return 'ignore';
  const from = String(importer).replaceAll('\\', '/');
  if (!from.includes('/mermaid/dist/')) return 'ignore';
  const base = String(source).replaceAll('\\', '/').split('/').pop() || '';
  if (!base.endsWith('.mjs')) return 'ignore';
  if (base.startsWith('chunk-')) return 'keep';
  if (base.startsWith('flowDiagram-')) return 'keep';
  if (base.startsWith('elk-') || base.startsWith('dagre-') || base.startsWith('cose-bilkent-') || base.startsWith('swimlanes-')) return 'keep';
  if (DIAGRAM_FILE.test(base)) return 'stub';
  return 'keep';
}

export function mermaidFlowchartOnly() {
  return {
    name: 'mermaid-flowchart-only',
    enforce: 'pre',
    resolveId(source, importer) {
      if (mermaidImportAction(importer, source) !== 'stub') return null;
      const base = String(source).replaceAll('\\', '/').split('/').pop();
      return '\0kb-mermaid-stub:' + base;
    },
    load(id) {
      if (!id.startsWith('\0kb-mermaid-stub:')) return null;
      return [
        'export const diagram = {',
        '  db: {},',
        '  parser: { parse() { throw new Error("kb-pack: 这个图种没有打进安装包"); } },',
        '  renderer: { draw() {} },',
        '};',
        'export default diagram;',
      ].join('\n');
    },
  };
}
