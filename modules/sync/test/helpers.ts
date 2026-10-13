import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export function makeTemp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export function startLagProbe(intervalMs = 20): { stop(): { maxDrift: number; atMs: number } } {
  const origin = performance.now();
  let maxDrift = 0;
  let atMs = 0;
  let last = origin;
  const timer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - intervalMs;
    if (drift > maxDrift) {
      maxDrift = drift;
      atMs = now - origin;
    }
    last = now;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return { maxDrift: Math.max(0, maxDrift), atMs };
    },
  };
}

export async function writePdf(file: string, text: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 72, y: 720, size: 16, font });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, Buffer.from(await doc.save()));
}
