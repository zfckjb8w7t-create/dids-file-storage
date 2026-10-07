// Shared client helpers: device identity, API wrapper, toasts, modals.
window.Dids = (function () {
  // -- persistent device token (approx "HWID" — browsers cannot read real hardware IDs) --
  function deviceToken() {
    try {
      let t = localStorage.getItem('dids_device');
      if (!t) { t = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem('dids_device', t); }
      return t;
    } catch (_) { return 'no-storage'; }
  }

  async function fingerprint() {
    const bits = [navigator.userAgent, navigator.language, (navigator.languages || []).join(','),
      screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
      new Date().getTimezoneOffset(), navigator.hardwareConcurrency || 0, navigator.deviceMemory || 0];
    try {
      const c = document.createElement('canvas'); const g = c.getContext('2d');
      g.textBaseline = 'top'; g.font = "14px 'Arial'"; g.fillStyle = '#f60'; g.fillRect(0, 0, 60, 20);
      g.fillStyle = '#069'; g.fillText('dids-fp', 2, 2); bits.push(c.toDataURL().slice(-64));
    } catch (_) {}
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) bits.push(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    } catch (_) {}
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bits.join('|')));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts });
    let data = null; try { data = await res.json(); } catch (_) {}
    return { status: res.status, ok: res.ok, data: data || {} };
  }

  async function enterKey(key) {
    const hwid = deviceToken();
    const fp = await fingerprint();
    const r = await api('/api/key/enter', { method: 'POST', body: JSON.stringify({ key, hwid, fp }) });
    if (r.status === 423) return { locked: true, message: r.data.message };
    if (!r.ok) return { error: r.data.error || 'invalid_key', revoked: r.data.revoked };
    return { ok: true, role: r.data.role, redirect: r.data.redirect };
  }

  async function me() { const r = await api('/api/me'); return r.data.role; }
  async function logout() { await api('/api/logout', { method: 'POST' }); location.href = '/'; }

  // -- toast --
  function toast(msg, kind = '') {
    let box = document.getElementById('toast');
    if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg;
    box.appendChild(t); setTimeout(() => t.remove(), 4200);
  }

  // -- modal --
  function modal(html) {
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="panel modal">${html}</div>`;
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
    document.body.appendChild(bg);
    return { el: bg, close: () => bg.remove() };
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(); }

  async function guard(roles) {
    const role = await me();
    if (!role || !roles.includes(role)) { location.href = '/'; return null; }
    return role;
  }

  return { deviceToken, fingerprint, api, enterKey, me, logout, toast, modal, esc, fmtDate, guard };
})();
