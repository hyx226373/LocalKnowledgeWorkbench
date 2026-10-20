// pdfjs-dist 6 的 legacy worker 构建没有随包类型。只取同线程 fake worker 要用的导出。
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: {
    setup(handler: object, port: object): void;
    initializeFromPort(port: object): void;
  };
}
