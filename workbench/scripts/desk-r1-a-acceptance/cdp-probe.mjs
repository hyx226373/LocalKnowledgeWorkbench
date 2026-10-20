#!/usr/bin/env node
/**
 * Minimal CDP connect probe: undici global WS vs `ws` vs Playwright connectOverCDP.
 * Usage:
 *   node cdp-probe.mjs --port 9222 [--backend undici|ws|playwright|all]
 * Env: DESK_R1_CDP_PORT
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : (process.env.DESK_R1_CDP_PORT || 9222));
const backendArg = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : 'all';
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(process.cwd(), 'out', 'acceptance', 'cdp-probe');
mkdirSync(outDir, { recursive: true });

function formatWsErrorEvent(e) {
  const safe = {
    type: e?.type,
    message: e?.message,
    errorName: e?.error?.name,
    errorMessage: e?.error?.message,
    errorStack: e?.error?.stack,
    errorCause: e?.error?.cause
      ? {
          name: e.error.cause?.name,
          message: e.error.cause?.message,
          code: e.error.cause?.code,
          errno: e.error.cause?.errno,
          syscall: e.error.cause?.syscall,
          address: e.error.cause?.address,
          port: e.error.cause?.port,
        }
      : undefined,
  };
  try { safe.eventJSON = JSON.stringify(e, Object.getOwnPropertyNames(e || {})); } catch (err) { safe.eventJSONError = String(err); }
  try { if (e?.error) safe.errorJSON = JSON.stringify(e.error, Object.getOwnPropertyNames(e.error)); } catch (err) { safe.errorJSONError = String(err); }
  const text = [
    `type=${safe.type}`,
    `message=${JSON.stringify(safe.message)}`,
    `error.name=${JSON.stringify(safe.errorName)}`,
    `error.message=${JSON.stringify(safe.errorMessage)}`,
    safe.errorCause ? `error.cause=${JSON.stringify(safe.errorCause)}` : null,
    safe.eventJSON ? `eventJSON=${safe.eventJSON}` : null,
    safe.errorJSON ? `errorJSON=${safe.errorJSON}` : null,
  ].filter(Boolean).join(' ; ');
  return { text, safe };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function pickTargets() {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  let version = null;
  try { version = await fetchJson(`http://127.0.0.1:${port}/json/version`); } catch {}
  const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const others = (list || []).filter((t) => t.type !== 'page' && t.webSocketDebuggerUrl);
  return { list, version, pages, others, page: pages[0] || null };
}

function evalUndici(wsUrl, expression, timeoutMs = 15000) {
  const WS = globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error('timeout')); }, timeoutMs);
    const send = (method, params) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    ws.addEventListener('open', () => {
      (async () => {
        await send('Runtime.enable', {});
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        clearTimeout(timer);
        ws.close();
        resolve(result);
      })().catch((e) => { clearTimeout(timer); reject(e); });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      const f = formatWsErrorEvent(e);
      reject(new Error('UNDICI ErrorEvent EXPANDED: ' + f.text));
    });
  });
}

function evalWs(wsUrl, expression, timeoutMs = 15000) {
  let WS;
  try { WS = require('ws'); } catch (e) {
    try { WS = require(join(process.cwd(), 'node_modules', 'ws')); } catch (e2) {
      throw new Error('ws package not installed: ' + e2.message);
    }
  }
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error('timeout')); }, timeoutMs);
    const send = (method, params) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    ws.on('open', () => {
      (async () => {
        await send('Runtime.enable', {});
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        clearTimeout(timer);
        ws.close();
        resolve(result);
      })().catch((e) => { clearTimeout(timer); reject(e); });
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error('WS error: ' + (err?.message || String(err)) + ' code=' + err?.code));
    });
  });
}

async function evalPlaywright(expression) {
  let chromium;
  try {
    const pw = require('playwright');
    chromium = pw.chromium;
  } catch (e) {
    throw new Error('playwright not available: ' + e.message);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((c) => c.pages());
    if (!pages.length) throw new Error('playwright: no pages');
    const page = pages[0];
    const value = await page.evaluate(expression);
    return { result: { type: 'object', value } };
  } finally {
    await browser.close().catch(() => {});
  }
}

const expr = `({ href: location.href, title: document.title, ua: navigator.userAgent.slice(0,80), ts: Date.now() })`;

const report = { port, startedAt: new Date().toISOString(), backends: {}, targets: null };
console.log(`[probe] port=${port} backend=${backendArg}`);

try {
  const targets = await pickTargets();
  report.targets = {
    version: targets.version,
    pageCount: targets.pages.length,
    otherTypes: targets.others.map((t) => ({ type: t.type, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl })),
    chosenPage: targets.page
      ? { type: targets.page.type, title: targets.page.title, url: targets.page.url, id: targets.page.id, webSocketDebuggerUrl: targets.page.webSocketDebuggerUrl }
      : null,
    browserWsFromVersion: targets.version?.webSocketDebuggerUrl || null,
  };
  console.log('[probe] chosen page type=', targets.page?.type, 'title=', targets.page?.title);
  console.log('[probe] page WS=', targets.page?.webSocketDebuggerUrl);
  console.log('[probe] version browser WS=', targets.version?.webSocketDebuggerUrl);

  if (!targets.page) throw new Error('no page target');

  const backends = backendArg === 'all' ? ['undici', 'ws', 'playwright'] : [backendArg];
  for (const b of backends) {
    const entry = { backend: b, ok: false };
    try {
      let result;
      if (b === 'undici') result = await evalUndici(targets.page.webSocketDebuggerUrl, expr);
      else if (b === 'ws') result = await evalWs(targets.page.webSocketDebuggerUrl, expr);
      else if (b === 'playwright') result = await evalPlaywright(expr);
      else throw new Error('unknown backend');
      entry.ok = true;
      entry.value = result?.result?.value ?? result?.result ?? result;
      console.log(`[probe] ${b} OK`, JSON.stringify(entry.value));
    } catch (e) {
      entry.ok = false;
      entry.error = String(e?.message || e);
      entry.stack = String(e?.stack || '').split('\n').slice(0, 8);
      console.error(`[probe] ${b} FAIL:`, entry.error);
    }
    report.backends[b] = entry;
  }
} catch (e) {
  report.fatal = String(e?.message || e);
  console.error('[probe] fatal', report.fatal);
}

const outPath = join(outDir, `probe-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('[probe] wrote', outPath);
const anyOk = Object.values(report.backends || {}).some((b) => b.ok);
process.exitCode = anyOk ? 0 : 1;
