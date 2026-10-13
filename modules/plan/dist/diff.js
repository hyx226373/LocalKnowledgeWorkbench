import { createHash } from "node:crypto";
export function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}
export function isStrictUtf8Text(buf) {
    if (buf.includes(0))
        return false;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return true;
    }
    catch {
        return false;
    }
}
/** 文本给统一 diff；否则说明大小和 sha256，不假装能按行比较。 */
export function describeWriteChange(relPath, before, after) {
    if (isStrictUtf8Text(before) && isStrictUtf8Text(after)) {
        return unifiedDiff(relPath, before.toString("utf8"), after.toString("utf8"));
    }
    return [
        "二进制文件，显示大小和哈希变化",
        `前大小=${before.length} sha256=${sha256(before)}`,
        `后大小=${after.length} sha256=${sha256(after)}`,
    ].join("\n");
}
function splitLines(text) {
    if (text.length === 0)
        return [];
    const parts = text.split("\n");
    if (text.endsWith("\n"))
        parts.pop();
    return parts;
}
function unifiedDiff(relPath, before, after) {
    const oldLines = splitLines(before);
    const newLines = splitLines(after);
    const edits = diffLines(oldLines, newLines);
    const oldStart = oldLines.length === 0 ? 0 : 1;
    const newStart = newLines.length === 0 ? 0 : 1;
    const lines = [
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ];
    for (const edit of edits) {
        const prefix = edit.kind === "eq" ? " " : edit.kind === "del" ? "-" : "+";
        lines.push(`${prefix}${edit.line}`);
    }
    return `${lines.join("\n")}\n`;
}
function diffLines(before, after) {
    const n = before.length;
    const m = after.length;
    const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
        const row = dp[i];
        const next = dp[i + 1];
        if (!row || !next)
            continue;
        for (let j = m - 1; j >= 0; j -= 1) {
            if (before[i] === after[j])
                row[j] = (next[j + 1] ?? 0) + 1;
            else
                row[j] = Math.max(next[j] ?? 0, row[j + 1] ?? 0);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const left = before[i];
        const right = after[j];
        if (left === undefined || right === undefined)
            break;
        if (left === right) {
            out.push({ kind: "eq", line: left });
            i += 1;
            j += 1;
            continue;
        }
        if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
            out.push({ kind: "del", line: left });
            i += 1;
        }
        else {
            out.push({ kind: "add", line: right });
            j += 1;
        }
    }
    while (i < n) {
        const line = before[i];
        if (line !== undefined)
            out.push({ kind: "del", line });
        i += 1;
    }
    while (j < m) {
        const line = after[j];
        if (line !== undefined)
            out.push({ kind: "add", line });
        j += 1;
    }
    return out;
}
//# sourceMappingURL=diff.js.map