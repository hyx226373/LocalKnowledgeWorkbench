export declare function readBounded(absolutePath: string, maxBytes: number): Promise<{
    buf: Buffer;
    size: number;
    truncated: boolean;
}>;
export declare function fileSize(absolutePath: string): Promise<number>;
/** 截断时丢掉末尾不完整的 UTF-8 序列，避免把半个字符解码进结果。 */
export declare function decodeUtf8Bounded(buf: Buffer, truncated: boolean): string;
