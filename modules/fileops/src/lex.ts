import path from "node:path";
import type { Conflict } from "./types.js";

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type LexOk = { ok: true; relPath: string };
export type LexBad = { ok: false; conflict: Conflict };

/** 只做词法检查。符号链接和 junction 由调用方的 resolveInsideRoot 负责。 */
export function normalizeRelPath(input: string): LexOk | LexBad {
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
  const parts: string[] = [];
  for (const segment of nfc.split("/")) {
    if (segment === "" || segment === "..") {
      return bad(nfc, "outside-root", "路径越出资料根");
    }
    if (segment === ".") continue;
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

function bad(relPath: string, code: Conflict["code"], message: string): LexBad {
  return { ok: false, conflict: { code, relPath, message } };
}

/** parent 本身不算在内部。Windows 下不区分大小写。 */
export function isWithinDir(parent: string, target: string): boolean {
  if (!parent || !target) return false;
  const base = path.resolve(parent);
  const child = path.resolve(target);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (process.platform === "win32") {
    return child.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return child.startsWith(prefix);
}
