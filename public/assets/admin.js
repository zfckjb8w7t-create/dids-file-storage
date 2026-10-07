(async function () {
  const role = await Dids.guard(['admin']);
  if (!role) return;
  document.getElementById('logout').addEventListener('click', Dids.logout);
  const E = Dids.esc, D = Dids.fmtDate;

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    ['tickets', 'uploads', 'keys', 'folders', 'activity'].forEach((n) =>
      document.getElementById('tab-' + n).classList.toggle('hidden', n !== t.dataset.tab));
    loaders[t.dataset.tab] && loaders[t.dataset.tab]();
  }));

  async function overview() {
    const r = await Dids.api('/api/admin/overview');
    const o = r.data;
    document.getElementById('stats').innerHTML = `
      <div class="stat"><span>Stored files</span><b>${o.files || 0}</b></div>
      <div class="stat"><span>Total size</span><b>${E(o.bytesHuman || '0 B')}</b></div>
      <div class="stat"><span>Open tickets · Active keys</span><b>${o.openTickets || 0} · ${o.activeKeys || 0}</b></div>`;
  }

  async function tickets() {
    const body = document.getElementById('tix');
    const r = await Dids.api('/api/admin/tickets');
    const list = r.data.tickets || [];
    if (!list.length) { body.innerHTML = '<tr><td colspan="7" class="empty">No tickets.</td></tr>'; return; }
    body.innerHTML = list.map((t) => `
      <tr>
        <td class="nowrap small muted">${D(t.created_at)}</td>
        <td style="max-width:220px;word-break:break-all"><a href="${E(t.file_link)}" target="_blank">${E(t.file_link)}</a></td>
        <td style="max-width:240px">${E(t.reason)}</td>
        <td class="nowrap">${E(t.discord)}</td>
        <td class="nowrap small muted">${E(t.requester_geo || '—')}<br>${E(t.requester_ip || '')}</td>
        <td><span class="tag ${t.status === 'open' ? 'open' : ''}">${t.status}</span></td>
        <td class="right nowrap">${t.status === 'open' ? `
          <button class="sm ok res" data-id="${t.id}" data-link="${E(t.file_link)}">Resolve</button>
          <button class="sm ghost dis" data-id="${t.id}">Dismiss</button>` : E(t.resolution || '')}</td>
      </tr>`).join('');
    body.querySelectorAll('.res').forEach((b) => b.onclick = () => resolveTicket(b.dataset.id, b.dataset.link));
    body.querySelectorAll('.dis').forEach((b) => b.onclick = async () => {
      await Dids.api(`/api/admin/tickets/${b.dataset.id}/dismiss`, { method: 'POST', body: '{}' });
      Dids.toast('Dismissed'); tickets(); overview();
    });
  }

  function resolveTicket(id, link) {
    const m = Dids.modal(`
      <h2>Resolve ticket</h2>
      <p class="small muted">File link:<br><span class="mono" style="word-break:break-all">${E(link)}</span></p>
      <label>Also delete the file this links to?</label>
      <p class="small muted">If the link looks like <span class="mono">/dl/&lt;id&gt;</span> we’ll pull the id automatically. Leave blank to just close the ticket.</p>
      <input id="fid" placeholder="file id (optional)" value="${E(extractId(link))}">
      <label>Resolution note</label><input id="note" placeholder="e.g. removed, duplicate, ignored">
      <div class="btnrow" style="margin-top:16px">
        <button class="danger" id="del">Delete file + resolve</button>
        <button class="ok" id="close">Resolve only</button>
        <button class="ghost" id="cancel">Cancel</button></div>`);
    m.el.querySelector('#cancel').onclick = m.close;
    const go = async (withDelete) => {
      const note = m.el.querySelector('#note').value;
      const deleteFileId = withDelete ? (m.el.querySelector('#fid').value.trim() || null) : null;
      await Dids.api(`/api/admin/tickets/${id}/resolve`, { method: 'POST', body: JSON.stringify({ note, deleteFileId }) });
      Dids.toast('Ticket resolved', 'ok'); m.close(); tickets(); uploads(); overview();
    };
    m.el.querySelector('#del').onclick = () => go(true);
    m.el.querySelector('#close').onclick = () => go(false);
  }
  function extractId(link) { const m = String(link || '').match(/\/dl\/([a-f0-9-]{10,})/i); return m ? m[1] : ''; }

  async function uploads() {
    const body = document.getElementById('ups');
    const r = await Dids.api('/api/admin/uploads');
    const list = r.data.uploads || [];
    if (!list.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No uploads.</td></tr>'; return; }
    body.innerHTML = list.map((u) => `
      <tr>
        <td>${E(u.name)} ${u.status !== 'ready' ? '<span class="tag">'+u.status+'</span>' : ''}</td>
        <td><span class="tag ${u.permission}">${u.permission}</span></td>
        <td class="nowrap">${E(u.sizeHuman)}</td>
        <td class="muted">${E(u.folder || '—')}</td>
        <td class="small">${E(u.uploader.label || u.uploader.role || '—')}<br><span class="muted">${E((u.uploader.key||'').slice(0,8))}</span></td>
        <td class="small muted">${E(u.uploader.hwid ? u.uploader.hwid.slice(0,10) : '—')}<br>${E(u.uploader.ip || '')}<br>${E(u.uploader.geo || '')}</td>
        <td class="nowrap small muted">${D(u.created_at)}</td>
        <td class="right nowrap">
          <a class="btn sm" href="/dl/${u.id}">Get</a>
          <button class="sm danger nuke" data-id="${u.id}" data-name="${E(u.name)}">Force remove</button></td>
      </tr>`).join('');
    body.querySelectorAll('.nuke').forEach((b) => b.onclick = async () => {
      if (!confirm('Force remove "' + b.dataset.name + '"? This deletes it from storage permanently.')) return;
      await Dids.api('/api/admin/files/' + b.dataset.id, { method: 'DELETE' });
      Dids.toast('Removed', 'ok'); uploads(); overview();
    });
  }

  async function keys() {
    const body = document.getElementById('keys');
    const r = await Dids.api('/api/admin/keys');
    const list = r.data.keys || [];
    if (!list.length) { body.innerHTML = '<tr><td colspan="7" class="empty">No keys yet — generate one.</td></tr>'; return; }
    body.innerHTML = list.map((k) => `
      <tr>
        <td>${E(k.label || '—')}</td>
        <td><span class="tag ${k.role}">${k.role}</span></td>
        <td class="mono small">${E(k.key_prefix)}…</td>
        <td><span class="tag ${k.status === 'revoked' ? 'revoked' : ''}">${k.status}</span></td>
        <td class="small muted">${k.bound ? `${E(k.bound_geo||'?')}<br>${E(k.bound_ip||'')}<br><span class="mono">${E((k.bound_hwid||'').slice(0,12))}</span>` : '<span class="muted">unbound</span>'}</td>
        <td class="small muted nowrap">${k.last_seen ? D(k.last_seen) : '—'}</td>
        <td class="right nowrap">
          ${k.status === 'active'
            ? `<button class="sm ghost rev" data-id="${k.id}">Revoke</button>`
            : `<button class="sm ok rst" data-id="${k.id}">Restore</button>`}
          ${k.bound ? `<button class="sm ghost reset" data-id="${k.id}">Reset device</button>` : ''}
        </td>
      </tr>`).join('');
    const act = async (id, action, msg) => { await Dids.api(`/api/admin/keys/${id}/${action}`, { method: 'POST', body: '{}' }); Dids.toast(msg, 'ok'); keys(); overview(); };
    body.querySelectorAll('.rev').forEach((b) => b.onclick = () => act(b.dataset.id, 'revoke', 'Key revoked'));
    body.querySelectorAll('.rst').forEach((b) => b.onclick = () => act(b.dataset.id, 'restore', 'Key restored'));
    body.querySelectorAll('.reset').forEach((b) => b.onclick = () => act(b.dataset.id, 'reset-device', 'Device lock cleared'));
  }

  document.getElementById('genkey').addEventListener('click', () => {
    const m = Dids.modal(`
      <h2>Generate key</h2>
      <label>Role</label>
      <select id="role"><option value="staff">Staff (private page)</option><option value="public">Public (public downloads)</option><option value="admin">Admin</option></select>
      <label>Label (who is this for?)</label><input id="label" placeholder="e.g. John — staff">
      <div class="btnrow" style="margin-top:16px"><button id="ok">Generate</button><button class="ghost" id="cancel">Cancel</button></div>`);
    m.el.querySelector('#cancel').onclick = m.close;
    m.el.querySelector('#ok').onclick = async () => {
      const r = await Dids.api('/api/admin/keys', { method: 'POST', body: JSON.stringify({
        role: m.el.querySelector('#role').value, label: m.el.querySelector('#label').value }) });
      if (!r.ok) { Dids.toast('Failed', 'err'); return; }
      m.close();
      const r2 = Dids.modal(`
        <h2>New key created</h2>
        <p class="small muted">Copy it now — it is hashed in storage and <b>cannot be shown again</b>.</p>
        <div class="keyreveal mono" id="kv">${E(r.data.key)}</div>
        <div class="btnrow"><button class="ok" id="copy">Copy</button><button class="ghost" id="done">Done</button></div>`);
      r2.el.querySelector('#copy').onclick = () => { navigator.clipboard?.writeText(r.data.key); Dids.toast('Copied', 'ok'); };
      r2.el.querySelector('#done').onclick = () => { r2.close(); keys(); overview(); };
    };
  });

  async function folders() {
    const body = document.getElementById('folders');
    const r = await Dids.api('/api/folders');
    const list = r.data.folders || [];
    body.innerHTML = list.length ? list.map((f) => `
      <tr><td>${E(f.name)}</td><td><span class="tag ${f.permission}">${f.permission}</span></td>
      <td class="small muted">${D(f.created_at)}</td><td class="small muted">${E((f.created_by||'').slice(0,8))}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No folders.</td></tr>';
  }
  document.getElementById('genfolder').addEventListener('click', () => {
    const m = Dids.modal(`
      <h2>New folder</h2><label>Name</label><input id="fn" placeholder="e.g. Builds">
      <label>Permission</label><select id="fp"><option value="staff">Staff Only</option><option value="everyone">Everyone (public)</option></select>
      <div class="btnrow" style="margin-top:16px"><button id="ok">Create</button><button class="ghost" id="cancel">Cancel</button></div>`);
    m.el.querySelector('#cancel').onclick = m.close;
    m.el.querySelector('#ok').onclick = async () => {
      const name = m.el.querySelector('#fn').value.trim(); if (!name) return;
      const r = await Dids.api('/api/folders', { method: 'POST', body: JSON.stringify({ name, permission: m.el.querySelector('#fp').value }) });
      if (r.ok) { Dids.toast('Folder created', 'ok'); m.close(); folders(); } else Dids.toast('Failed', 'err');
    };
  });

  async function activity() {
    const body = document.getElementById('act');
    const r = await Dids.api('/api/admin/activity');
    const list = r.data.activity || [];
    if (!list.length) { body.innerHTML = '<tr><td colspan="7" class="empty">No activity.</td></tr>'; return; }
    const color = { key_locked: 'var(--danger)', login_fail: 'var(--warn)', delete: 'var(--danger)', upload: 'var(--green)' };
    body.innerHTML = list.map((a) => `
      <tr>
        <td class="nowrap small muted">${D(a.ts)}</td>
        <td><span class="mono small" style="color:${color[a.event] || 'var(--txt)'}">${E(a.event)}</span></td>
        <td class="small">${E(a.role || '—')}</td>
        <td class="small muted">${E(a.ip || '—')}</td>
        <td class="small muted">${E(a.geo || '—')}</td>
        <td class="small muted mono">${E((a.hwid || '').slice(0, 10) || '—')}</td>
        <td class="small">${E(a.detail || '')}</td>
      </tr>`).join('');
  }

  const loaders = { tickets, uploads, keys, folders, activity };
  await overview();
  await tickets();
})();
