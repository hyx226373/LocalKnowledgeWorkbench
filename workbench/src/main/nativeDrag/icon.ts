/**
 * startDrag 要同步拿到一张非空图标。getFileIcon 是异步的，这里不用。
 * 优先打包进应用的图标；createEmpty 在各平台都会被 startDrag 拒绝，所以失败时用 1x1 PNG。
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface DragImageFactory {
  createFromPath(filePath: string): { isEmpty(): boolean; getSize(): { width: number; height: number }; resize(opts: { width: number; height: number }): { isEmpty(): boolean } };
  createFromBuffer(buffer: Buffer): { isEmpty(): boolean };
  createFromDataURL(url: string): { isEmpty(): boolean };
}

export function nativeDragIcon<T extends { isEmpty(): boolean }>(images: DragImageFactory, candidates: readonly string[]): T {
  for (const file of candidates) {
    if (!file) continue;
    try {
      const image = images.createFromPath(file);
      if (!image.isEmpty()) {
        const size = image.getSize();
        if (size.width > 32 || size.height > 32) return image.resize({ width: 32, height: 32 }) as unknown as T;
        return image as unknown as T;
      }
    } catch {
      /* 下一张 */
    }
  }
  try {
    const fromBuffer = images.createFromBuffer(TINY_PNG);
    if (!fromBuffer.isEmpty()) return fromBuffer as T;
  } catch {
    /* 改用 data URL */
  }
  return images.createFromDataURL(`data:image/png;base64,${TINY_PNG.toString('base64')}`) as T;
}
