/**
 * 策略参考实现（纯函数，无依赖，可在主进程 / 渲染进程 / 测试中运行）。
 * 核心实现宿主时应复用或逐条对齐这些规则；mock host 也只通过这些函数做判定，
 * 因此模板单测的结论与真实宿主一致（前提是核心采用同样的规则）。
 */
import {
  ADAPTER_API_VERSION,
  DEFAULT_MAX_STATE_BYTES,
  type AdapterContribution,
  type AdapterImplementation,
  type AdapterPluginManifest,
  type AppBackupDecl,
  type ArgTemplate,
  type DisplayMode,
  type LaunchFailure,
  type LaunchRequest,
  type NavigateResult,
  type NetPermission,
  type PermissionDecl,
  type PermissionGrant,
  type AdapterInstallSource,
  type PlaceholderActionId,
  type PlaceholderInfo,
  type PlaceholderKind,
  type PreservedLegacyState,
  type ProgramSpec,
  type RolloutPhase,
  type SourceKind,
  type StateEnvelope,
  type JsonValue,
} from './types.js';

export const DISPLAY_MODE_BY_KIND: Readonly<Record<SourceKind, DisplayMode>> = {
  file: 'in-app-reader',
  web: 'in-app-web',
  app: 'external-managed',
};

/** 某种来源最早开放的阶段 */
export const PHASE_BY_KIND: Readonly<Record<SourceKind, RolloutPhase>> = { file: 1, web: 2, app: 3 };

const ALLOWED_PERMS_BY_KIND: Readonly<Record<SourceKind, ReadonlyArray<PermissionDecl['kind']>>> = {
  file: ['fs.read', 'fileops.write'],
  web: ['net'],
  app: ['process.launch'],
};
const REQUIRED_PERM_BY_KIND: Readonly<Record<SourceKind, PermissionDecl['kind']>> = {
  file: 'fs.read',
  web: 'net',
  app: 'process.launch',
};

// ───────────── semver（只支持 engines 所需的子集） ─────────────

function parseVer(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  return 0;
}
export function isValidVersion(v: string): boolean {
  return parseVer(v) !== null;
}
/** 支持 '*'、'x.y.z'、'^x.y.z'、'~x.y.z'、'>=x.y.z'，以及用空格连接的多个条件（与） */
export function satisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  return range.trim().split(/\s+/).every((part) => {
    if (part === '*') return true;
    const m = /^(\^|~|>=|<|<=|>)?(.+)$/.exec(part);
    if (!m) return false;
    const r = parseVer(m[2]!);
    if (!r) return false;
    const c = cmp(v, r);
    switch (m[1]) {
      case '^':
        if (c < 0) return false;
        if (r[0] > 0) return v[0] === r[0];
        if (r[1] > 0) return v[0] === 0 && v[1] === r[1];
        return v[0] === 0 && v[1] === 0 && v[2] === r[2];
      case '~':
        return c >= 0 && v[0] === r[0] && v[1] === r[1];
      case '>=':
        return c >= 0;
      case '>':
        return c > 0;
      case '<':
        return c < 0;
      case '<=':
        return c <= 0;
      default:
        return c === 0;
    }
  });
}

// ───────────── 域名 / URL ─────────────

const LABEL = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)';
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/**
 * 校验 manifest 中的域名条目。返回错误说明或 null。
 * 允许：developer.mozilla.org、*.example.com（只匹配子域，不含裸域）。
 * 拒绝：'*'、'*.com' 这类过宽通配、IP、端口、协议、路径、大写、尾随点。
 * 注意：真实宿主还应用公共后缀列表（PSL）拒绝 '*.co.uk' / '*.github.io' 等。
 */
export function domainEntryError(entry: string): string | null {
  if (typeof entry !== 'string' || entry.length === 0) return '域名为空';
  if (entry !== entry.toLowerCase()) return `域名必须小写: ${entry}`;
  let host = entry;
  if (entry.startsWith('*.')) {
    host = entry.slice(2);
    if (host.split('.').length < 2) return `通配范围过宽: ${entry}`;
  }
  if (host.includes('*')) return `只允许最左侧的 "*." 通配: ${entry}`;
  if (!HOST_RE.test(host)) return `不是合法主机名（不得含协议/端口/路径/尾随点）: ${entry}`;
  if (/^[\d.]+$/.test(host)) return `不允许 IP 地址: ${entry}`;
  return null;
}

export function isHostAllowed(hostname: string, domains: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return domains.some((d) => {
    if (domainEntryError(d)) return false;
    if (d.startsWith('*.')) return h.endsWith(d.slice(1)) && h.length > d.length - 1;
    return h === d;
  });
}

/**
 * 顶层导航检查：只允许 https、默认端口、无 userinfo、主机在白名单。
 * 修订 10：opts.allowHttp（只给 mode 'ask-per-site' 的内置适配器用）额外允许 http，其余条件不变。
 */
export function checkNavigation(url: string, domains: readonly string[], opts?: { allowHttp?: boolean }): NavigateResult {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (u.protocol !== 'https:' && !(opts?.allowHttp && u.protocol === 'http:')) return { ok: false, reason: 'scheme-blocked' };
  if (u.username || u.password) return { ok: false, reason: 'invalid-url' };
  if (u.port !== '') return { ok: false, reason: 'domain-blocked' };
  if (!isHostAllowed(u.hostname, domains)) return { ok: false, reason: 'domain-blocked' };
  return { ok: true };
}

// ───────────── 修订 10：逐站授权（net.mode = 'ask-per-site'） ─────────────

export function isAskPerSite(p: Pick<NetPermission, 'mode'> | undefined | null): boolean {
  return p?.mode === 'ask-per-site';
}

/**
 * 可以写进 grantedHosts 的主机名：小写精确主机（URL 解析后的 hostname，IDN 为 punycode），至少两级，
 * 不得是通配、IP（v4 / v6）、带端口或尾随点。null = 合法。
 */
export function siteHostError(host: string): string | null {
  if (typeof host !== 'string' || !host) return '主机名为空';
  if (host.startsWith('[') || host.includes(':')) return `不允许 IP 地址或端口: ${host}`;
  if (host.includes('*')) return `逐站授权只能批准精确主机名，不能用通配: ${host}`;
  return domainEntryError(host);
}

/** 从地址取出可授权的主机名（只认 http/https；失败返回 null） */
export function siteHostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return siteHostError(u.hostname) ? null : u.hostname;
  } catch {
    return null;
  }
}

/**
 * net 权限当前允许的顶层主机：listed = domains；ask-per-site = domains ∪ 已批准的 grantedHosts（授权有效时）。
 * grant 由宿主按 grantDecision 判定后传入（失效/被拒的授权请传 undefined）。
 */
export function netAllowedHosts(p: NetPermission, grant?: Pick<PermissionGrant, 'decision' | 'grantedHosts'>): string[] {
  const out = new Set(p.domains ?? []);
  if (isAskPerSite(p) && grant?.decision === 'granted') for (const h of grant.grantedHosts ?? []) if (!siteHostError(h)) out.add(h);
  return [...out];
}

/** 子资源允许的主机：netAllowedHosts ∪ resourceDomains（D1 不变） */
export function netResourceHosts(p: NetPermission, grant?: Pick<PermissionGrant, 'decision' | 'grantedHosts'>): string[] {
  return [...new Set([...netAllowedHosts(p, grant), ...(p.resourceDomains ?? [])])];
}

/**
 * 逐站授权的导航判定：ok；或需要先询问用户（site-not-granted，附带主机名）；或无论如何都不允许（协议/IP/端口/userinfo）。
 * listed 模式等同 checkNavigation（不会返回 site-not-granted）。
 */
export function checkSiteNavigation(
  url: string,
  p: NetPermission,
  grant?: Pick<PermissionGrant, 'decision' | 'grantedHosts'>,
): NavigateResult | { ok: false; reason: 'site-not-granted'; host: string } {
  const allowHttp = isAskPerSite(p);
  const r = checkNavigation(url, netAllowedHosts(p, grant), { allowHttp });
  if (r.ok || r.reason !== 'domain-blocked' || !allowHttp) return r;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (u.port !== '' || siteHostError(u.hostname)) return { ok: false, reason: 'domain-blocked' };
  return { ok: false, reason: 'site-not-granted', host: u.hostname };
}

/** 把一个主机并入授权记录（返回新对象；主机不合法时抛错）。宿主写库前调用。 */
export function withGrantedHost(grant: PermissionGrant, host: string): PermissionGrant {
  const e = siteHostError(host);
  if (e) throw new Error(e);
  const hosts = new Set(grant.grantedHosts ?? []);
  hosts.add(host);
  return { ...grant, grantedHosts: [...hosts].sort() };
}

/** 从授权记录中去掉一个主机（插件管理“撤销此网站”） */
export function withoutGrantedHost(grant: PermissionGrant, host: string): PermissionGrant {
  return { ...grant, grantedHosts: (grant.grantedHosts ?? []).filter((h) => h !== host) };
}

/** 'https://developer.mozilla.org/*' 式模式匹配（只支持路径末尾 *） */
export function matchUrlPattern(url: string, pattern: string): boolean {
  let u: URL, p: URL;
  try {
    u = new URL(url);
    p = new URL(pattern.replace(/\*$/, ''));
  } catch {
    return false;
  }
  if (u.protocol !== p.protocol || u.host !== p.host) return false;
  return pattern.endsWith('*') ? u.pathname.startsWith(p.pathname) : u.pathname === p.pathname;
}

/** 保存网页状态前去掉 query（常含令牌/会话 id）与 userinfo，只保留 origin+path+hash。 */
export function sanitizeUrlForState(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.hash}`;
  } catch {
    return null;
  }
}

// ───────────── 进程：exe 与参数模板 ─────────────

const EXE_RE = /^(?:%(?:WINDIR|SystemRoot|ProgramFiles|ProgramFiles\(x86\)|LOCALAPPDATA)%|[A-Za-z]:)(?:\\[^\\/:*?"<>|\x00-\x1f]+)+\.exe$/i;

/**
 * 解释器 / 系统代理执行程序（LOLBins）：它们的参数本身就是“代码”或可再启动任意程序，固定参数模板也无法约束。
 * 适配器一律不得声明。真实宿主应在解析出最终 exe 后再按文件名与原始文件名（VERSIONINFO OriginalFilename）检查一次。
 */
export const FORBIDDEN_EXE_NAMES: readonly string[] = [
  'cmd.exe', 'powershell.exe', 'powershell_ise.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe', 'regsvr32.exe',
  'msiexec.exe', 'bash.exe', 'wsl.exe', 'wslhost.exe', 'conhost.exe', 'explorer.exe', 'schtasks.exe', 'at.exe', 'reg.exe', 'regedit.exe',
  'certutil.exe', 'bitsadmin.exe', 'forfiles.exe', 'msbuild.exe', 'installutil.exe', 'cmstp.exe', 'wmic.exe', 'hh.exe', 'control.exe',
  'runas.exe', 'sc.exe', 'node.exe', 'python.exe', 'pythonw.exe', 'java.exe', 'javaw.exe', 'electron.exe',
];

export function exeCandidateError(p: string): string | null {
  if (!EXE_RE.test(p)) return `exe 路径必须是绝对路径或环境变量令牌开头、以 .exe 结尾、只用反斜杠: ${p}`;
  const base = p.split('\\').pop()!.toLowerCase();
  if (FORBIDDEN_EXE_NAMES.includes(base)) return `禁止声明解释器/系统代理执行程序: ${base}`;
  if (p.split('\\').some((seg) => seg === '..' || seg === '.')) return `exe 路径不得含 . 或 .. 段: ${p}`;
  return null;
}

const SLOT_TOKEN_RE = /^([^{}]*)\{([A-Za-z][A-Za-z0-9_]*)\}$/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_ARG_CHARS = /["\x00-\x1f\x7f]/;

export function argTemplateErrors(t: ArgTemplate): string[] {
  const errs: string[] = [];
  const used = new Set<string>();
  for (const tok of t.args) {
    if (FORBIDDEN_ARG_CHARS.test(tok)) errs.push(`模板 ${t.id} 参数含双引号或控制字符: ${JSON.stringify(tok)}`);
    if (!tok.includes('{') && !tok.includes('}')) continue;
    const m = SLOT_TOKEN_RE.exec(tok);
    if (!m) {
      errs.push(`模板 ${t.id} 参数只能是字面量或 "前缀{slot}": ${tok}`);
      continue;
    }
    const slot = m[2]!;
    if (!t.slots?.[slot]) errs.push(`模板 ${t.id} 引用了未声明的槽位 ${slot}`);
    if (used.has(slot)) errs.push(`模板 ${t.id} 槽位 ${slot} 重复使用`);
    used.add(slot);
  }
  for (const [name, s] of Object.entries(t.slots ?? {})) {
    if (!used.has(name)) errs.push(`模板 ${t.id} 声明的槽位 ${name} 未被使用`);
    if (s.type === 'enum') for (const v of s.values) if (FORBIDDEN_ARG_CHARS.test(v) || v === '') errs.push(`模板 ${t.id} 枚举值非法: ${JSON.stringify(v)}`);
    if (s.type === 'int' && !(Number.isInteger(s.min) && Number.isInteger(s.max) && s.min <= s.max)) errs.push(`模板 ${t.id} 整数槽位 ${name} 范围非法`);
  }
  return errs;
}

export function programSpecErrors(p: ProgramSpec): string[] {
  const errs: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.programId)) errs.push(`非法 programId: ${p.programId}`);
  if (!p.exeCandidates?.length) errs.push(`程序 ${p.programId} 未声明 exeCandidates`);
  for (const c of p.exeCandidates ?? []) {
    const e = exeCandidateError(c);
    if (e) errs.push(e);
  }
  const v = p.verify ?? {};
  const hasCheck = (v.sha256?.length ?? 0) > 0 || !!v.publisher;
  if (!hasCheck && v.unverified !== true) errs.push(`程序 ${p.programId} 必须声明 sha256 或 publisher（或显式 unverified:true）`);
  for (const h of v.sha256 ?? []) if (!/^[a-f0-9]{64}$/.test(h)) errs.push(`程序 ${p.programId} sha256 格式错误`);
  const ids = new Set<string>();
  for (const t of p.argTemplates ?? []) {
    if (ids.has(t.id)) errs.push(`程序 ${p.programId} 模板 id 重复: ${t.id}`);
    ids.add(t.id);
    errs.push(...argTemplateErrors(t));
  }
  if (!p.argTemplates?.length) errs.push(`程序 ${p.programId} 至少需要一个参数模板（无参数也要声明 args: []）`);
  if (p.backup !== undefined) errs.push(...backupDeclErrors(p.backup).map((e) => `程序 ${p.programId} ${e}`));
  return errs;
}

// ───────────── 外部程序启动前备份（D6 收紧版） ─────────────

/**
 * 宿主备份的参考上限（核心 src/main/adapters/appBackup.ts 采用同样的值）。
 * - 每次启动最多备份 maxFilesPerLaunch 个文件、合计 maxBytesPerLaunch 字节（目标文件优先，附加文件按路径排序依次放入，放不下的跳过）；
 * - 目标文件本身超过 maxBytesPerLaunch → 不备份，启动前必须由用户确认“不备份也启动”，否则 backup-over-limit；
 * - 备份保留 retentionDays 天；备份区总量超过 maxStoreBytes 时从最旧的启动记录开始删除。
 */
export type AppBackupLimits = { maxFilesPerLaunch: number; maxBytesPerLaunch: number; retentionDays: number; maxStoreBytes: number };
export const DEFAULT_APP_BACKUP_LIMITS: Readonly<AppBackupLimits> = Object.freeze({
  maxFilesPerLaunch: 50,
  maxBytesPerLaunch: 64 * 1024 * 1024,
  retentionDays: 14,
  maxStoreBytes: 1024 * 1024 * 1024,
});

const MAX_BACKUP_PATTERNS = 8;

/** 附加备份 glob 的合法性（null = 合法） */
export function backupGlobError(pattern: string): string | null {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 200) return `备份模式必须是 1–200 字符的字符串: ${JSON.stringify(pattern)}`;
  if (/[\\\x00-\x1f:]/.test(pattern)) return `备份模式不得含反斜杠、冒号或控制字符: ${pattern}`;
  if (pattern.startsWith('/') || pattern.startsWith('~')) return `备份模式必须是相对路径（相对于目标文件所在文件夹）: ${pattern}`;
  const segs = pattern.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return `备份模式不得含空段、. 或 ..: ${pattern}`;
    if (seg.includes('**') && seg !== '**') return `** 必须独占一段: ${pattern}`;
    if (/[{}]/.test(seg.replaceAll('{stem}', ''))) return `备份模式只支持 {stem} 占位符: ${pattern}`;
    if (/[[\]]/.test(seg)) return `备份模式不支持 [...] 字符类: ${pattern}`;
  }
  if (segs[segs.length - 1] === '**') return `备份模式不能以 ** 结尾（会匹配整棵子目录）: ${pattern}`;
  // 至少要有一个字面量字母/数字（{stem} 也算）：拒绝 * / ** / *.* / **/* 这类“整个文件夹”
  const literal = pattern.replaceAll('{stem}', 'x').replace(/\*\*|[*?./]/g, '');
  if (!/[\p{L}\p{N}_]/u.test(literal)) return `备份模式过宽（只有通配符），请写出扩展名或文件名: ${pattern}`;
  return null;
}

export function backupDeclErrors(b: AppBackupDecl): string[] {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['backup 必须是对象'];
  const errs: string[] = [];
  for (const k of Object.keys(b)) if (k !== 'include') errs.push(`backup 含未知字段 ${k}`);
  if (b.include !== undefined) {
    if (!Array.isArray(b.include)) errs.push('backup.include 必须是数组');
    else {
      if (b.include.length > MAX_BACKUP_PATTERNS) errs.push(`backup.include 最多 ${MAX_BACKUP_PATTERNS} 条`);
      for (const g of b.include) {
        const e = backupGlobError(g);
        if (e) errs.push(e);
      }
    }
  }
  return errs;
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** 把附加备份 glob 编译成正则（匹配“相对于目标文件夹”的路径，/ 分隔）。非法模式返回 null。 */
export function backupGlobToRegExp(pattern: string, stem: string): RegExp | null {
  if (backupGlobError(pattern)) return null;
  const parts = pattern.split('/').map((seg) => {
    if (seg === '**') return '(?:[^/]+/)*';
    let out = '';
    const lit = seg.split('{stem}');
    lit.forEach((piece, i) => {
      if (i > 0) out += escapeRe(stem);
      out += piece.split('').map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : escapeRe(c))).join('');
    });
    return out + '/';
  });
  const body = parts.join('').replace(/\/$/, '');
  return new RegExp(`^${body}$`, 'u');
}

export interface BackupCandidate {
  /** 相对于已注册根的路径（/ 分隔） */
  relPath: string;
  size: number;
}
export interface AppBackupPlan {
  files: Array<BackupCandidate & { why: 'target' | 'declared' }>;
  skipped: Array<BackupCandidate & { why: 'over-file-limit' | 'over-size-limit' }>;
  totalBytes: number;
  /** 目标文件超过单次上限，未放入计划（需要用户确认“不备份也启动”） */
  targetOverLimit: boolean;
}

/**
 * 计算一次启动要备份的文件（纯函数；宿主负责列出候选文件、realpath/越界检查与实际复制）。
 * - 目标文件总是第一位（超过上限则 targetOverLimit = true，不放入计划）；
 * - 附加文件 = candidates 中位于目标文件夹之下、且匹配任一 include 模式的文件（不含目标本身），按路径排序；
 * - 超过文件数或字节上限的附加文件进入 skipped，不会因此阻止启动。
 */
export function planAppBackup(
  target: BackupCandidate,
  decl: AppBackupDecl | undefined,
  candidates: readonly BackupCandidate[],
  limits: Pick<AppBackupLimits, 'maxFilesPerLaunch' | 'maxBytesPerLaunch'> = DEFAULT_APP_BACKUP_LIMITS,
): AppBackupPlan {
  const plan: AppBackupPlan = { files: [], skipped: [], totalBytes: 0, targetOverLimit: false };
  if (target.size > limits.maxBytesPerLaunch) plan.targetOverLimit = true;
  else {
    plan.files.push({ ...target, why: 'target' });
    plan.totalBytes = target.size;
  }
  const slash = target.relPath.lastIndexOf('/');
  const dir = slash >= 0 ? target.relPath.slice(0, slash + 1) : '';
  const base = target.relPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const res = (decl?.include ?? []).map((g) => backupGlobToRegExp(g, stem)).filter((r): r is RegExp => !!r);
  if (!res.length) return plan;
  const extra = candidates
    .filter((c) => c.relPath !== target.relPath && c.relPath.startsWith(dir) && res.some((r) => r.test(c.relPath.slice(dir.length))))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  for (const c of extra) {
    if (plan.files.length >= limits.maxFilesPerLaunch) plan.skipped.push({ ...c, why: 'over-file-limit' });
    else if (plan.totalBytes + c.size > limits.maxBytesPerLaunch) plan.skipped.push({ ...c, why: 'over-size-limit' });
    else {
      plan.files.push({ ...c, why: 'declared' });
      plan.totalBytes += c.size;
    }
  }
  return plan;
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 * 1024 ? `${Math.round(n / (1024 * 1024 * 1024))} GB` : n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`;
}

/**
 * “外部改动哪些能恢复、哪些不能”的说明（授权对话框与插件管理的适配器详情通过 describePermission 显示全部条目，修订 9）。文字是规范的一部分，修改时同步更新 docs/适配器规范.md §6.4。
 */
export function describeAppRecovery(
  p: Pick<ProgramSpec, 'displayName' | 'backup'>,
  limits: AppBackupLimits = DEFAULT_APP_BACKUP_LIMITS,
): { scope: string; recoverable: string[]; notRecoverable: string[] } {
  const inc = p.backup?.include ?? [];
  const scope = `启动前备份：只备份要用 ${p.displayName} 打开的那个文件${inc.length ? `，以及同一文件夹下匹配 ${inc.join('、')} 的文件` : ''}；不会复制整个文件夹`;
  return {
    scope,
    recoverable: [
      '备份范围内文件在启动前的内容：程序退出后比较，被改动的文件记入操作记录，可撤销回启动前的内容；若工作台在程序退出前关闭，下次启动时先补记关闭期间的改动（标注“工作台关闭期间的外部修改”），程序仍在运行的，之后的改动等它退出后再记',
      `每次启动最多备份 ${limits.maxFilesPerLaunch} 个文件、共 ${fmtBytes(limits.maxBytesPerLaunch)}；目标文件超过上限时启动前会询问“不备份也启动？”（默认不启动）`,
      `启动前备份与记入操作记录的外部改动备份都保留 ${limits.retentionDays} 天，到期自动清理；过期后操作记录里那条显示“备份已过期，无法撤销”。备份区总量超过 ${fmtBytes(limits.maxStoreBytes)} 时先删除最旧的启动前备份`,
    ],
    notRecoverable: [
      '备份范围以外的文件：程序“另存为”或新建的文件、同文件夹的其他文件、已登记文件夹以外的任何文件',
      `${p.displayName} 自己的设置、会话、插件和最近文件列表`,
      '注册表与系统设置、网络操作（上传、发送、同步）、打印等程序产生的外部影响',
      `超过 ${limits.retentionDays} 天的外部改动（备份已清理）、比较之前就因总量上限被清理的备份、因上限未备份的文件`,
    ],
  };
}

export type ResolvedResource = { absPath: string; ext: string } | null;

/**
 * 把“模板 + 类型化槽位”展开成 argv（宿主进程代理在 spawn 前调用）。
 * - 参数以数组传给 CreateProcess（shell:false），绝不拼接命令行字符串、绝不经 cmd.exe。
 * - 资源槽位由核心按 resourceId 解析为根内绝对路径（resolveResource 内部已做 realpath/越界校验）。
 * - 拒绝：未声明模板/槽位、多余或缺失槽位、扩展名不符、含引号/控制字符、尾随反斜杠（会转义收尾引号）、
 *   以 '-' 或 '/' 开头的值（防被解释成开关）、超长命令行。
 */
export function expandArgs(
  spec: ProgramSpec,
  req: LaunchRequest,
  resolveResource: (resourceId: string) => ResolvedResource,
): { ok: true; argv: string[] } | { ok: false; reason: LaunchFailure; detail: string } {
  const t = spec.argTemplates.find((x) => x.id === req.templateId);
  if (!t) return { ok: false, reason: 'unknown-template', detail: req.templateId };
  const declared = t.slots ?? {};
  const given = req.slots ?? {};
  for (const k of Object.keys(given)) if (!(k in declared)) return { ok: false, reason: 'invalid-slot', detail: `未声明的槽位 ${k}` };
  const argv: string[] = [];
  for (const tok of t.args) {
    const m = SLOT_TOKEN_RE.exec(tok);
    if (!m) {
      argv.push(tok);
      continue;
    }
    const [, prefix, name] = m as unknown as [string, string, string];
    const slot = declared[name]!;
    const val = given[name];
    if (!val || val.type !== slot.type) return { ok: false, reason: 'invalid-slot', detail: `槽位 ${name} 缺失或类型不符` };
    let s: string;
    if (slot.type === 'resource' && val.type === 'resource') {
      const r = resolveResource(val.resourceId);
      if (!r) return { ok: false, reason: 'resource-missing', detail: val.resourceId };
      if (slot.extensions && !slot.extensions.includes(r.ext.toLowerCase())) return { ok: false, reason: 'resource-out-of-scope', detail: `扩展名 ${r.ext} 不在允许列表` };
      if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(r.absPath)) return { ok: false, reason: 'resource-out-of-scope', detail: '解析结果不是绝对路径' };
      s = r.absPath;
    } else if (slot.type === 'enum' && val.type === 'enum') {
      if (!slot.values.includes(val.value)) return { ok: false, reason: 'invalid-slot', detail: `枚举值不允许: ${val.value}` };
      s = val.value;
    } else if (slot.type === 'int' && val.type === 'int') {
      if (!Number.isInteger(val.value) || val.value < slot.min || val.value > slot.max) return { ok: false, reason: 'invalid-slot', detail: `整数越界: ${val.value}` };
      s = String(val.value);
    } else {
      return { ok: false, reason: 'invalid-slot', detail: name };
    }
    if (FORBIDDEN_ARG_CHARS.test(s)) return { ok: false, reason: 'invalid-slot', detail: `槽位 ${name} 含引号或控制字符` };
    if (s.endsWith('\\')) return { ok: false, reason: 'invalid-slot', detail: `槽位 ${name} 以反斜杠结尾` };
    if (prefix === '' && /^[-/]/.test(s)) return { ok: false, reason: 'invalid-slot', detail: `槽位 ${name} 以 - 或 / 开头` };
    argv.push(prefix + s);
  }
  if (argv.join(' ').length > 30000) return { ok: false, reason: 'invalid-slot', detail: '命令行过长' };
  return { ok: true, argv };
}

// ───────────── 状态 ─────────────

const SECRET_KEY_RE = /(pass(word|wd)?|secret|token|cookie|session|authorization|api[-_]?key|credential|private[-_]?key)/i;

/**
 * 保存前检查：可 JSON 序列化、≤ maxBytes、深度 ≤ 16、没有疑似秘密字段名、没有疑似文件正文（单个字符串 > 2048 字符）。
 * 不通过时宿主保留上一次的有效状态并记录警告（不弹窗）。
 */
export function checkStateForSave(data: unknown, maxBytes = DEFAULT_MAX_STATE_BYTES): { ok: true; json: string } | { ok: false; reason: string } {
  let json: string;
  try {
    json = JSON.stringify(data ?? null);
  } catch (e) {
    return { ok: false, reason: `不可序列化: ${(e as Error).message}` };
  }
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > Math.min(maxBytes, DEFAULT_MAX_STATE_BYTES)) return { ok: false, reason: `状态过大: ${bytes} 字节` };
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 16) return '嵌套过深';
    if (typeof v === 'string' && v.length > 2048) return '含超长字符串（疑似文件正文）';
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = walk(x, depth + 1);
        if (r) return r;
      }
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(k)) return `疑似秘密字段: ${k}`;
        const r = walk(x, depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  const r = walk(JSON.parse(json), 0);
  return r ? { ok: false, reason: r } : { ok: true, json };
}

export function isStateEnvelope(x: unknown): x is StateEnvelope<unknown> {
  return !!x && typeof x === 'object' && Number.isInteger((x as StateEnvelope).v) && (x as StateEnvelope).v >= 1 && 'data' in (x as object);
}

/**
 * 宿主恢复流程：信封非法 / 版本高于当前（降级安装）/ restoreState 返回 undefined 或抛错 → 默认状态 + reset=true。
 */
export function restoreFromEnvelope<S>(
  raw: unknown,
  impl: Pick<AdapterImplementation<S>, 'restoreState'>,
  currentVersion: number,
): { state: S | undefined; reset: boolean } {
  if (raw == null) return { state: undefined, reset: false };
  if (!isStateEnvelope(raw) || raw.v > currentVersion) return { state: undefined, reset: true };
  if (!impl.restoreState) return { state: raw.data as S, reset: false };
  try {
    const s = impl.restoreState(raw.data, raw.v);
    return s === undefined ? { state: undefined, reset: true } : { state: s, reset: false };
  } catch {
    return { state: undefined, reset: true };
  }
}

/**
 * 适配器侧辅助：迁移视图状态，**失败时不丢数据**。
 * - fromVersion === toVersion：原样返回（由适配器自己再校验形状）；
 * - 迁移链缺一步、某一步返回 undefined 或抛错 → 返回 makeDefault() 作为新状态，并把旧数据原样放进 preserved；
 *   适配器应把 preserved 存进自己的状态（如 `legacy` 字段）一起保存，并在面板里提示“旧版本视图状态无法迁移，已原样保留”。
 * - 若 data 本身已带有 legacy 字段（上次迁移失败保留下来的），适配器可在新版本里再用 migrateOrPreserve(legacy.data, legacy.v, …) 重试。
 */
export function migrateOrPreserve<S>(
  data: unknown,
  fromVersion: number,
  toVersion: number,
  steps: Record<number, (d: any) => unknown>,
  makeDefault: () => S,
): { state: S; preserved?: PreservedLegacyState } {
  if (fromVersion === toVersion) return { state: data as S };
  let error = fromVersion > toVersion ? `状态版本 v${fromVersion} 比当前适配器（v${toVersion}）新` : `缺少 v${fromVersion}→v${toVersion} 的迁移步骤`;
  if (fromVersion < toVersion) {
    try {
      const out = migrateChain(data, fromVersion, toVersion, steps);
      if (out !== undefined) return { state: out as S };
    } catch (e) {
      error = `迁移出错：${String((e as Error)?.message ?? e).slice(0, 200)}`;
    }
  }
  return { state: makeDefault(), preserved: { v: fromVersion, data: (data ?? null) as JsonValue, error } };
}

/** 适配器侧辅助：按 from→from+1 链式迁移。缺一步即返回 undefined。 */
export function migrateChain(data: unknown, from: number, to: number, steps: Record<number, (d: any) => unknown>): unknown {
  let d = data;
  for (let v = from; v < to; v++) {
    const f = steps[v];
    if (!f) return undefined;
    d = f(d);
    if (d === undefined) return undefined;
  }
  return d;
}

// ───────────── 权限说明 ─────────────

/** 授权对话框中的范围说明（每行一条）。验收检查：必须出现具体域名 / 程序路径 / 参数模板。 */
export function describePermission(p: PermissionDecl): string[] {
  switch (p.kind) {
    case 'fs.read':
      return [
        p.scope === 'ask-per-root' ? '读取你在下方勾选的已注册文件夹中的文件（只读）' : '读取所有已注册文件夹中的文件（只读）',
        ...(p.extensions?.length ? [`仅限扩展名：${p.extensions.join('、')}`] : []),
        '不能访问已注册文件夹之外的任何位置；看不到文件的绝对路径',
      ];
    case 'fileops.write':
      return [`通过工作台文件操作服务执行：${p.operations.join('、')}`, '每一批修改都会先显示计划，经你批准后执行，并可撤销'];
    case 'net':
      if (isAskPerSite(p))
        return [
          '逐站授权：首次打开每个网站（主机名）时都会先询问你，只加载你批准过的网站',
          ...(p.domains.length ? [`预先允许：${p.domains.join('、')}`] : []),
          ...(p.resourceDomains?.length ? [`页面资源另可加载自：${p.resourceDomains.join('、')}`] : []),
          '页面里的脚本、图片、样式、子框架、下载也只能来自已批准的网站；跳到未批准的网站会再次询问或被拦截',
          'http 网站同样需要批准，并标注“不安全连接”；不能访问 IP 地址、带端口的地址、本机文件和工作台数据',
          '已批准的网站可在插件管理中查看并逐个撤销',
        ];
      return [
        `仅限域名：${p.domains.join('、')}`,
        ...(p.resourceDomains?.length ? [`页面资源另可加载自：${p.resourceDomains.join('、')}`] : []),
        '其他网址会被拦截；网页不能访问本机文件和工作台数据',
      ];
    case 'process.launch':
      return p.programs.flatMap((g) => {
        const rec = describeAppRecovery(g);
        return [
          `仅可启动：${g.displayName}（${g.exeCandidates.join(' 或 ')}）`,
          g.verify.unverified ? '⚠ 该程序未声明签名或哈希校验' : `校验：${[g.verify.publisher ? `签名者 ${g.verify.publisher}` : '', g.verify.sha256?.length ? `SHA-256 ×${g.verify.sha256.length}` : ''].filter(Boolean).join('，')}`,
          ...g.argTemplates.map((t) => `参数模板「${t.label}」：${t.args.length ? t.args.join(' ') : '（无参数）'}`),
          rec.scope,
          // 修订 9：可恢复说明的全部条目逐行显示（授权框内容过长时由宿主让对话框滚动），不可恢复的全部条目合成一行
          ...rec.recoverable.map((r) => `可恢复：${r}`),
          `不可恢复：${rec.notRecoverable.join('；')}`,
        ];
      }).concat('不能启动其他程序，不能附加自定义参数');
  }
}

/** 稳定 JSON（键排序），用于权限指纹 */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** FNV-1a 32 位指纹（非安全用途：只用于检测“权限声明是否变化”） */
export function permissionDeclHash(p: PermissionDecl): string {
  const s = stableStringify(p);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ───────────── manifest 校验 ─────────────

/**
 * manifest 校验。opts.source（修订 10）：'builtin' = 宿主随包加载的内置适配器；缺省按第三方校验。
 * 只有内置适配器可以声明 net.mode = 'ask-per-site'。
 */
export function validateAdapterManifest(m: AdapterPluginManifest, adapterApiVersion = ADAPTER_API_VERSION, opts: { source?: AdapterInstallSource } = {}): string[] {
  const builtin = opts.source === 'builtin';
  const errs: string[] = [];
  if (!m || typeof m !== 'object') return ['manifest 缺失'];
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(m.id ?? '')) errs.push(`非法插件 id: ${m.id}`);
  if (!isValidVersion(m.version ?? '')) errs.push(`非法版本号: ${m.version}`);
  if (!m.engines?.workbench) errs.push('缺少 engines.workbench');
  if (!m.engines?.adapterApi) errs.push('缺少 engines.adapterApi');
  else if (!satisfies(adapterApiVersion, m.engines.adapterApi)) errs.push(`需要适配器 API ${m.engines.adapterApi}，当前为 ${adapterApiVersion}`);
  if (m.sandbox !== 'iframe') errs.push('v1 第三方插件必须声明 sandbox: "iframe"');
  errs.push(...storageDeclErrors(m.storage));
  const adapters = m.contributes?.adapters ?? [];
  if (!adapters.length) errs.push('contributes.adapters 为空');
  const ids = new Set<string>();
  for (const a of adapters) {
    const p = `适配器 ${a.id}:`;
    if (!/^[a-z0-9][a-z0-9.-]{1,127}$/.test(a.id ?? '')) errs.push(`${p} 非法 id`);
    if (ids.has(a.id)) errs.push(`${p} id 重复`);
    ids.add(a.id);
    if (a.sourceKinds?.length !== 1) {
      errs.push(`${p} v0.1 中 sourceKinds 必须恰好一项`);
      continue;
    }
    const kind = a.sourceKinds[0]!;
    if (!(kind in DISPLAY_MODE_BY_KIND)) {
      errs.push(`${p} 未知 sourceKind ${kind}`);
      continue;
    }
    if (a.displayMode !== DISPLAY_MODE_BY_KIND[kind]) errs.push(`${p} sourceKind=${kind} 的 displayMode 必须是 ${DISPLAY_MODE_BY_KIND[kind]}（诚实声明）`);
    if (!Number.isInteger(a.stateSchemaVersion) || a.stateSchemaVersion < 1) errs.push(`${p} stateSchemaVersion 必须是 ≥1 的整数`);
    for (const mg of a.stateMigrations ?? []) if (!(mg.from >= 1 && mg.from < mg.to && mg.to <= a.stateSchemaVersion)) errs.push(`${p} 迁移声明非法 ${mg.from}→${mg.to}`);
    if (a.maxStateBytes !== undefined && !(a.maxStateBytes > 0 && a.maxStateBytes <= DEFAULT_MAX_STATE_BYTES)) errs.push(`${p} maxStateBytes 必须在 1..${DEFAULT_MAX_STATE_BYTES}`);
    if ((a.match?.priority ?? 0) > 200) errs.push(`${p} priority 不得超过 200`);
    const permIds = new Set<string>();
    for (const perm of a.permissions ?? []) {
      if (permIds.has(perm.id)) errs.push(`${p} 权限 id 重复 ${perm.id}`);
      permIds.add(perm.id);
      if (!ALLOWED_PERMS_BY_KIND[kind].includes(perm.kind)) errs.push(`${p} ${kind} 适配器不能申请 ${perm.kind}`);
      if (!perm.reason) errs.push(`${p} 权限 ${perm.id} 缺少 reason`);
      if (perm.kind === 'net') {
        if (perm.mode !== undefined && perm.mode !== 'listed' && perm.mode !== 'ask-per-site') errs.push(`${p} 未知的 net.mode: ${String(perm.mode)}`);
        const perSite = isAskPerSite(perm);
        if (perSite && !builtin) errs.push(`${p} 只有随包内置的适配器可以声明 net.mode = "ask-per-site"（第三方插件必须列出域名）`);
        if (!Array.isArray(perm.domains)) errs.push(`${p} net.domains 必须是数组`);
        else if (!perm.domains.length && !perSite) errs.push(`${p} net 权限必须列出域名`);
        for (const d of [...(perm.domains ?? []), ...(perm.resourceDomains ?? [])]) {
          const e = domainEntryError(d);
          if (e) errs.push(`${p} ${e}`);
        }
      }
      if (perm.kind === 'process.launch') for (const g of perm.programs ?? []) errs.push(...programSpecErrors(g).map((e) => `${p} ${e}`));
    }
    const required = (a.permissions ?? []).find((x) => x.kind === REQUIRED_PERM_BY_KIND[kind] && !x.optional);
    if (!required) errs.push(`${p} ${kind} 适配器必须声明非可选的 ${REQUIRED_PERM_BY_KIND[kind]} 权限`);
    if (kind === 'file' && !a.match?.file) errs.push(`${p} 缺少 match.file`);
    if (kind === 'web') errs.push(...webErrors(a).map((e) => `${p} ${e}`));
    if (kind === 'app') errs.push(...appErrors(a).map((e) => `${p} ${e}`));
  }
  return errs;
}

function netDomains(a: AdapterContribution): string[] {
  return a.permissions.flatMap((x) => (x.kind === 'net' ? x.domains : []));
}

function webErrors(a: AdapterContribution): string[] {
  const errs: string[] = [];
  if (!a.web) return ['缺少 web 选项'];
  const net = a.permissions.find((x): x is NetPermission => x.kind === 'net' && !x.optional);
  if (isAskPerSite(net)) {
    // 逐站授权：首页只需是合法的 http(s) 地址（打开时同样逐站询问）；urlPatterns 可省略（宿主把它当作通用网页的兜底适配器）
    if (!siteHostOf(a.web.homeUrl) || checkNavigation(a.web.homeUrl, [siteHostOf(a.web.homeUrl)!], { allowHttp: true }).ok !== true) errs.push(`homeUrl 不是合法的 http(s) 地址: ${a.web.homeUrl}`);
    for (const pat of a.match?.web?.urlPatterns ?? []) if (!siteHostOf(pat.replace(/\*$/, ''))) errs.push(`match.web 模式不是合法的 http(s) 地址: ${pat}`);
    return errs;
  }
  const domains = netDomains(a);
  if (!checkNavigation(a.web.homeUrl, domains).ok) errs.push(`homeUrl 不在允许域名内: ${a.web.homeUrl}`);
  for (const pat of a.match?.web?.urlPatterns ?? []) {
    const r = checkNavigation(pat.replace(/\*$/, ''), domains);
    if (!r.ok) errs.push(`match.web 模式超出允许域名: ${pat}`);
  }
  if (!a.match?.web?.urlPatterns?.length) errs.push('缺少 match.web.urlPatterns');
  return errs;
}

function appErrors(a: AdapterContribution): string[] {
  const errs: string[] = [];
  if (!a.app) return ['缺少 app 选项'];
  const programs = a.permissions.flatMap((x) => (x.kind === 'process.launch' ? x.programs : []));
  const known = new Set(programs.map((g) => g.programId));
  for (const id of [...a.app.programIds, ...(a.match?.app?.programIds ?? [])]) if (!known.has(id)) errs.push(`程序 ${id} 未在 process.launch 权限中声明`);
  if (a.app.autoLaunchOnRestore !== false) errs.push('autoLaunchOnRestore 必须为 false');
  const emb = a.app.embedding;
  if (emb) {
    if (emb.enabledByDefault !== false) errs.push('embedding.enabledByDefault 必须为 false');
    if (!emb.verified?.length) errs.push('embedding 必须至少列出一条逐版本验证记录');
    for (const v of emb.verified ?? []) {
      if (!known.has(v.programId)) errs.push(`embedding 引用了未声明的程序 ${v.programId}`);
      if (!v.exeSha256?.length || !v.windowsBuilds?.length || !v.evidence) errs.push(`embedding ${v.programId} 缺少 exeSha256 / windowsBuilds / evidence`);
    }
  }
  return errs;
}

// ───────────── UI 文案 ─────────────

export function displayModeLabel(a: Pick<AdapterContribution, 'displayMode' | 'permissions'>): string {
  switch (a.displayMode) {
    case 'in-app-reader':
      return '内嵌渲染 · 应用内阅读（沙箱）';
    case 'in-app-web':
      if (a.permissions.some((p) => p.kind === 'net' && isAskPerSite(p))) return '内嵌网页 · 网页面板 · 逐站授权';
      return `内嵌网页 · 网页面板 · 仅限 ${a.permissions.flatMap((p) => (p.kind === 'net' ? p.domains : [])).join('、')}`;
    case 'external-managed':
      return '外部窗口启动 · 程序在自己的窗口中运行，本面板只显示状态占位（不是内嵌窗口）';
  }
}

/** 每种显示方式“如实”是什么：界面详情与文档用（短标签见 displayModeLabel） */
export const DISPLAY_MODE_FACTS: Readonly<Record<DisplayMode, { short: string; panelShows: string; notes: string }>> = Object.freeze({
  'in-app-reader': { short: '内嵌渲染', panelShows: '适配器在沙箱中渲染的内容（宿主绘制的界面节点）', notes: '插件不能直接操作页面 DOM，不能联网' },
  'in-app-web': { short: '内嵌网页', panelShows: '只能访问声明域名的网页面板', notes: '工作台菜单/对话框盖住网页时，网页暂时以截图占位；弹窗与嵌入式登录不可用' },
  'external-managed': { short: '外部窗口启动', panelShows: '状态占位：程序名、运行状态、启动/切换/关闭按钮与备份摘要', notes: '程序画面不在工作台内；窗口跟踪尽力而为，可能失败' },
});

const PH: Record<PlaceholderKind, { title: string; message: string; actions: PlaceholderActionId[] }> = {
  'adapter-missing': { title: '缺少适配器', message: '打开此项目需要适配器「{adapter}」，它未安装或已卸载。项目与状态已保留，安装后自动恢复。', actions: ['install-plugin', 'remove-item'] },
  'adapter-disabled': { title: '适配器已禁用', message: '插件「{plugin}」已禁用。启用后此面板恢复到上次的状态。', actions: ['enable-plugin', 'remove-item'] },
  'adapter-incompatible': { title: '适配器不兼容', message: '{detail}', actions: ['remove-item'] },
  'adapter-error': { title: '适配器出错', message: '适配器「{adapter}」运行出错：{detail}。其他面板不受影响。', actions: ['retry', 'remove-item'] },
  'phase-unavailable': { title: '此类项目尚未开放', message: '{detail}', actions: ['remove-item'] },
  'permission-denied': { title: '未授予权限', message: '此项目需要权限「{detail}」，你已拒绝或撤销。其余工作区不受影响。', actions: ['review-permission', 'remove-item'] },
  'resource-missing': { title: '文件不可用', message: '文件已被删除、移出已注册文件夹或所在磁盘未连接。', actions: ['retry', 'remove-item'] },
  'app-not-installed': { title: '未找到程序', message: '未在本机找到「{detail}」。安装后点击“重试”。', actions: ['retry', 'locate-program', 'remove-item'] },
  'app-verification-failed': { title: '程序校验失败', message: '「{detail}」的签名或哈希与适配器声明不符（可能已更新或被替换），为安全起见没有启动。', actions: ['retry', 'remove-item'] },
  'domain-blocked': { title: '已阻止访问', message: '{detail}', actions: ['go-home', 'open-in-system-browser'] },
  'network-offline': { title: '无法连接网络', message: '页面加载失败，请检查网络后重试。', actions: ['retry'] },
};

export function placeholderFor(kind: PlaceholderKind, ctx: { itemId: string; adapterId: string; plugin?: string; detail?: string; sourceKind?: SourceKind }): PlaceholderInfo {
  const t = PH[kind];
  const fill = (s: string) => s.replace('{adapter}', ctx.adapterId).replace('{plugin}', ctx.plugin ?? ctx.adapterId).replace('{detail}', ctx.detail ?? '');
  const actions = [...t.actions];
  // file 项目在适配器不可用时可以改用内置阅读器（不改写 item 的 adapterId / state）
  if (ctx.sourceKind === 'file' && ['adapter-missing', 'adapter-disabled', 'adapter-incompatible', 'adapter-error'].includes(kind)) actions.unshift('open-with-default');
  return { kind, itemId: ctx.itemId, adapterId: ctx.adapterId, title: t.title, message: fill(t.message), actions };
}

/** 帮助适配器从 JsonValue 中安全取对象 */
export function asRecord(v: unknown): Record<string, JsonValue> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : undefined;
}

// ───────────────────────── 插件存储：不可迁移的键（修订 5） ─────────────────────────

export const MAX_NON_MIGRATABLE_KEYS = 32;

/** manifest.storage 的校验错误（空数组 = 合法） */
export function storageDeclErrors(decl: unknown): string[] {
  if (decl === undefined) return [];
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) return ['storage 必须是对象'];
  const keys = (decl as { nonMigratableKeys?: unknown }).nonMigratableKeys;
  if (keys === undefined) return [];
  if (!Array.isArray(keys)) return ['storage.nonMigratableKeys 必须是字符串数组'];
  const errs: string[] = [];
  if (keys.length > MAX_NON_MIGRATABLE_KEYS) errs.push(`storage.nonMigratableKeys 最多 ${MAX_NON_MIGRATABLE_KEYS} 项`);
  for (const k of keys) {
    if (typeof k !== 'string' || k.length < 1 || k.length > 128) errs.push(`storage.nonMigratableKeys 非法项：${String(k)}`);
    else if (k.indexOf('*') !== -1 && k.indexOf('*') !== k.length - 1) errs.push(`storage.nonMigratableKeys「${k}」：* 只能出现在末尾`);
    else if (k === '*') errs.push('storage.nonMigratableKeys 不能是单独的 *（整个存储都不迁移时请说明原因并逐项列出）');
  }
  return errs;
}

/** 该存储键是否声明为不可迁移（完整键名或 `前缀*`） */
export function isNonMigratableKey(manifest: Pick<AdapterPluginManifest, 'storage'> | null | undefined, key: string): boolean {
  for (const k of manifest?.storage?.nonMigratableKeys ?? []) {
    if (typeof k !== 'string') continue;
    if (k.endsWith('*') ? key.startsWith(k.slice(0, -1)) : key === k) return true;
  }
  return false;
}
