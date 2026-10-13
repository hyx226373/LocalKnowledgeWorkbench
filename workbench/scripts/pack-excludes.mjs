// electron-builder 文件排除。阅读器已经把流程图打进 out/，这些包不再进 asar。
// katex、better-sqlite3、pdfjs-dist、chokidar、readdirp 不在这里。

export const PACK_EXCLUDE_GLOBS = [
  '!node_modules/@kb/**/node_modules/**',
  '!node_modules/mermaid/**',
  '!node_modules/@mermaid-js/**',
  '!node_modules/@braintree/**',
  '!node_modules/@iconify/**',
  '!node_modules/@upsetjs/**',
  '!node_modules/chevrotain/**',
  '!node_modules/cytoscape/**',
  '!node_modules/cytoscape-cose-bilkent/**',
  '!node_modules/cytoscape-fcose/**',
  '!node_modules/d3/**',
  '!node_modules/d3-*/**',
  '!node_modules/dagre-d3-es/**',
  '!node_modules/dayjs/**',
  '!node_modules/dompurify/**',
  '!node_modules/elkjs/**',
  '!node_modules/es-toolkit/**',
  '!node_modules/khroma/**',
  '!node_modules/marked/**',
  '!node_modules/roughjs/**',
  '!node_modules/stylis/**',
  '!node_modules/ts-dedent/**',
  '!node_modules/uuid/**',
];
