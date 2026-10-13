import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { TOKEN_FILE_NAME } from "./types.js";
const execFileAsync = promisify(execFile);
export function generateSecret() {
    return randomBytes(32).toString('base64url');
}
export function tokenFilePath(dataDir) {
    return path.join(dataDir, TOKEN_FILE_NAME);
}
export function secretsEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length) {
        timingSafeEqual(a, Buffer.alloc(a.length));
        return false;
    }
    return timingSafeEqual(a, b);
}
function sameIds(left, right) {
    if (left.length !== right.length)
        return false;
    const a = [...left].sort();
    const b = [...right].sort();
    return a.every((id, index) => id === b[index]);
}
function isIssued(value) {
    if (!value || typeof value !== 'object')
        return false;
    const token = value;
    return (typeof token.name === 'string' &&
        typeof token.secret === 'string' &&
        token.secret.length > 0 &&
        (token.permission === 'read' || token.permission === 'readwrite') &&
        Array.isArray(token.rootIds) &&
        token.rootIds.every((id) => typeof id === 'string' && id.length > 0));
}
function parseTokenFile(raw) {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tokens)) {
        throw new Error('token file is invalid');
    }
    return parsed.tokens.map((token) => {
        if (!isIssued(token))
            throw new Error('token file is invalid');
        return {
            name: token.name,
            secret: token.secret,
            permission: token.permission,
            rootIds: [...token.rootIds],
        };
    });
}
/**
 * 已有同名令牌就沿用 secret。规格没变时不写文件，避免每次启动覆盖整份令牌。
 * 文件里多出来的名字留在 stored 里，这次进程不拿它们做鉴权。
 */
export async function loadIssuedTokens(dataDir, specs) {
    const dest = tokenFilePath(dataDir);
    let existing = [];
    let hadFile = false;
    try {
        existing = parseTokenFile(await fs.readFile(dest, 'utf8'));
        hadFile = true;
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT')
            throw error;
    }
    const byName = new Map(existing.map((token) => [token.name, token]));
    const active = [];
    let changed = !hadFile;
    for (const spec of specs) {
        const prev = byName.get(spec.name);
        const rootIds = [...spec.rootIds];
        if (prev && prev.permission === spec.permission && sameIds(prev.rootIds, rootIds)) {
            active.push({ name: spec.name, permission: spec.permission, rootIds, secret: prev.secret });
        }
        else if (prev) {
            active.push({ name: spec.name, permission: spec.permission, rootIds, secret: prev.secret });
            changed = true;
        }
        else {
            active.push({ name: spec.name, permission: spec.permission, rootIds, secret: generateSecret() });
            changed = true;
        }
        byName.delete(spec.name);
    }
    const stored = [...active, ...byName.values()];
    if (changed)
        await writeTokenFile(dataDir, stored);
    return { active, stored, tokenFile: dest };
}
export async function writeTokenFile(dataDir, tokens) {
    const dest = tokenFilePath(dataDir);
    const payload = {
        version: 1,
        issuedAt: new Date().toISOString(),
        tokens,
    };
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(dest, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
    try {
        await restrictToCurrentUser(dest);
    }
    catch (error) {
        await fs.rm(dest, { force: true });
        throw error;
    }
    return dest;
}
/**
 * 收成仅当前用户可访问。Windows 上用 icacls 去掉继承。
 * ACE 用完全控制而不是只读，这样下次启动能覆盖令牌文件，测试也能删掉临时目录。
 * 验收只要求 Everyone 和 Users 没有读权限。
 */
export async function restrictToCurrentUser(filePath) {
    if (process.platform !== 'win32') {
        await fs.chmod(filePath, 0o600);
        return;
    }
    const { stdout } = await execFileAsync('whoami', [], { windowsHide: true, encoding: 'utf8' });
    const user = String(stdout).trim();
    if (!user)
        throw new Error('whoami returned empty');
    await execFileAsync('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`], {
        windowsHide: true,
        encoding: 'utf8',
    });
}
//# sourceMappingURL=token-store.js.map