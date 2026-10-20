// electron-builder 文件排除。阅读器已经把流程图打进 out/，这些包不再进 asar。
// katex、better-sqlite3、pdfjs-dist、chokidar、readdirp 不在这里。
//
// 版式 Worker（out/renderer/assets/format.worker-*.js）里已经有 exceljs 浏览器构建、
// dayjs、fflate、fast-xml-parser、buffer、cfb、word-extractor、xlsx、ppt，以及 pdf.js legacy。
// 这些不要再写成 node_modules 的正向条目。dayjs 的排除保留：生产 Worker 和主进程都不
// require node_modules/dayjs。pdfjs-dist 的正向条目是原来就有的，版式解析用的是 Worker 里的那一份。

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
