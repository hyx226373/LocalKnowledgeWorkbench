/** 相对路径用 `/` 和 NFC。拒绝 `..`，避免改名写出根外。 */
export function normalizeRel(relPath) {
    if (typeof relPath !== 'string' || relPath.includes('\0')) {
        throw new Error('非法相对路径');
    }
    const unified = relPath.replace(/\\/g, '/').normalize('NFC');
    if (/^[a-zA-Z]:/.test(unified) || unified.startsWith('//') || unified.startsWith('/')) {
        throw new Error('非法相对路径');
    }
    const parts = unified.split('/').filter((part) => part.length > 0 && part !== '.');
    if (parts.some((part) => part === '..'))
        throw new Error('非法相对路径');
    return parts.join('/');
}
/** Windows 上 rel_key 小写；展示用的 rel_path 保留大小写。 */
export function relKeyOf(relPath) {
    const rel = normalizeRel(relPath);
    return process.platform === 'win32' ? rel.toLowerCase() : rel;
}
export function fileTitle(relPath) {
    const rel = normalizeRel(relPath);
    const base = rel.split('/').pop() ?? rel;
    return base.normalize('NFC');
}
//# sourceMappingURL=paths.js.map