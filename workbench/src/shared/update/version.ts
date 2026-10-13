/** 比较语义化版本。预发布号只在主次修订都相同时才降低优先级。 */

export interface ParsedVersion {
  core: number[];
  pre: string[] | null;
}

const CORE = /^(0|[1-9]\d*)$/;
const PRE = /^(0|[1-9]\d*|[0-9A-Za-z-]+)$/;

export function parseVersion(input: string): ParsedVersion {
  const raw = input.trim().replace(/^v/i, '');
  const noBuild = raw.split('+')[0] ?? '';
  if (!noBuild || /\s/.test(noBuild)) throw new Error(`版本号不合法：${input}`);
  const cut = noBuild.indexOf('-');
  const corePart = cut === -1 ? noBuild : noBuild.slice(0, cut);
  const prePart = cut === -1 ? null : noBuild.slice(cut + 1);
  const core = corePart.split('.').map((part) => {
    if (!CORE.test(part)) throw new Error(`版本号不合法：${input}`);
    return Number(part);
  });
  if (core.length === 0) throw new Error(`版本号不合法：${input}`);
  let pre: string[] | null = null;
  if (prePart !== null) {
    if (!prePart) throw new Error(`版本号不合法：${input}`);
    pre = prePart.split('.').map((part) => {
      if (!PRE.test(part)) throw new Error(`版本号不合法：${input}`);
      if (/^\d+$/.test(part) && !CORE.test(part)) throw new Error(`版本号不合法：${input}`);
      return part;
    });
  }
  return { core, pre };
}

function cmpPreId(a: string, b: string): number {
  const an = CORE.test(a);
  const bn = CORE.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 小于返回负数，等于 0，大于正数。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < n; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  const preA = pa.pre ?? [];
  const preB = pb.pre ?? [];
  const m = Math.max(preA.length, preB.length);
  for (let i = 0; i < m; i++) {
    if (preA[i] === undefined) return -1;
    if (preB[i] === undefined) return 1;
    const d = cmpPreId(preA[i], preB[i]);
    if (d !== 0) return d;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
