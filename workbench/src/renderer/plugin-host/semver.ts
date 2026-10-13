// 最小 semver：支持 x.y.z、^x.y.z、~x.y.z、>=a <b、* 与 || 组合（足够用于 engines 校验）
type V = [number, number, number];
function parse(v: string): V | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?\s*$/.exec(v);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function cmp(a: V, b: V) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function one(v: V, c: string): boolean {
  c = c.trim();
  if (c === '*' || c === '') return true;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  if (!m) return false;
  const t = parse(m[2]);
  if (!t) return false;
  const op = m[1] ?? '=';
  const r = cmp(v, t);
  switch (op) {
    case '=':
      return r === 0;
    case '>':
      return r > 0;
    case '>=':
      return r >= 0;
    case '<':
      return r < 0;
    case '<=':
      return r <= 0;
    case '~':
      return r >= 0 && v[0] === t[0] && v[1] === t[1];
    case '^':
      if (r < 0) return false;
      if (t[0] > 0) return v[0] === t[0];
      if (t[1] > 0) return v[0] === 0 && v[1] === t[1];
      return v[0] === 0 && v[1] === 0 && v[2] === t[2];
  }
  return false;
}
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split('||').some((part) => part.trim().split(/\s+/).every((c) => one(v, c)));
}
export function isValidVersion(v: string) {
  return parse(v) !== null;
}
