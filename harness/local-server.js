// Local test harness: runs the REAL src/worker.js with filesystem-backed R2
// and node:sqlite-backed D1, so the exact deploy logic is exercised without
// Cloudflare. Not used in production — Cloudflare provides DB/BUCKET/ASSETS.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
// Which worker to run: multi-file source by default, or the built bundle.
const worker = (await import(process.env.WORKER_FILE || '../src/worker.js')).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, '.harness-data');
const PORT = Number(process.env.PORT || 8788);
fs.mkdirSync(path.join(DATA, 'objects'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'mp'), { recursive: true });

// ---------------- D1 shim (node:sqlite) ----------------
const sqlite = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'd1.sqlite'));
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
function clean(row) {
  if (!row) return row;
  const o = {};
  for (const k in row) o[k] = typeof row[k] === 'bigint' ? Number(row[k]) : row[k];
  return o;
}
const DB = {
  prepare(sql) {
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      first() { const r = sqlite.prepare(sql).get(...args); return clean(r) || null; },
      all() { return { results: sqlite.prepare(sql).all(...args).map(clean), success: true }; },
      run() { const r = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
    };
  },
};

// ---------------- helpers ----------------
async function toBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (typeof value === 'string') return Buffer.from(value);
  if (typeof value.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer()); // Blob
  if (typeof value.getReader === 'function') {                                                 // ReadableStream
    const reader = value.getReader(); const chunks = [];
    while (true) { const { done, value: v } = await reader.read(); if (done) break; chunks.push(Buffer.from(v)); }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(value));
}
const md5 = (buf) => '"' + createHash('md5').update(buf).digest('hex') + '"';
const metaPath = (key) => path.join(DATA, 'objects', encodeURIComponent(key) + '.meta.json');
const dataPath = (key) => path.join(DATA, 'objects', encodeURIComponent(key) + '.bin');
const mpDir = (id) => path.join(DATA, 'mp', encodeURIComponent(id));

function multipartHandle(key, uploadId) {
  return {
    key, uploadId,
    async uploadPart(partNumber, value) {
      const buf = await toBuffer(value);
      fs.mkdirSync(mpDir(uploadId), { recursive: true });
      fs.writeFileSync(path.join(mpDir(uploadId), String(partNumber).padStart(6, '0')), buf);
      return { partNumber, etag: md5(buf) };
    },
    async complete(parts) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const bufs = sorted.map((p) => fs.readFileSync(path.join(mpDir(uploadId), String(p.partNumber).padStart(6, '0'))));
      const all = Buffer.concat(bufs);
      fs.writeFileSync(dataPath(key), all);
      const meta = JSON.parse(fs.existsSync(metaPath(key)) ? fs.readFileSync(metaPath(key), 'utf8') : '{}');
      meta.size = all.length; fs.writeFileSync(metaPath(key), JSON.stringify(meta));
      fs.rmSync(mpDir(uploadId), { recursive: true, force: true });
      return { key, size: all.length, etag: md5(all) };
    },
    async abort() { fs.rmSync(mpDir(uploadId), { recursive: true, force: true }); },
  };
}

function parseRange(range, size) {
  // range may be an R2Range object or a Headers with a Range header
  let spec = null;
  if (range && typeof range.get === 'function') {
    const h = range.get('Range'); if (h) { const m = h.match(/bytes=(\d*)-(\d*)/); if (m) spec = { s: m[1], e: m[2] }; }
  } else if (range && typeof range === 'object') {
    if (range.offset != null || range.length != null) return { offset: range.offset || 0, length: range.length != null ? range.length : size - (range.offset || 0) };
    if (range.suffix != null) return { offset: Math.max(0, size - range.suffix), length: Math.min(range.suffix, size) };
  }
  if (!spec) return null;
  let start = spec.s === '' ? null : parseInt(spec.s, 10);
  let end = spec.e === '' ? null : parseInt(spec.e, 10);
  if (start == null) { const n = end; start = Math.max(0, size - n); end = size - 1; }
  else if (end == null) { end = size - 1; }
  return { offset: start, length: end - start + 1 };
}

const BUCKET = {
  async createMultipartUpload(key, opts) {
    const uploadId = randomUUID();
    fs.mkdirSync(mpDir(uploadId), { recursive: true });
    fs.writeFileSync(metaPath(key), JSON.stringify({ contentType: opts?.httpMetadata?.contentType || 'application/octet-stream', uploadId }));
    return multipartHandle(key, uploadId);
  },
  resumeMultipartUpload(key, uploadId) { return multipartHandle(key, uploadId); },
  async put(key, value, opts) {
    const buf = await toBuffer(value);
    fs.writeFileSync(dataPath(key), buf);
    fs.writeFileSync(metaPath(key), JSON.stringify({ size: buf.length, contentType: opts?.httpMetadata?.contentType || 'application/octet-stream' }));
    return { key, size: buf.length, etag: md5(buf) };
  },
  async get(key, opts) {
    if (!fs.existsSync(dataPath(key))) return null;
    const data = fs.readFileSync(dataPath(key));
    const meta = JSON.parse(fs.existsSync(metaPath(key)) ? fs.readFileSync(metaPath(key), 'utf8') : '{}');
    const size = data.length;
    const r = opts && opts.range ? parseRange(opts.range, size) : null;
    const slice = r ? data.subarray(r.offset, r.offset + r.length) : data;
    return {
      key, size, httpEtag: md5(data), range: r || undefined,
      writeHttpMetadata(headers) { headers.set('etag', md5(data)); if (meta.contentType) headers.set('content-type', meta.contentType); },
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(slice)); c.close(); } }),
      async arrayBuffer() { return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength); },
    };
  },
  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) { fs.rmSync(dataPath(k), { force: true }); fs.rmSync(metaPath(k), { force: true }); }
  },
};

// ---------------- ASSETS shim ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };
const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    let file = path.join(ROOT, 'public', p);
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
    const ext = path.extname(file).toLowerCase();
    return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
  },
};

const env = {
  DB, BUCKET, ASSETS,
  ADMIN_KEY: process.env.ADMIN_KEY || 'dids_admin_master_test',
  SESSION_SECRET: process.env.SESSION_SECRET || 'harness-secret-not-for-prod',
  LOCK_MODE: process.env.LOCK_MODE || 'hwid',
  PART_SIZE: process.env.PART_SIZE || undefined,
};

// ---------------- Node HTTP -> Worker bridge ----------------
const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const bodyBuf = Buffer.concat(chunks);
    const url = 'http://' + (req.headers.host || 'localhost:' + PORT) + req.url;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', process.env.TEST_IP || '203.0.113.7');
    const request = new Request(url, { method: req.method, headers, body: hasBody ? bodyBuf : undefined });
    try { request.cf = { city: process.env.TEST_CITY || 'London', region: 'England', country: process.env.TEST_CC || 'GB' }; } catch (_) {}

    let response;
    try { response = await worker.fetch(request, env, { waitUntil() {} }); }
    catch (e) { response = new Response('harness error: ' + (e && e.stack || e), { status: 500 }); }

    res.statusCode = response.status;
    response.headers.forEach((v, k) => { try { res.setHeader(k, v); } catch (_) {} });
    const ab = await response.arrayBuffer();
    res.end(Buffer.from(ab));
  });
});
server.listen(PORT, () => console.log(`[harness] http://localhost:${PORT}  (admin key: ${env.ADMIN_KEY})`));
