import { open } from 'node:fs/promises';
export async function readBounded(absolutePath, maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
        throw new Error('maxBytes');
    }
    const fh = await open(absolutePath, 'r');
    try {
        const stat = await fh.stat();
        if (!stat.isFile())
            throw new Error('not_a_file');
        const size = stat.size;
        const toRead = Math.min(size, maxBytes);
        const buf = Buffer.alloc(toRead);
        let offset = 0;
        while (offset < toRead) {
            const { bytesRead } = await fh.read(buf, offset, toRead - offset, offset);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        return { buf: buf.subarray(0, offset), size, truncated: size > maxBytes };
    }
    finally {
        await fh.close();
    }
}
export async function fileSize(absolutePath) {
    const fh = await open(absolutePath, 'r');
    try {
        const stat = await fh.stat();
        return stat.size;
    }
    finally {
        await fh.close();
    }
}
/** 截断时丢掉末尾不完整的 UTF-8 序列，避免把半个字符解码进结果。 */
export function decodeUtf8Bounded(buf, truncated) {
    if (!truncated)
        return buf.toString('utf8');
    let end = buf.length;
    while (end > 0 && (buf[end - 1] & 0b1100_0000) === 0b1000_0000)
        end -= 1;
    if (end > 0) {
        const lead = buf[end - 1];
        if (lead >= 0b1100_0000) {
            const need = lead >= 0b1111_0000 ? 4 : lead >= 0b1110_0000 ? 3 : 2;
            if (buf.length - (end - 1) < need)
                end -= 1;
        }
    }
    return buf.subarray(0, end).toString('utf8');
}
//# sourceMappingURL=read-bounded.js.map