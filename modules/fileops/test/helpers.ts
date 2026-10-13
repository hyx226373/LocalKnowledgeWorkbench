import path from "node:path";
import type { ResolveInsideRoot } from "../src/index.js";

/** 测试用词法校验。不查数据库，也不解析符号链接或 junction。 */
export function lexicalResolve(
  roots: Map<string, string>,
  ids?: ReadonlyMap<string, string>,
): ResolveInsideRoot {
  return (_db, rootId, relPath) => {
    const root = roots.get(rootId);
    if (!root) throw new Error(`unknown root ${rootId}`);
    if (typeof relPath !== "string" || relPath.length === 0) throw new Error("empty path");
    if (relPath.includes("\0")) throw new Error("nul");
    if (relPath.includes("\\")) throw new Error("backslash");
    if (relPath.includes(":") || /^[A-Za-z]:/.test(relPath)) throw new Error("drive");
    if (relPath.startsWith("/") || relPath.startsWith("\\\\")) throw new Error("absolute");
    const parts = relPath.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("traversal");
    }
    const abs = path.resolve(root, ...parts);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("outside root");
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    const absCmp = process.platform === "win32" ? abs.toLowerCase() : abs;
    const prefixCmp = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    if (!absCmp.startsWith(prefixCmp)) throw new Error("outside root");
    return {
      rootId,
      relPath,
      absPath: abs,
      resourceId: ids?.get(`${rootId}\0${relPath}`) ?? null,
    };
  };
}
