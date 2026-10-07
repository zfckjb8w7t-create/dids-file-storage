// Small helpers shared across the Worker.

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function uuid() {
  return crypto.randomUUID();
}

export function nowISO() {
  return new Date().toISOString();
}

// hex-encoded SHA-256 of a string
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// random url-safe token
export function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Generate a fresh plaintext key for a role: dids_<RK|SK|PK>_<hex>
export function newPlainKey(role) {
  const tag = role === 'admin' ? 'AK' : role === 'staff' ? 'SK' : 'PK';
  return `dids_${tag}_${randomToken(16)}`;
}

// constant-time-ish string compare
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Pull client IP + geo from the Cloudflare request.
export function clientInfo(request) {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    request.headers.get('X-Real-IP') ||
    'unknown';
  const cf = request.cf || {};
  const parts = [cf.city, cf.region, cf.country].filter(Boolean);
  const geo = parts.length ? parts.join(', ') : (cf.country || 'unknown');
  return { ip, geo };
}

export function humanSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// Cookie helpers
export function parseCookies(request) {
  const h = request.headers.get('Cookie') || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function cookieHeader(name, value, { maxAge = 60 * 60 * 12, clear = false } = {}) {
  const attrs = [
    `${name}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    clear ? 'Max-Age=0' : `Max-Age=${maxAge}`,
  ];
  return attrs.join('; ');
}
