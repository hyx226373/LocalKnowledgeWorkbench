export declare function sha256(buf: Buffer): string;
export declare function isStrictUtf8Text(buf: Buffer): boolean;
/** 文本给统一 diff；否则说明大小和 sha256，不假装能按行比较。 */
export declare function describeWriteChange(relPath: string, before: Buffer, after: Buffer): string;
