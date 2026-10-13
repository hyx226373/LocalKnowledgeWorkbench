import { type IssuedToken, type TokenSpec } from './types.js';
export interface TokenFilePayload {
    version: 1;
    issuedAt: string;
    tokens: IssuedToken[];
}
export declare function generateSecret(): string;
export declare function tokenFilePath(dataDir: string): string;
export declare function secretsEqual(left: string, right: string): boolean;
export interface LoadedTokens {
    active: IssuedToken[];
    stored: IssuedToken[];
    tokenFile: string;
}
/**
 * 已有同名令牌就沿用 secret。规格没变时不写文件，避免每次启动覆盖整份令牌。
 * 文件里多出来的名字留在 stored 里，这次进程不拿它们做鉴权。
 */
export declare function loadIssuedTokens(dataDir: string, specs: TokenSpec[]): Promise<LoadedTokens>;
export declare function writeTokenFile(dataDir: string, tokens: IssuedToken[]): Promise<string>;
/**
 * 收成仅当前用户可访问。Windows 上用 icacls 去掉继承。
 * ACE 用完全控制而不是只读，这样下次启动能覆盖令牌文件，测试也能删掉临时目录。
 * 验收只要求 Everyone 和 Users 没有读权限。
 */
export declare function restrictToCurrentUser(filePath: string): Promise<void>;
