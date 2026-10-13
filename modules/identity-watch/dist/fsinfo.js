import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ReconcileCancelledError } from "./errors.js";
const cache = new Map();
/**
 * Node 24 在本机上 `fs.statfsSync().type` 对 NTFS 也是 0，不能用来区分文件系统。
 * 因此查 Win32_LogicalDisk 的 FileSystem 和 DriveType。
 * 只有本地固定盘（DriveType=3）且文件系统名为 NTFS 时，才把 stat.ino 当作稳定文件索引。
 */
export function detectFileSystem(absPath) {
    if (process.platform !== 'win32') {
        return { name: 'posix', fileIdReliable: true };
    }
    const root = path.win32.parse(path.resolve(absPath)).root;
    if (!/^[A-Za-z]:\\$/.test(root)) {
        return { name: 'unknown', fileIdReliable: false };
    }
    const letter = root.slice(0, 2).toUpperCase();
    const hit = cache.get(letter);
    if (hit)
        return hit;
    const probed = probeDrive(letter);
    cache.set(letter, probed);
    return probed;
}
function probeDrive(letter) {
    const fromStatfs = statfsHint(letter);
    if (fromStatfs)
        return fromStatfs;
    const cim = queryCim(letter) ?? queryWmic(letter);
    if (!cim)
        return { name: 'unknown', fileIdReliable: false };
    return {
        name: cim.name,
        fileIdReliable: cim.name === 'NTFS' && cim.driveType === 3,
    };
}
function statfsHint(letter) {
    try {
        const st = fs.statfsSync(`${letter}\\`);
        const type = typeof st.type === 'bigint' ? Number(st.type) : st.type;
        // libuv 有时把 NTFS 标成 0x5346544e。本机 Node 24 实际返回 0，于是继续走 WMI。
        if (type === 0x5346544e)
            return { name: 'NTFS', fileIdReliable: true };
    }
    catch {
        return null;
    }
    return null;
}
function queryCim(letter) {
    try {
        const out = execFileSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}'"; if ($null -eq $d) { '' } else { $d.FileSystem + '|' + [int]$d.DriveType }`,
        ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
        return parseProbe(out);
    }
    catch {
        return null;
    }
}
function queryWmic(letter) {
    try {
        const out = execFileSync('cmd.exe', ['/c', 'wmic', 'logicaldisk', 'where', `DeviceID='${letter}'`, 'get', 'FileSystem,DriveType', '/value'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
        const fsName = /FileSystem=(\S+)/i.exec(out)?.[1]?.toUpperCase() ?? '';
        const driveType = Number(/DriveType=(\d+)/i.exec(out)?.[1] ?? '0');
        if (!fsName)
            return null;
        return { name: fsName, driveType };
    }
    catch {
        return null;
    }
}
function parseProbe(out) {
    const line = out.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).at(-1) ?? '';
    const [nameRaw, typeRaw] = line.split('|');
    const name = (nameRaw ?? '').trim().toUpperCase();
    const driveType = Number((typeRaw ?? '').trim());
    if (!name || !Number.isFinite(driveType))
        return null;
    return { name, driveType };
}
export function fileIdFromStat(st, reliable) {
    if (!reliable)
        return null;
    const ino = st.ino;
    if (typeof ino === 'bigint') {
        if (ino === 0n)
            return null;
        return ino.toString(10);
    }
    if (!ino)
        return null;
    return String(ino);
}
export function mtimeMsFromStat(st) {
    return Number(st.mtimeNs / 1000000n);
}
export function sizeFromStat(st) {
    const size = st.size;
    if (typeof size === 'bigint') {
        if (size > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error('file too large');
        return Number(size);
    }
    return size;
}
export function kindFromStat(st) {
    if (st.isDirectory())
        return 'dir';
    if (st.isFile())
        return 'file';
    throw new Error('unsupported file type');
}
export function hashFile(absPath, cancel) {
    const hash = createHash('sha256');
    const fd = fs.openSync(absPath, 'r');
    try {
        const buf = Buffer.allocUnsafe(256 * 1024);
        while (true) {
            if (cancel())
                throw new ReconcileCancelledError();
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n === 0)
                break;
            hash.update(buf.subarray(0, n));
        }
    }
    finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}
//# sourceMappingURL=fsinfo.js.map