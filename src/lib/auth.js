// Keys, device-lock, signed sessions, and the activity log.

import { db } from './db.js';
import { json, uuid, nowISO, sha256Hex, safeEqual, clientInfo, parseCookies, cookieHeader } from './util.js';

const SESSION_COOKIE = 'dids_sess';
const SESSION_TTL = 60 * 60 * 12; // 12h

// LOCK_MODE: 'hwid' (default, practical) or 'hwid+ip' (strict — may lock out
// users on dynamic IPs). Set as a Worker var in wrangler.toml to override.
function lockMode(env) {
  return (env.LOCK_MODE === 'hwid+ip') ? 'hwid+ip' : 'hwid';
}

export async function logActivity(env, event, { keyId, role, ip, geo, hwid, detail } = {}) {
  try {
    await db(env).run(
      `INSERT INTO activity (id, ts, event, key_id, role, ip, geo, hwid, detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      uuid(), nowISO(), event, keyId || null, role || null, ip || null, geo || null, hwid || null,
      detail == null ? null : String(detail)
    );
  } catch (_) { /* logging must never break a request */ }
}

// ---- Sessions (HMAC-signed cookie, no server storage needed) ----

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || 'dev-insecure-secret-change-me';
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function makeSession(env, payload) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL };
  const data = b64url(new TextEncoder().encode(JSON.stringify(body)));
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function readSession(env, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  try {
    const key = await hmacKey(env);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), new TextEncoder().encode(data));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(data)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload; // { keyId, role, hwid }
  } catch (_) { return null; }
}

export function sessionSetCookie(token) {
  return { 'Set-Cookie': cookieHeader(SESSION_COOKIE, token, { maxAge: SESSION_TTL }) };
}
export function sessionClearCookie() {
  return { 'Set-Cookie': cookieHeader(SESSION_COOKIE, '', { clear: true }) };
}

// Require a session with one of the allowed roles. Returns payload or throws a Response.
export async function requireRole(env, request, roles) {
  const s = await readSession(env, request);
  if (!s || !roles.includes(s.role)) {
    throw json({ error: 'unauthorized' }, 401);
  }
  return s;
}

// ---- Key entry + device lock ----
// Returns { ok, role, keyId } or { locked:true } or { invalid:true }.
export async function enterKey(env, request, plainKey, hwid, fp) {
  const { ip, geo } = clientInfo(request);
  const d = db(env);

  // 1) Bootstrap admin key from secret (always works, not device-locked).
  if (env.ADMIN_KEY && safeEqual(plainKey, env.ADMIN_KEY)) {
    await logActivity(env, 'key_enter', { keyId: 'ADMIN_ENV', role: 'admin', ip, geo, hwid, detail: 'env admin key' });
    return { ok: true, role: 'admin', keyId: 'ADMIN_ENV', hwid };
  }

  // 2) Look up a DB key by hash.
  const hash = await sha256Hex(plainKey);
  const row = await d.get(`SELECT * FROM keys WHERE key_hash = ?`, hash);
  if (!row) {
    await logActivity(env, 'login_fail', { ip, geo, hwid, detail: 'bad key' });
    return { invalid: true };
  }
  if (row.status !== 'active') {
    await logActivity(env, 'login_fail', { keyId: row.id, role: row.role, ip, geo, hwid, detail: 'revoked key' });
    return { invalid: true, revoked: true };
  }

  const mode = lockMode(env);
  if (!row.bound_hwid) {
    // First use — bind this device/network to the key.
    await d.run(
      `UPDATE keys SET bound_hwid=?, bound_fp=?, bound_ip=?, bound_geo=?, bound_at=?,
         last_ip=?, last_geo=?, last_seen=? WHERE id=?`,
      hwid, fp || null, ip, geo, nowISO(), ip, geo, nowISO(), row.id
    );
    await logActivity(env, 'key_enter', { keyId: row.id, role: row.role, ip, geo, hwid, detail: 'first bind' });
    return { ok: true, role: row.role, keyId: row.id, hwid };
  }

  // Already bound — enforce the lock.
  const hwidOk = safeEqual(String(row.bound_hwid), String(hwid || ''));
  const ipOk = row.bound_ip === ip;
  const pass = mode === 'hwid+ip' ? (hwidOk && ipOk) : hwidOk;
  if (!pass) {
    await logActivity(env, 'key_locked', { keyId: row.id, role: row.role, ip, geo, hwid,
      detail: `lock mismatch (mode=${mode}, boundIp=${row.bound_ip}, boundGeo=${row.bound_geo})` });
    return { locked: true };
  }

  await d.run(`UPDATE keys SET last_ip=?, last_geo=?, last_seen=? WHERE id=?`, ip, geo, nowISO(), row.id);
  await logActivity(env, 'key_enter', { keyId: row.id, role: row.role, ip, geo, hwid, detail: 'ok' });
  return { ok: true, role: row.role, keyId: row.id, hwid };
}
