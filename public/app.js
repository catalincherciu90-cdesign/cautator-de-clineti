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
    if (btn.dataset.tab === 'registru' && !$('#reg-judet').dataset.loaded) {
      $('#reg-judet').dataset.loaded = '1';
      loadJudete();
    }
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

/* ---------- Registrul firmelor (date oficiale MF) ---------- */

let regPage = 0;

async function loadJudete() {
  try {
    const res = await fetch('/api/registru/judete');
    const data = await res.json();
    const sel = $('#reg-judet');
    for (const j of data.judete || []) {
      const opt = document.createElement('option');
      opt.value = j;
      opt.textContent = j;
      sel.appendChild(opt);
    }
  } catch { /* fără județe */ }
}

const CAEN_TO_INDUSTRIE = [
  ['4321', 'Instalații electrice'],
  ['4322', 'Instalații sanitare'],
  ['4331', 'Zugrăveli & vopsitorii'],
  ['4332', 'Tâmplărie & ferestre'],
  ['4333', 'Pardoseli & parchet'],
  ['4334', 'Zugrăveli & vopsitorii'],
  ['4339', 'Amenajări interioare & finisaje'],
  ['4391', 'Acoperișuri'],
  ['431', 'Demolări & terasamente'],
  ['41', 'Construcții generale'],
  ['42', 'Infrastructură & drumuri'],
  ['43', 'Construcții generale'],
];

function caenToIndustrie(caen) {
  for (const [prefix, ind] of CAEN_TO_INDUSTRIE) {
    if ((caen || '').startsWith(prefix)) return ind;
  }
  return 'Construcții generale';
}

function lei(n) {
  if (n == null) return null;
  return new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 }).format(n) + ' lei';
}

$('#reg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  regPage = 0;
  $('#reg-list').innerHTML = '';
  searchRegistru();
});

$('#reg-more').addEventListener('click', () => {
  regPage += 1;
  searchRegistru();
});

async function searchRegistru() {
  const statusEl = $('#reg-status');
  const listEl = $('#reg-list');
  const btn = $('#reg-btn');
  btn.disabled = true;
  setStatus(statusEl, 'Caut în registru…');

  const params = new URLSearchParams();
  if ($('#reg-judet').value) params.set('judet', $('#reg-judet').value);
  if ($('#reg-localitate').value.trim()) params.set('localitate', $('#reg-localitate').value.trim());
  if ($('#reg-caen').value) params.set('caen', $('#reg-caen').value);
  if ($('#reg-min-ang').value) params.set('min_angajati', $('#reg-min-ang').value);
  if ($('#reg-min-ca').value) params.set('min_ca', $('#reg-min-ca').value);
  if ($('#reg-q').value.trim()) params.set('q', $('#reg-q').value.trim());
  params.set('page', regPage);

  try {
    const res = await fetch('/api/registru?' + params.toString());
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (!data.firme.length && regPage === 0) {
      setStatus(statusEl, 'Nicio firmă găsită cu aceste filtre.');
      $('#reg-more').style.display = 'none';
      return;
    }
    setStatus(statusEl, data.total + ' firme în registru (sortate după cifra de afaceri)', 'success');
    listEl.insertAdjacentHTML('beforeend', data.firme.map(renderRegCard).join(''));
    $('#reg-more').style.display =
      (regPage + 1) * data.per_pagina < data.total ? 'inline-block' : 'none';
  } catch (err) {
    setStatus(statusEl, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderRegCard(f) {
  const firm = {
    osm_id: 'cui/' + f.cui,
    nume: f.denumire,
    cui: String(f.cui),
    oras: f.localitate || null,
    adresa: f.adresa || null,
    industrie: caenToIndustrie(f.caen),
    notite:
      'CAEN ' + (f.caen || '?') + ' (' + (f.caen_den || '') + ')' +
      (f.cifra_afaceri != null ? ' · CA ' + lei(f.cifra_afaceri) : '') +
      (f.angajati != null ? ' · ' + f.angajati + ' angajați' : '') +
      (f.an ? ' (bilanț ' + f.an + ')' : ''),
  };
  const saved = savedOsmIds.has(firm.osm_id);
  return `
  <div class="card">
    <h3>${esc(f.denumire)}</h3>
    <span class="tip">${esc(f.caen_den || 'Construcții')} · CAEN ${esc(f.caen || '?')}</span>
    <div class="detail">🆔 CUI ${esc(f.cui)}</div>
    ${f.localitate || f.judet ? `<div class="detail">🏙️ ${esc([f.localitate, f.judet].filter(Boolean).join(', '))}</div>` : ''}
    <div class="fin">
      ${f.cifra_afaceri != null ? `<span>💰 ${esc(lei(f.cifra_afaceri))}</span>` : ''}
      ${f.profit != null ? `<span>📈 profit ${esc(lei(f.profit))}</span>` : ''}
      ${f.angajati != null ? `<span>👷 ${esc(f.angajati)} angajați</span>` : ''}
    </div>
    <div class="actions">
      <button class="btn-sm btn-save${saved ? ' saved' : ''}" ${saved ? 'disabled' : ''}
        onclick='saveFromSearch(this, ${JSON.stringify(firm).replace(/'/g, '&#39;')})'>
        ${saved ? '✓ Salvată' : '💾 Salvează'}
      </button>
    </div>
  </div>`;
}

/* ---------- Verificare ANAF ---------- */

async function verifyAnaf(id, btn) {
  btn.disabled = true;
  btn.textContent = '… ANAF';
  try {
    const res = await fetch('/api/firms/' + id + '/anaf', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verificarea a eșuat');
    alert(
      'Verificare ANAF reușită:\n\n' +
        (data.denumire || '') + '\n' +
        'Status: ' + (data.inactiva ? '⚠️ INACTIVĂ fiscal' : '✓ activă') + '\n' +
        'TVA: ' + (data.platitor_tva ? 'plătitor' : 'neplătitor') + '\n' +
        (data.telefon ? 'Telefon: ' + data.telefon + '\n' : '') +
        (data.adresa ? 'Adresă: ' + data.adresa : '')
    );
    loadSaved();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '🏛️ ANAF';
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
    ${f.cui ? `<div class="detail">🆔 CUI ${esc(f.cui)}</div>` : ''}
    <div class="detail">Sursă: ${esc(f.sursa)} · ${esc((f.creat_la || '').slice(0, 10))}</div>
    <div class="actions">
      <select class="status-select" onchange="changeStatus(${f.id}, this.value)">${options}</select>
      ${f.cui ? `<button class="btn-sm btn-anaf" onclick="verifyAnaf(${f.id}, this)">🏛️ ANAF</button>` : ''}
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
    cui: $('#add-cui').value.trim() || null,
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
