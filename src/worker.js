// Dids File Storage — Cloudflare Worker (API + static hosting).
//
// Bindings (see wrangler.toml):
//   env.DB      -> D1 database
//   env.BUCKET  -> R2 bucket
//   env.ASSETS  -> static assets (the /public folder)
//   env.ADMIN_KEY, env.SESSION_SECRET, env.LOCK_MODE -> vars/secrets

import { db } from './lib/db.js';
import {
  json, uuid, nowISO, newPlainKey, sha256Hex, clientInfo, humanSize,
} from './lib/util.js';
import {
  enterKey, logActivity, makeSession, readSession, requireRole,
  sessionSetCookie, sessionClearCookie,
} from './lib/auth.js';

const MAX_FILE = 250 * 1024 * 1024 * 1024;        // 250 GB
const DEFAULT_PART = 95 * 1024 * 1024;            // 95 MB (< 100MB Worker body limit)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith('/api/')) return await api(request, env, ctx, url);
      if (path.startsWith('/dl/'))  return await download(request, env, path.slice(4));

      // pretty routes -> html pages
      const map = { '/': '/index.html', '/public': '/public.html', '/private': '/private.html', '/admin': '/admin.html' };
      return serveAsset(request, env, url, map[path] || path);
    } catch (e) {
      if (e instanceof Response) return e;           // thrown by requireRole etc.
      return json({ error: 'server_error', detail: String(e && e.message || e) }, 500);
    }
  },
};

async function body(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

// Serve a static page. Two modes:
//  - assets-binding mode (multi-file deploy): hand off to env.ASSETS.
//  - bundle mode (single-file deploy): pages are embedded in globalThis.__PAGES__.
async function serveAsset(request, env, url, p) {
  const pages = globalThis.__PAGES__;
  if (pages) {
    const page = pages[p] || pages[p + '.html'] || (p.endsWith('/') ? pages[p + 'index.html'] : null);
    if (!page) return new Response('Not found', { status: 404 });
    return new Response(page.body, { headers: { 'content-type': page.ct } });
  }
  return env.ASSETS.fetch(new Request(new URL(p, url), request));
}

async function api(request, env, ctx, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const m = request.method;
  const d = db(env);

  // ---------- session / key entry ----------
  if (p === '/me' && m === 'GET') {
    const s = await readSession(env, request);
    return json({ role: s ? s.role : null });
  }

  if (p === '/key/enter' && m === 'POST') {
    const { key, hwid, fp } = await body(request);
    if (!key) return json({ error: 'missing_key' }, 400);
    const r = await enterKey(env, request, String(key), String(hwid || ''), fp ? String(fp) : '');
    if (r.locked) return json({ error: 'device_locked', message: 'This key is already in use on another device/IP. Contact admin to resolve issue.' }, 423);
    if (r.invalid) return json({ error: 'invalid_key', revoked: !!r.revoked }, 401);
    const token = await makeSession(env, { keyId: r.keyId, role: r.role, hwid: r.hwid });
    const dest = r.role === 'admin' ? '/admin' : r.role === 'staff' ? '/private' : '/public';
    return json({ ok: true, role: r.role, redirect: dest }, 200, sessionSetCookie(token));
  }

  if (p === '/logout' && m === 'POST') {
    return json({ ok: true }, 200, sessionClearCookie());
  }

  // ---------- folders ----------
  if (p === '/folders' && m === 'GET') {
    const s = await readSession(env, request);
    let rows;
    if (s && (s.role === 'admin' || s.role === 'staff')) {
      rows = await d.all(`SELECT id,name,permission,created_at,created_by FROM folders ORDER BY name`);
    } else {
      rows = await d.all(`SELECT id,name,permission,created_at,created_by FROM folders WHERE permission='everyone' ORDER BY name`);
    }
    return json({ folders: rows });
  }

  if (p === '/folders' && m === 'POST') {
    const s = await requireRole(env, request, ['admin', 'staff']);
    const { name, permission } = await body(request);
    if (!name || !String(name).trim()) return json({ error: 'missing_name' }, 400);
    const perm = permission === 'everyone' ? 'everyone' : 'staff';
    const id = uuid();
    await d.run(`INSERT INTO folders (id,name,permission,created_at,created_by) VALUES (?,?,?,?,?)`,
      id, String(name).trim(), perm, nowISO(), s.keyId);
    const { ip, geo } = clientInfo(request);
    await logActivity(env, 'folder_create', { keyId: s.keyId, role: s.role, ip, geo, hwid: s.hwid, detail: `${name} (${perm})` });
    return json({ ok: true, id });
  }

  // ---------- file listings ----------
  if (p === '/public/files' && m === 'GET') {
    const rows = await d.all(
      `SELECT f.id,f.name,f.size,f.content_type,f.created_at,f.downloads,fo.name AS folder
       FROM files f LEFT JOIN folders fo ON fo.id=f.folder_id
       WHERE f.status='ready' AND f.permission='everyone' ORDER BY f.created_at DESC`);
    return json({ files: rows.map(decorate) });
  }

  if (p === '/files' && m === 'GET') {
    const s = await requireRole(env, request, ['admin', 'staff']);
    const rows = await d.all(
      `SELECT f.id,f.name,f.size,f.content_type,f.permission,f.created_at,f.downloads,fo.name AS folder
       FROM files f LEFT JOIN folders fo ON fo.id=f.folder_id
       WHERE f.status='ready' ORDER BY f.created_at DESC`);
    return json({ files: rows.map(decorate), role: s.role });
  }

  // ---------- chunked upload ----------
  if (p === '/uploads/create' && m === 'POST') {
    const s = await requireRole(env, request, ['admin', 'staff']);
    const { name, size, permission, folderId, contentType } = await body(request);
    const sz = Number(size) || 0;
    if (!name) return json({ error: 'missing_name' }, 400);
    if (sz <= 0 || sz > MAX_FILE) return json({ error: 'bad_size', max: MAX_FILE }, 400);
    const perm = permission === 'everyone' ? 'everyone' : 'staff';
    const ct = String(contentType || 'application/octet-stream');
    const partSize = Math.max(5 * 1024 * 1024, Number(env.PART_SIZE) || DEFAULT_PART);
    const fileId = uuid();
    const mp = await env.BUCKET.createMultipartUpload(fileId, { httpMetadata: { contentType: ct } });
    const { ip, geo } = clientInfo(request);
    await d.run(
      `INSERT INTO files (id,name,size,content_type,folder_id,permission,status,r2_upload_id,part_size,
         uploader_key,uploader_role,uploader_hwid,uploader_ip,uploader_geo,created_at)
       VALUES (?,?,?,?,?,?,'uploading',?,?,?,?,?,?,?,?)`,
      fileId, String(name), sz, ct, folderId || null, perm, mp.uploadId, partSize,
      s.keyId, s.role, s.hwid || null, ip, geo, nowISO());
    const partCount = Math.max(1, Math.ceil(sz / partSize));
    return json({ ok: true, fileId, uploadId: mp.uploadId, partSize, partCount });
  }

  if (p === '/uploads/part' && m === 'PUT') {
    const s = await requireRole(env, request, ['admin', 'staff']);
    const fileId = url.searchParams.get('fileId');
    const partNumber = Number(url.searchParams.get('part'));
    if (!fileId || !partNumber) return json({ error: 'bad_part' }, 400);
    const f = await d.get(`SELECT r2_upload_id,status,uploader_key FROM files WHERE id=?`, fileId);
    if (!f || f.status !== 'uploading') return json({ error: 'not_uploading' }, 409);
    if (s.role !== 'admin' && f.uploader_key !== s.keyId) return json({ error: 'forbidden' }, 403);
    const mp = env.BUCKET.resumeMultipartUpload(fileId, f.r2_upload_id);
    const uploaded = await mp.uploadPart(partNumber, request.body);
    return json({ ok: true, partNumber: uploaded.partNumber, etag: uploaded.etag });
  }

  if (p === '/uploads/complete' && m === 'POST') {
    const s = await requireRole(env, request, ['admin', 'staff']);
    const { fileId, parts } = await body(request);
    if (!fileId || !Array.isArray(parts) || !parts.length) return json({ error: 'bad_complete' }, 400);
    const f = await d.get(`SELECT * FROM files WHERE id=?`, fileId);
    if (!f || f.status !== 'uploading') return json({ error: 'not_uploading' }, 409);
    if (s.role !== 'admin' && f.uploader_key !== s.keyId) return json({ error: 'forbidden' }, 403);
    const mp = env.BUCKET.resumeMultipartUpload(fileId, f.r2_upload_id);
    const obj = await mp.complete((parts || []).map((x) => ({ partNumber: Number(x.partNumber), etag: String(x.etag) })));
    const realSize = (obj && obj.size) ? obj.size : f.size;
    await d.run(`UPDATE files SET status='ready', r2_upload_id=NULL, size=?, completed_at=? WHERE id=?`,
      realSize, nowISO(), fileId);
    await logActivity(env, 'upload', { keyId: f.uploader_key, role: f.uploader_role, ip: f.uploader_ip, geo: f.uploader_geo, hwid: f.uploader_hwid, detail: `${f.name} (${humanSize(realSize)}, ${f.permission})` });
    return json({ ok: true, fileId });
  }

  if (p === '/uploads/abort' && m === 'POST') {
    const s = await requireRole(env, request, ['admin', 'staff']);
    const { fileId } = await body(request);
    if (!fileId) return json({ error: 'missing_file' }, 400);
    const f = await d.get(`SELECT r2_upload_id,uploader_key FROM files WHERE id=?`, fileId);
    if (f && f.r2_upload_id) {
      try { await env.BUCKET.resumeMultipartUpload(fileId, f.r2_upload_id).abort(); } catch (_) {}
    }
    await d.run(`DELETE FROM files WHERE id=?`, fileId);
    return json({ ok: true });
  }

  // ---------- removal tickets ----------
  if (p === '/tickets' && m === 'POST') {
    const s = await requireRole(env, request, ['admin', 'staff']);
    const { link, reason, discord } = await body(request);
    if (!link || !reason || !discord) return json({ error: 'missing_fields' }, 400);
    const { ip, geo } = clientInfo(request);
    const id = uuid();
    await d.run(
      `INSERT INTO tickets (id,file_link,reason,discord,status,requester_key,requester_ip,requester_geo,created_at)
       VALUES (?,?,?,?,'open',?,?,?,?)`,
      id, String(link), String(reason), String(discord), s.keyId, ip, geo, nowISO());
    await logActivity(env, 'ticket', { keyId: s.keyId, role: s.role, ip, geo, hwid: s.hwid, detail: String(link) });
    return json({ ok: true, id });
  }

  // ======================= ADMIN =======================
  if (p.startsWith('/admin/')) {
    const s = await requireRole(env, request, ['admin']);

    if (p === '/admin/overview' && m === 'GET') {
      const files = await d.get(`SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM files WHERE status='ready'`);
      const keys = await d.get(`SELECT COUNT(*) n FROM keys WHERE status='active'`);
      const tix = await d.get(`SELECT COUNT(*) n FROM tickets WHERE status='open'`);
      return json({ files: files.n, bytes: files.bytes, bytesHuman: humanSize(files.bytes), activeKeys: keys.n, openTickets: tix.n });
    }

    if (p === '/admin/keys' && m === 'GET') {
      const rows = await d.all(
        `SELECT id,label,role,key_prefix,status,bound_hwid,bound_ip,bound_geo,bound_at,last_ip,last_geo,last_seen,created_at
         FROM keys ORDER BY created_at DESC`);
      return json({ keys: rows.map((k) => ({ ...k, bound: !!k.bound_hwid })) });
    }

    if (p === '/admin/keys' && m === 'POST') {
      const { role, label } = await body(request);
      const r = (role === 'admin' || role === 'staff' || role === 'public') ? role : 'staff';
      const plain = newPlainKey(r);
      const id = uuid();
      await d.run(
        `INSERT INTO keys (id,label,role,key_hash,key_prefix,status,created_at,created_by)
         VALUES (?,?,?,?,?, 'active', ?, 'admin')`,
        id, String(label || ''), r, await sha256Hex(plain), plain.slice(0, 12), nowISO());
      const { ip, geo } = clientInfo(request);
      await logActivity(env, 'key_gen', { keyId: id, role: r, ip, geo, detail: label || '' });
      return json({ ok: true, id, key: plain, note: 'Copy this key now — it is not stored and cannot be shown again.' });
    }

    const keyAction = p.match(/^\/admin\/keys\/([^/]+)\/(revoke|restore|reset-device)$/);
    if (keyAction && m === 'POST') {
      const [, id, action] = keyAction;
      const { ip, geo } = clientInfo(request);
      if (action === 'revoke')  { await d.run(`UPDATE keys SET status='revoked' WHERE id=?`, id);
        await logActivity(env, 'key_revoke', { keyId: id, ip, geo }); }
      if (action === 'restore') { await d.run(`UPDATE keys SET status='active' WHERE id=?`, id);
        await logActivity(env, 'key_restore', { keyId: id, ip, geo }); }
      if (action === 'reset-device') {
        await d.run(`UPDATE keys SET bound_hwid=NULL,bound_fp=NULL,bound_ip=NULL,bound_geo=NULL,bound_at=NULL WHERE id=?`, id);
        await logActivity(env, 'key_reset', { keyId: id, ip, geo, detail: 'device lock cleared' });
      }
      return json({ ok: true });
    }

    if (p === '/admin/uploads' && m === 'GET') {
      const rows = await d.all(
        `SELECT f.*, fo.name AS folder, k.label AS uploader_label
         FROM files f LEFT JOIN folders fo ON fo.id=f.folder_id
         LEFT JOIN keys k ON k.id=f.uploader_key
         ORDER BY f.created_at DESC`);
      return json({ uploads: rows.map((r) => ({
        id: r.id, name: r.name, size: r.size, sizeHuman: humanSize(r.size), permission: r.permission,
        status: r.status, folder: r.folder, downloads: r.downloads, created_at: r.created_at,
        uploader: { key: r.uploader_key, label: r.uploader_label, role: r.uploader_role,
          hwid: r.uploader_hwid, ip: r.uploader_ip, geo: r.uploader_geo } })) });
    }

    if (p === '/admin/activity' && m === 'GET') {
      const rows = await d.all(`SELECT * FROM activity ORDER BY ts DESC LIMIT 500`);
      return json({ activity: rows });
    }

    const delFile = p.match(/^\/admin\/files\/([^/]+)$/);
    if (delFile && m === 'DELETE') {
      const [, id] = delFile;
      const f = await d.get(`SELECT r2_upload_id,name FROM files WHERE id=?`, id);
      if (f && f.r2_upload_id) { try { await env.BUCKET.resumeMultipartUpload(id, f.r2_upload_id).abort(); } catch (_) {} }
      try { await env.BUCKET.delete(id); } catch (_) {}
      await d.run(`DELETE FROM files WHERE id=?`, id);
      const { ip, geo } = clientInfo(request);
      await logActivity(env, 'delete', { role: 'admin', ip, geo, detail: `force-removed ${f ? f.name : id}` });
      return json({ ok: true });
    }

    if (p === '/admin/tickets' && m === 'GET') {
      const rows = await d.all(`SELECT * FROM tickets ORDER BY (status='open') DESC, created_at DESC`);
      return json({ tickets: rows });
    }

    const tix = p.match(/^\/admin\/tickets\/([^/]+)\/(resolve|dismiss)$/);
    if (tix && m === 'POST') {
      const [, id, action] = tix;
      const { note, deleteFileId } = await body(request);
      if (action === 'resolve' && deleteFileId) {
        try { await env.BUCKET.delete(String(deleteFileId)); } catch (_) {}
        await d.run(`DELETE FROM files WHERE id=?`, String(deleteFileId));
      }
      await d.run(`UPDATE tickets SET status=?, resolved_at=?, resolution=? WHERE id=?`,
        action === 'resolve' ? 'resolved' : 'dismissed', nowISO(), String(note || ''), id);
      return json({ ok: true });
    }
  }

  return json({ error: 'not_found', path: p, method: m }, 404);
}

function decorate(r) {
  return { ...r, sizeHuman: humanSize(r.size), link: `/dl/${r.id}` };
}

// ---------- download (range-aware) ----------
async function download(request, env, fileId) {
  const d = db(env);
  const f = await d.get(`SELECT * FROM files WHERE id=?`, fileId);
  if (!f || f.status !== 'ready') return new Response('Not found', { status: 404 });

  if (f.permission !== 'everyone') {
    const s = await readSession(env, request);
    if (!s || !(s.role === 'admin' || s.role === 'staff')) {
      return new Response('This file is staff-only. Enter a staff key first.', { status: 403 });
    }
  }

  const rangeHeader = request.headers.get('Range');
  const obj = await env.BUCKET.get(fileId, rangeHeader ? { range: request.headers } : undefined);
  if (!obj) return new Response('Gone', { status: 404 });

  const headers = new Headers();
  if (obj.writeHttpMetadata) obj.writeHttpMetadata(headers);
  headers.set('Content-Type', f.content_type || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name).replace(/%20/g, ' ')}"`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=0');

  // best-effort download counter
  try { await d.run(`UPDATE files SET downloads=downloads+1 WHERE id=?`, fileId); } catch (_) {}

  if (obj.range && rangeHeader) {
    const off = obj.range.offset || 0;
    const len = (obj.range.length != null) ? obj.range.length : (f.size - off);
    headers.set('Content-Range', `bytes ${off}-${off + len - 1}/${f.size}`);
    headers.set('Content-Length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(f.size));
  return new Response(obj.body, { status: 200, headers });
}
