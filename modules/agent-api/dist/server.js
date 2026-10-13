import http from 'node:http';
import path from 'node:path';
import { ApiError, PathRejectedError } from "./errors.js";
import { generateSecret, loadIssuedTokens, secretsEqual, writeTokenFile } from "./token-store.js";
import { DEFAULT_MAX_READ_BYTES, HARD_MAX_READ_BYTES, WRITE_METHODS, RPC_METHODS, } from "./types.js";
const BODY_LIMIT = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function assertLoopbackHost(host) {
    if (host !== '127.0.0.1') {
        throw new Error(`refusing to bind ${host}: HTTP must listen on 127.0.0.1 only`);
    }
}
export async function startServer(opts) {
    const host = opts.host ?? '127.0.0.1';
    assertLoopbackHost(host);
    if (!opts.dataDir)
        throw new Error('dataDir is required');
    if (!opts.services)
        throw new Error('services is required');
    validateTokenSpecs(opts.tokens);
    await assertDataDirOutsideRoots(opts.dataDir, opts.services);
    const loaded = await loadIssuedTokens(opts.dataDir, opts.tokens);
    const tokens = loaded.active;
    const storedTokens = loaded.stored;
    const tokenFile = loaded.tokenFile;
    let boundPort = 0;
    const server = http.createServer((req, res) => {
        void handleRequest(req, res, {
            port: () => boundPort,
            tokens,
            storedTokens,
            dataDir: opts.dataDir,
            services: opts.services,
        }).catch((error) => {
            if (res.headersSent)
                return;
            const message = error instanceof Error ? error.message : 'internal';
            console.error(`rpc failed: ${message}`);
            sendJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal' } });
        });
    });
    try {
        await new Promise((resolveListen, rejectListen) => {
            const onError = (error) => rejectListen(error);
            server.once('error', onError);
            server.listen(opts.port ?? 0, host, () => {
                server.off('error', onError);
                const addr = server.address();
                if (!addr || typeof addr === 'string' || addr.address !== '127.0.0.1') {
                    rejectListen(new Error('server did not bind 127.0.0.1'));
                    return;
                }
                boundPort = addr.port;
                resolveListen();
            });
        });
    }
    catch (error) {
        server.close();
        throw error;
    }
    return {
        host: '127.0.0.1',
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}/rpc`,
        tokenFile,
        tokens,
        async close() {
            server.closeAllConnections();
            await new Promise((resolveClose, rejectClose) => {
                server.close((error) => (error ? rejectClose(error) : resolveClose()));
            });
        },
    };
}
async function handleRequest(req, res, deps) {
    if (req.headers.origin !== undefined) {
        deny(req, res, 403, 'origin_forbidden');
        return;
    }
    const port = deps.port();
    if (req.headers.host !== `127.0.0.1:${port}`) {
        deny(req, res, 403, 'host_forbidden');
        return;
    }
    const secret = parseBearer(req.headers.authorization);
    const token = secret ? matchToken(deps.tokens, secret) : undefined;
    if (!token) {
        deny(req, res, 401, 'unauthorized');
        return;
    }
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/rpc') {
        deny(req, res, 404, 'not_found');
        return;
    }
    const type = req.headers['content-type'];
    if (!type || !/^application\/json(?:\s*;|$)/i.test(type)) {
        deny(req, res, 415, 'unsupported_media_type');
        return;
    }
    let raw;
    try {
        raw = await readBody(req);
    }
    catch (error) {
        if (error instanceof ApiError) {
            sendJson(res, error.httpStatus, rpcError(null, error));
            return;
        }
        throw error;
    }
    let payload;
    try {
        payload = JSON.parse(stripBom(raw.toString('utf8')));
    }
    catch {
        sendJson(res, 400, rpcError(null, new ApiError(400, -32700, 'parse_error')));
        return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, rpcError(null, new ApiError(400, -32600, 'invalid_request')));
        return;
    }
    const msg = payload;
    const id = msg.id ?? null;
    if (msg.jsonrpc !== '2.0' || (id !== null && typeof id !== 'string' && typeof id !== 'number')) {
        sendJson(res, 400, rpcError(null, new ApiError(400, -32600, 'invalid_request')));
        return;
    }
    if (typeof msg.method !== 'string' || !isRpcMethod(msg.method)) {
        sendJson(res, 200, rpcError(id, new ApiError(200, -32601, 'method_not_found')));
        return;
    }
    if (msg.method === 'plans.approve' || msg.method === 'plans.apply') {
        sendJson(res, 403, rpcError(id, new ApiError(403, -32003, 'user_approval_required')));
        return;
    }
    if (msg.method === 'ops.restore') {
        sendJson(res, 403, rpcError(id, new ApiError(403, -32003, 'plan_required')));
        return;
    }
    if (token.permission === 'read' && WRITE_METHODS.has(msg.method)) {
        sendJson(res, 403, rpcError(id, new ApiError(403, -32003, 'read_only', { method: msg.method })));
        return;
    }
    try {
        const result = await dispatch(msg.method, msg.params, token, deps);
        sendJson(res, 200, { jsonrpc: '2.0', id, result });
    }
    catch (error) {
        if (error instanceof ApiError) {
            sendJson(res, error.httpStatus, rpcError(id, error));
            return;
        }
        console.error(error instanceof Error ? error.message : error);
        sendJson(res, 500, rpcError(id, new ApiError(500, -32603, 'internal')));
    }
}
async function dispatch(method, params, token, deps) {
    const ctx = serviceCtx(token);
    const input = asObject(params);
    const services = deps.services;
    switch (method) {
        case 'roots.list': {
            const all = await services.registeredRoots();
            return {
                roots: all
                    .filter((root) => token.rootIds.includes(root.id))
                    .map((root) => ({ id: root.id, name: root.name, localPath: root.localPath })),
            };
        }
        case 'fs.list': {
            const rootId = needString(input, 'rootId');
            const relPath = needPath(input, 'path');
            await assertUsableRoot(services, token, rootId, relPath);
            return { entries: await services.listDirectory(ctx, rootId, relPath) };
        }
        case 'fs.read': {
            const rootId = needString(input, 'rootId');
            const relPath = needPath(input, 'path');
            await assertUsableRoot(services, token, rootId, relPath);
            const maxBytes = capMaxBytes(input.maxBytes);
            return services.readFile(ctx, rootId, relPath, { maxBytes });
        }
        case 'search.query': {
            const query = needString(input, 'query');
            const rootId = optionalString(input, 'rootId');
            if (rootId)
                await assertUsableRoot(services, token, rootId, '');
            const limit = optionalPositiveInt(input.limit);
            return services.search(ctx, query, { rootId, limit });
        }
        case 'ops.preview': {
            const op = needString(input, 'op');
            if (op !== 'move' && op !== 'rename' && op !== 'restore') {
                throw new ApiError(400, -32602, 'unsupported_op');
            }
            if (op === 'move' || op === 'rename') {
                const rootId = needString(input, 'rootId');
                const fromPath = needPath(input, 'fromPath');
                const toPath = needPath(input, 'toPath');
                await assertUsableRoot(services, token, rootId, fromPath);
                await assertUsableRoot(services, token, rootId, toPath);
                return services.preview(ctx, { op, rootId, fromPath, toPath });
            }
            const opId = needString(input, 'opId');
            return services.preview(ctx, { op: 'restore', opId });
        }
        case 'ops.apply':
            throw new ApiError(403, -32003, 'plan_required');
        case 'plans.create': {
            const title = needString(input, 'title');
            return services.plansCreate(ctx, { title, ops: parsePlanOps(input, token) });
        }
        case 'plans.preview':
            return services.plansPreview(ctx, needString(input, 'planId'));
        case 'plans.approve':
        case 'plans.apply':
            throw new ApiError(403, -32003, 'user_approval_required');
        case 'plans.get':
            return services.plansGet(ctx, needString(input, 'planId'));
        case 'ops.restore':
            throw new ApiError(403, -32003, 'plan_required');
        case 'ops.log': {
            const rootId = optionalString(input, 'rootId');
            if (rootId && !token.rootIds.includes(rootId))
                throw new ApiError(403, -32003, 'root_forbidden', { rootId });
            const limit = optionalPositiveInt(input.limit);
            return { entries: await services.log(ctx, { limit, rootId }) };
        }
        case 'tokens.rotate':
            return rotateCurrent(deps, token);
        default:
            throw new ApiError(200, -32601, 'method_not_found');
    }
}
function parsePlanOps(input, token) {
    const raw = input.ops;
    if (!Array.isArray(raw) || raw.length === 0)
        throw new ApiError(400, -32602, 'invalid_params', { name: 'ops' });
    return raw.map((item) => parsePlanOp(item, token));
}
function parsePlanOp(item, token) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new ApiError(400, -32602, 'invalid_params', { name: 'ops' });
    }
    const op = item;
    if (op.type === 'restore') {
        return { type: 'restore', opId: needString(op, 'opId'), onConflict: readOnConflict(op.onConflict) };
    }
    const rootId = needString(op, 'rootId');
    if (!token.rootIds.includes(rootId))
        throw new ApiError(403, -32003, 'root_forbidden', { rootId });
    if (op.type === 'create' || op.type === 'write') {
        if (typeof op.content !== 'string')
            throw new ApiError(400, -32602, 'invalid_params', { name: 'content' });
        return { type: op.type, rootId, relPath: needString(op, 'relPath'), content: op.content };
    }
    if (op.type === 'move') {
        const fromRelPath = needString(op, 'fromRelPath');
        const toRelPath = needString(op, 'toRelPath');
        if (op.toRootId === undefined)
            return { type: 'move', rootId, fromRelPath, toRelPath };
        if (typeof op.toRootId !== 'string' || op.toRootId.length === 0) {
            throw new ApiError(400, -32602, 'invalid_params', { name: 'toRootId' });
        }
        if (!token.rootIds.includes(op.toRootId)) {
            throw new ApiError(403, -32003, 'root_forbidden', { rootId: op.toRootId });
        }
        return { type: 'move', rootId, fromRelPath, toRelPath, toRootId: op.toRootId };
    }
    if (op.type === 'rename') {
        return {
            type: 'rename',
            rootId,
            fromRelPath: needString(op, 'fromRelPath'),
            toRelPath: needString(op, 'toRelPath'),
        };
    }
    if (op.type === 'delete')
        return { type: 'delete', rootId, relPath: needString(op, 'relPath') };
    throw new ApiError(400, -32602, 'unsupported_op');
}
function readOnConflict(value) {
    if (value === 'cancel' || value === 'rename' || value === 'overwrite')
        return value;
    throw new ApiError(400, -32602, 'invalid_params', { name: 'onConflict' });
}
async function rotateCurrent(deps, current) {
    const secret = generateSecret();
    const next = {
        name: current.name,
        permission: current.permission,
        rootIds: [...current.rootIds],
        secret,
    };
    const stored = deps.storedTokens.map((item) => (item.name === current.name ? next : item));
    await writeTokenFile(deps.dataDir, stored);
    const index = deps.tokens.findIndex((item) => item.name === current.name);
    if (index >= 0)
        deps.tokens[index] = next;
    deps.storedTokens.splice(0, deps.storedTokens.length, ...stored);
    return { name: next.name, token: secret, permission: next.permission, rootIds: [...next.rootIds] };
}
function serviceCtx(token) {
    return {
        actor: `agent:${token.name}`,
        tokenName: token.name,
        rootIds: [...token.rootIds],
        permission: token.permission,
    };
}
async function assertUsableRoot(services, token, rootId, userPath) {
    if (!token.rootIds.includes(rootId))
        throw new ApiError(403, -32003, 'root_forbidden', { rootId });
    const roots = await services.registeredRoots();
    const root = roots.find((item) => item.id === rootId);
    if (!root)
        throw new ApiError(404, -32004, 'root_not_found');
    try {
        services.resolvePath(rootId, userPath);
    }
    catch (error) {
        if (error instanceof PathRejectedError) {
            throw new ApiError(400, -32602, 'path_rejected', { reason: error.reason });
        }
        throw error;
    }
}
async function assertDataDirOutsideRoots(dataDir, services) {
    const fs = await import('node:fs');
    fs.mkdirSync(dataDir, { recursive: true });
    const dataReal = fs.realpathSync(dataDir);
    const roots = await services.registeredRoots();
    for (const root of roots) {
        const rel = path.win32.relative(root.localPath, dataReal);
        const inside = rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
        if (inside)
            throw new Error('dataDir must not be inside a content root');
    }
}
function validateTokenSpecs(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0)
        throw new Error('at least one token is required');
    const names = new Set();
    for (const token of tokens) {
        if (!NAME_RE.test(token.name))
            throw new Error(`invalid token name: ${token.name}`);
        if (names.has(token.name))
            throw new Error(`duplicate token name: ${token.name}`);
        names.add(token.name);
        if (token.permission !== 'read' && token.permission !== 'readwrite') {
            throw new Error(`invalid permission: ${token.permission}`);
        }
        if (!Array.isArray(token.rootIds) || token.rootIds.some((id) => typeof id !== 'string' || id.length === 0)) {
            throw new Error(`token ${token.name} has invalid rootIds`);
        }
    }
}
function matchToken(tokens, secret) {
    let found;
    for (const token of tokens) {
        if (secretsEqual(token.secret, secret))
            found = token;
    }
    return found;
}
function parseBearer(header) {
    if (!header)
        return null;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match?.[1])
        return null;
    return match[1];
}
function isRpcMethod(method) {
    return RPC_METHODS.includes(method);
}
function asObject(params) {
    if (params === undefined || params === null)
        return {};
    if (typeof params !== 'object' || Array.isArray(params))
        throw new ApiError(400, -32602, 'invalid_params');
    return params;
}
function needString(input, key) {
    const value = input[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new ApiError(400, -32602, 'invalid_params', { name: key });
    }
    return value;
}
function needPath(input, key) {
    if (!(key in input))
        throw new ApiError(400, -32602, 'invalid_params', { name: key });
    const value = input[key];
    if (typeof value !== 'string')
        throw new ApiError(400, -32602, 'invalid_params', { name: key });
    return value;
}
function optionalString(input, key) {
    if (!(key in input) || input[key] === undefined)
        return undefined;
    const value = input[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new ApiError(400, -32602, 'invalid_params', { name: key });
    }
    return value;
}
function optionalPositiveInt(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new ApiError(400, -32602, 'invalid_params');
    }
    return value;
}
function capMaxBytes(value) {
    if (value === undefined)
        return DEFAULT_MAX_READ_BYTES;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new ApiError(400, -32602, 'invalid_params', { name: 'maxBytes' });
    }
    return Math.min(value, HARD_MAX_READ_BYTES);
}
function rpcError(id, error) {
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code: error.rpcCode,
            message: error.message,
            ...(error.data !== undefined ? { data: error.data } : {}),
        },
    };
}
function deny(req, res, status, message) {
    const code = status === 401 ? -32001 : -32003;
    sendJson(res, status, rpcError(null, new ApiError(status, code, message)));
    req.resume();
}
function sendJson(res, status, body) {
    const raw = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(raw),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(raw);
}
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > BODY_LIMIT)
            throw new ApiError(413, -32005, 'body_too_large');
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
//# sourceMappingURL=server.js.map