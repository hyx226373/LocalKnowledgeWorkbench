const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/**
 * 与 fileops 的词法拒绝一致，这样预览里的虚拟路径和稍后 apply 用的是同一套相对路径。
 * 符号链接和 junction 不在这里展开。
 */
export function normalizeRelPath(input) {
    if (typeof input !== "string" || input.length === 0) {
        return bad("", "conflict", "路径为空");
    }
    if (input.includes("\0")) {
        return bad(input, "outside-root", "路径含有空字节");
    }
    const nfc = input.normalize("NFC");
    if (nfc.includes("\\")) {
        return bad(nfc, "outside-root", "相对路径不能包含反斜杠");
    }
    if (nfc.includes(":")) {
        return bad(nfc, "outside-root", "相对路径不能包含盘符或冒号");
    }
    if (nfc.startsWith("/")) {
        return bad(nfc, "outside-root", "拒绝绝对路径");
    }
    const parts = [];
    for (const segment of nfc.split("/")) {
        if (segment === "" || segment === "..") {
            return bad(nfc, "outside-root", "路径越出资料根");
        }
        if (segment === ".")
            continue;
        if (DEVICE_NAME.test(segment)) {
            return bad(nfc, "conflict", `拒绝 Windows 设备名 ${segment}`);
        }
        parts.push(segment);
    }
    if (parts.length === 0) {
        return bad(nfc, "conflict", "路径为空");
    }
    return { ok: true, relPath: parts.join("/") };
}
export function pathKey(relPath) {
    const normalized = relPath.normalize("NFC");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function bad(relPath, code, message) {
    return { ok: false, conflict: { code, relPath, message } };
}
//# sourceMappingURL=lex.js.map