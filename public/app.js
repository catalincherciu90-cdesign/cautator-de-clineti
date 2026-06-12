/* Căutător Firme de Construcții — logica frontend */

const $ = (sel) => document.querySelector(sel);

const STATUS_LABELS = {
  nou: 'Nou',
  contactat: 'Contactat',
  oferta_trimisa: 'Ofertă trimisă',
  client: 'Client',
  respins: 'Respins',
};

let savedOsmIds = new Set();

/* ---------- Industrii (filtre) ---------- */

async function loadIndustries() {
  try {
    const res = await fetch('/api/industries');
    const data = await res.json();
    if (!res.ok) return;
    for (const selId of ['search-industry', 'filter-industry', 'add-industrie']) {
      const sel = document.getElementById(selId);
      for (const ind of data.industrii) {
        const opt = document.createElement('option');
        opt.value = ind;
        opt.textContent = ind;
        sel.appendChild(opt);
      }
    }
  } catch { /* fără filtre dacă apare o eroare */ }
}

/* ---------- Tab-uri ---------- */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'salvate') loadSaved();
  });
});

function setStatus(el, msg, type = '') {
  el.textContent = msg;
  el.className = 'status' + (type ? ' ' + type : '');
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

/* ---------- Căutare ---------- */

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const city = $('#search-city').value.trim();
  const q = $('#search-query').value.trim();
  const industrie = $('#search-industry').value;
  const btn = $('#search-btn');
  const statusEl = $('#search-status');
  const resultsEl = $('#search-results');

  btn.disabled = true;
  resultsEl.innerHTML = '';
  setStatus(statusEl, 'Caut firme de construcții în ' + city + '… (poate dura câteva secunde)');

  try {
    const res = await fetch(
      '/api/search?city=' + encodeURIComponent(city) +
        (q ? '&q=' + encodeURIComponent(q) : '') +
        (industrie ? '&industrie=' + encodeURIComponent(industrie) : '')
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Eroare la căutare');

    if (!data.rezultate.length) {
      setStatus(statusEl, 'Nu am găsit firme în zona căutată. Încearcă alt oraș sau fără filtru.');
      return;
    }
    let info = data.total + ' firme găsite în ' + data.oras;
    if (data.surse) {
      const parts = [];
      if (data.surse.google) parts.push('Google: ' + data.surse.google);
      if (data.surse.openstreetmap) parts.push('OpenStreetMap: ' + data.surse.openstreetmap);
      if (data.surse.ai) parts.push('AI: ' + data.surse.ai);
      if (parts.length) info += ' · ' + parts.join(', ');
    }
    setStatus(statusEl, info, 'success');
    resultsEl.innerHTML = data.rezultate.map(renderSearchCard).join('');
  } catch (err) {
    setStatus(statusEl, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function renderSearchCard(r) {
  const saved = savedOsmIds.has(r.osm_id);
  return `
  <div class="card">
    <h3>${esc(r.nume)}</h3>
    ${r.industrie ? `<span class="tip">${esc(r.industrie)}</span>` : ''}
    ${r.ai ? `<span class="ai-badge">🤖 Sugestie AI — verifică datele</span>` : ''}
    ${r.rating ? `<div class="detail">⭐ ${esc(r.rating)}${r.recenzii ? ' (' + esc(r.recenzii) + ' recenzii)' : ''}</div>` : ''}
    ${r.adresa ? `<div class="detail">📍 ${esc(r.adresa)}</div>` : ''}
    ${r.telefon ? `<div class="detail">📞 <a href="tel:${esc(r.telefon)}">${esc(r.telefon)}</a></div>` : ''}
    ${r.email ? `<div class="detail">✉️ <a href="mailto:${esc(r.email)}">${esc(r.email)}</a></div>` : ''}
    ${r.website ? `<div class="detail">🌐 <a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(r.website)}</a></div>` : ''}
    <div class="actions">
      <button class="btn-sm btn-save${saved ? ' saved' : ''}" ${saved ? 'disabled' : ''}
        onclick='saveFromSearch(this, ${JSON.stringify(r).replace(/'/g, '&#39;')})'>
        ${saved ? '✓ Salvată' : '💾 Salvează'}
      </button>
    </div>
  </div>`;
}

async function saveFromSearch(btn, firm) {
  btn.disabled = true;
  try {
    const res = await fetch('/api/firms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(firm),
    });
    const data = await res.json();
    if (res.status === 409 || res.ok) {
      savedOsmIds.add(firm.osm_id);
      btn.textContent = '✓ Salvată';
      btn.classList.add('saved');
      refreshCount();
    } else {
      throw new Error(data.error || 'Eroare la salvare');
    }
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
}

/* ---------- Firme salvate ---------- */

$('#filter-status').addEventListener('change', loadSaved);
$('#filter-industry').addEventListener('change', loadSaved);

async function loadSaved() {
  const listEl = $('#saved-list');
  const statusEl = $('#saved-status');
  const filter = $('#filter-status').value;
  const filterInd = $('#filter-industry').value;
  setStatus(statusEl, 'Se încarcă…');

  try {
    const params = new URLSearchParams();
    if (filter) params.set('status', filter);
    if (filterInd) params.set('industrie', filterInd);
    const qs = params.toString();
    const res = await fetch('/api/firms' + (qs ? '?' + qs : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Eroare la încărcare');

    savedOsmIds = new Set(data.firme.filter((f) => f.osm_id).map((f) => f.osm_id));
    const filtered = filter || filterInd;
    $('#count-badge').textContent = filtered ? data.total + '*' : data.total;

    if (!data.firme.length) {
      setStatus(statusEl, 'Nicio firmă salvată' + (filtered ? ' cu aceste filtre.' : ' încă. Caută și salvează firme din tab-ul Căutare.'));
      listEl.innerHTML = '';
      return;
    }
    setStatus(statusEl, data.total + ' firme', 'success');
    listEl.innerHTML = data.firme.map(renderSavedCard).join('');
  } catch (err) {
    setStatus(statusEl, err.message, 'error');
  }
}

function renderSavedCard(f) {
  const options = Object.entries(STATUS_LABELS)
    .map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`)
    .join('');
  return `
  <div class="card" data-id="${f.id}">
    <h3>${esc(f.nume)}</h3>
    <span class="status-pill status-${esc(f.status)}">${STATUS_LABELS[f.status] || esc(f.status)}</span>
    ${f.industrie ? `<span class="tip">${esc(f.industrie)}</span>` : ''}
    ${f.oras ? `<div class="detail">🏙️ ${esc(f.oras)}</div>` : ''}
    ${f.adresa ? `<div class="detail">📍 ${esc(f.adresa)}</div>` : ''}
    ${f.telefon ? `<div class="detail">📞 <a href="tel:${esc(f.telefon)}">${esc(f.telefon)}</a></div>` : ''}
    ${f.email ? `<div class="detail">✉️ <a href="mailto:${esc(f.email)}">${esc(f.email)}</a></div>` : ''}
    ${f.website ? `<div class="detail">🌐 <a href="${esc(f.website)}" target="_blank" rel="noopener">${esc(f.website)}</a></div>` : ''}
    ${f.notite ? `<div class="detail">📝 ${esc(f.notite)}</div>` : ''}
    <div class="detail">Sursă: ${esc(f.sursa)} · ${esc((f.creat_la || '').slice(0, 10))}</div>
    <div class="actions">
      <select class="status-select" onchange="changeStatus(${f.id}, this.value)">${options}</select>
      <button class="btn-sm btn-delete" onclick="deleteFirm(${f.id}, this)">🗑️ Șterge</button>
    </div>
  </div>`;
}

async function changeStatus(id, status) {
  try {
    const res = await fetch('/api/firms/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Eroare');
    loadSaved();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteFirm(id, btn) {
  if (!confirm('Sigur ștergi această firmă?')) return;
  btn.disabled = true;
  try {
    const res = await fetch('/api/firms/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'Eroare la ștergere');
    loadSaved();
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
}

/* ---------- Adăugare manuală ---------- */

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = $('#add-status');
  const body = {
    nume: $('#add-nume').value.trim(),
    industrie: $('#add-industrie').value || null,
    oras: $('#add-oras').value.trim() || null,
    adresa: $('#add-adresa').value.trim() || null,
    telefon: $('#add-telefon').value.trim() || null,
    email: $('#add-email').value.trim() || null,
    website: $('#add-website').value.trim() || null,
    notite: $('#add-notite').value.trim() || null,
  };
  try {
    const res = await fetch('/api/firms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Eroare la salvare');
    setStatus(statusEl, '✓ Firma „' + body.nume + '" a fost salvată!', 'success');
    e.target.reset();
    refreshCount();
  } catch (err) {
    setStatus(statusEl, err.message, 'error');
  }
});

/* ---------- Util ---------- */

async function refreshCount() {
  try {
    const res = await fetch('/api/firms');
    const data = await res.json();
    if (res.ok) $('#count-badge').textContent = data.total;
  } catch { /* ignorăm */ }
}

loadIndustries();
refreshCount();
