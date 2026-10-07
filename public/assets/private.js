(async function () {
  const role = await Dids.guard(['staff', 'admin']);
  if (!role) return;
  document.getElementById('whoami').textContent = role;
  document.getElementById('logout').addEventListener('click', Dids.logout);

  // tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    ['upload', 'downloads', 'removal'].forEach((n) =>
      document.getElementById('tab-' + n).classList.toggle('hidden', n !== t.dataset.tab));
    if (t.dataset.tab === 'downloads') loadDownloads();
  }));

  // ---- folders ----
  const folderSel = document.getElementById('folder');
  async function loadFolders() {
    const r = await Dids.api('/api/folders');
    const fs = r.data.folders || [];
    folderSel.innerHTML = '<option value="">(no folder / root)</option>' +
      fs.map((f) => `<option value="${f.id}">${Dids.esc(f.name)} · ${f.permission}</option>`).join('');
  }
  document.getElementById('newfolder').addEventListener('click', () => {
    const m = Dids.modal(`
      <h2>New folder</h2>
      <label>Name</label><input id="fn" placeholder="e.g. Builds">
      <label>Permission</label>
      <select id="fp"><option value="staff">Staff Only</option><option value="everyone">Everyone (public)</option></select>
      <div class="btnrow" style="margin-top:16px"><button id="fok">Create</button><button class="ghost" id="fcancel">Cancel</button></div>`);
    m.el.querySelector('#fcancel').onclick = m.close;
    m.el.querySelector('#fok').onclick = async () => {
      const name = m.el.querySelector('#fn').value.trim();
      const permission = m.el.querySelector('#fp').value;
      if (!name) return;
      const r = await Dids.api('/api/folders', { method: 'POST', body: JSON.stringify({ name, permission }) });
      if (r.ok) { Dids.toast('Folder created', 'ok'); m.close(); await loadFolders(); folderSel.value = r.data.id; }
      else Dids.toast('Could not create folder', 'err');
    };
  });
  await loadFolders();

  // ---- upload (chunked multipart) ----
  const queue = document.getElementById('queue');
  const fileInput = document.getElementById('file');
  const drop = document.getElementById('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); handle(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => handle(fileInput.files));

  function handle(list) {
    [...list].forEach(startUpload);
    fileInput.value = '';
  }

  async function putPart(fileId, part, blob, tries = 0) {
    try {
      const res = await fetch(`/api/uploads/part?fileId=${encodeURIComponent(fileId)}&part=${part}`, {
        method: 'PUT', credentials: 'same-origin', body: blob,
      });
      if (!res.ok) throw new Error('part ' + res.status);
      return await res.json();
    } catch (e) {
      if (tries < 3) { await new Promise((r) => setTimeout(r, 500 * (tries + 1))); return putPart(fileId, part, blob, tries + 1); }
      throw e;
    }
  }

  async function startUpload(file) {
    const row = document.createElement('div'); row.className = 'uprow';
    row.innerHTML = `<div class="nm" title="${Dids.esc(file.name)}">${Dids.esc(file.name)}</div>
      <div class="small muted nowrap" style="width:150px">
        <div class="pstat">queued…</div><div class="progress"><i></i></div>
      </div>`;
    queue.prepend(row);
    const bar = row.querySelector('.progress>i');
    const stat = row.querySelector('.pstat');
    const set = (pct, txt) => { bar.style.width = pct + '%'; stat.textContent = txt; };

    const permission = document.getElementById('perm').value;
    const folderId = folderSel.value || null;

    let created;
    try {
      const r = await Dids.api('/api/uploads/create', { method: 'POST', body: JSON.stringify({
        name: file.name, size: file.size, permission, folderId,
        contentType: file.type || 'application/octet-stream' }) });
      if (!r.ok) throw new Error(r.data.error || 'create failed');
      created = r.data;
    } catch (e) { set(0, '✗ ' + e.message); stat.style.color = 'var(--danger)'; return; }

    const { fileId, partSize, partCount } = created;
    const parts = [];
    try {
      for (let i = 0; i < partCount; i++) {
        const start = i * partSize;
        const blob = file.slice(start, Math.min(file.size, start + partSize));
        const up = await putPart(fileId, i + 1, blob);
        parts.push({ partNumber: up.partNumber, etag: up.etag });
        set(Math.round(((i + 1) / partCount) * 97), `uploading ${i + 1}/${partCount}`);
      }
      set(99, 'finalising…');
      const c = await Dids.api('/api/uploads/complete', { method: 'POST', body: JSON.stringify({ fileId, parts }) });
      if (!c.ok) throw new Error(c.data.error || 'complete failed');
      set(100, '✓ done'); stat.style.color = 'var(--green)';
      Dids.toast(file.name + ' uploaded', 'ok');
    } catch (e) {
      set(0, '✗ ' + e.message); stat.style.color = 'var(--danger)';
      try { await Dids.api('/api/uploads/abort', { method: 'POST', body: JSON.stringify({ fileId }) }); } catch (_) {}
    }
  }

  // ---- downloads ----
  async function loadDownloads() {
    const rows = document.getElementById('drows');
    rows.innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
    const r = await Dids.api('/api/files');
    const files = r.data.files || [];
    if (!files.length) { rows.innerHTML = '<tr><td colspan="7" class="empty">No files yet.</td></tr>'; return; }
    rows.innerHTML = files.map((f) => `
      <tr>
        <td>${Dids.esc(f.name)}</td>
        <td class="muted">${Dids.esc(f.folder || '—')}</td>
        <td><span class="tag ${f.permission}">${f.permission}</span></td>
        <td class="nowrap">${Dids.esc(f.sizeHuman)}</td>
        <td class="nowrap muted small">${Dids.fmtDate(f.created_at)}</td>
        <td class="right muted">${f.downloads || 0}</td>
        <td class="right nowrap">
          <a class="btn sm" href="${f.link}">Download</a>
          <button class="sm ghost copy" data-link="${f.link}">Copy link</button>
        </td>
      </tr>`).join('');
    rows.querySelectorAll('.copy').forEach((b) => b.onclick = () => {
      const url = location.origin + b.dataset.link;
      navigator.clipboard?.writeText(url); Dids.toast('Link copied', 'ok');
    });
  }

  // ---- removal ----
  document.getElementById('rq-send').addEventListener('click', async () => {
    const link = document.getElementById('rq-link').value.trim();
    const reason = document.getElementById('rq-reason').value.trim();
    const discord = document.getElementById('rq-discord').value.trim();
    if (!link || !reason || !discord) { Dids.toast('Fill in all fields', 'err'); return; }
    const r = await Dids.api('/api/tickets', { method: 'POST', body: JSON.stringify({ link, reason, discord }) });
    if (r.ok) { Dids.toast('Removal request submitted', 'ok');
      document.getElementById('rq-link').value = ''; document.getElementById('rq-reason').value = ''; document.getElementById('rq-discord').value = ''; }
    else Dids.toast('Could not submit (' + (r.data.error || r.status) + ')', 'err');
  });
})();
