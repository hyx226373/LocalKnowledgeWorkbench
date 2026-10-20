// Seed an isolated userData whose last workspace has a root with an image open as the active tab (for imgfix cold-start runs).
// Usage: node scripts/seed-imgfix-userdata.mjs <userDataDir> <imgRootDir>   (dev electron, no clicks)
import { _electron as electron } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [UD, IMG] = process.argv.slice(2).map((p) => path.resolve(p));
fs.rmSync(UD, { recursive: true, force: true }); fs.mkdirSync(UD, { recursive: true }); fs.mkdirSync(IMG, { recursive: true });
function crc(b) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }
function png(w, h) { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 255 / w) | 0; raw[o + 1] = (y * 255 / h) | 0; raw[o + 2] = 128; } } const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
fs.writeFileSync(path.join(IMG, 'cold-image.png'), png(640, 400));
const app = await electron.launch({ args: ['.'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: UD } });
const win = await app.firstWindow();
await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 60000 });
const root = await win.evaluate((p) => window.kb.addRoot(p), IMG);
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 60000, polling: 300 });
await win.evaluate(([r]) => window.__kb.openByPath(r, 'cold-image.png', 'tab'), [root.id]);
const ok = await win.waitForFunction(() => { const i = document.querySelector('img[src^="kbfile:"]'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 }).then(() => true, () => false);
await win.evaluate(() => window.__kb.flush());
const items = await win.evaluate(async () => (await window.kb.getWorkspace(await window.kb.getCurrentWorkspaceId())).items);
console.log(JSON.stringify({ root: root.id, imgShown: ok, items: items.map((i) => [i.adapterId, i.ref]) }));
await app.close();