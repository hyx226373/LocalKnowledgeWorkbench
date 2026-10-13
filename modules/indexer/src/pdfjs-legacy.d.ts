declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export function getDocument(src: unknown): { promise: Promise<unknown> };
  export const GlobalWorkerOptions: { workerSrc: string };
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
