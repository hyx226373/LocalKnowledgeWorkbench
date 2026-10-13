/**
 * Windows 上的 exe 校验（AppLaunchDeps.verifyExe 的缺省实现）。
 * - sha256：Node crypto 计算后与声明比较；
 * - publisher：PowerShell Get-AuthenticodeSignature（内部调用 WinVerifyTrust），要求 Status = Valid 且签名证书主题的 CN 与声明完全一致；
 * - 版本：(Get-Item).VersionInfo.FileVersionRaw（四段，取前三段与 versionRange 比较，由调用方完成）。
 * exe 路径通过环境变量传入 PowerShell，不拼进命令文本。
 * ⚠ 本文件只在 Linux 上做过解析逻辑单测（parseSignatureJson），尚未在 Windows 真机上运行（见 docs/06 §12.6）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { ProgramSpec } from '../../shared/adapter-sdk/types';
import type { ExeVerification } from './appLauncher';

const PS_SCRIPT =
  "$ErrorActionPreference='Stop';$p=$env:KB_VERIFY_EXE;$s=Get-AuthenticodeSignature -LiteralPath $p;$v=(Get-Item -LiteralPath $p).VersionInfo;" +
  "[pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;version=[string]$v.FileVersionRaw}|ConvertTo-Json -Compress";

/** 解析 PowerShell 输出（单测覆盖） */
export function parseSignatureJson(text: string): { status: string; cn: string | null; version: string | null } {
  const o = JSON.parse(text) as { status?: string; subject?: string; version?: string };
  const cn = /(?:^|,\s*)CN=("?)([^",]+)\1/.exec(o.subject ?? '')?.[2]?.trim() ?? null;
  const ver = /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(o.version ?? '') ? o.version! : null;
  return { status: String(o.status ?? ''), cn, version: ver };
}

export function verifyExeWindows(exePath: string, spec: ProgramSpec, platform: NodeJS.Platform = process.platform): Promise<ExeVerification> {
  if (platform !== 'win32') return Promise.resolve({ ok: false, reason: 'unsupported-os' });
  if (spec.verify.sha256?.length) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
    if (!spec.verify.sha256.includes(h)) return Promise.resolve({ ok: false, reason: 'hash-mismatch' });
    if (!spec.verify.publisher && !spec.verify.versionRange) return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    const ps = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], { env: { ...process.env, KB_VERIFY_EXE: exePath }, timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, reason: 'publisher-mismatch' });
      try {
        const r = parseSignatureJson(stdout.trim());
        if (spec.verify.publisher && !(r.status === 'Valid' && r.cn === spec.verify.publisher)) return resolve({ ok: false, reason: 'publisher-mismatch', ...(r.cn ? { publisher: r.cn } : {}), ...(r.version ? { version: r.version } : {}) });
        resolve({ ok: true, ...(r.cn ? { publisher: r.cn } : {}), ...(r.version ? { version: r.version } : {}) });
      } catch {
        resolve({ ok: false, reason: 'publisher-mismatch' });
      }
    });
  });
}
