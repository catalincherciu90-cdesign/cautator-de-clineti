/**
 * Căutător Firme de Construcții
 * API: /api/search (OpenStreetMap), /api/firms (CRUD pe D1)
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const USER_AGENT = 'CautatorFirmeConstructii/1.0 (Cloudflare Worker)';

// Tag-uri OSM relevante pentru domeniul construcțiilor
const CRAFT_REGEX =
  'builder|roofer|plumber|electrician|carpenter|painter|plasterer|tiler|hvac|scaffolder|floorer|insulation|mason|window_construction';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/search' && request.method === 'GET') {
        return await handleSearch(url);
      }
      if (pathname === '/api/firms' && request.method === 'GET') {
        return await listFirms(env, url);
      }
      if (pathname === '/api/firms' && request.method === 'POST') {
        return await createFirm(env, request);
      }
      const firmMatch = pathname.match(/^\/api\/firms\/(\d+)$/);
      if (firmMatch && request.method === 'PUT') {
        return await updateFirm(env, request, Number(firmMatch[1]));
      }
      if (firmMatch && request.method === 'DELETE') {
        return await deleteFirm(env, Number(firmMatch[1]));
      }
      if (pathname.startsWith('/api/')) {
        return json({ error: 'Ruta nu există' }, 404);
      }
    } catch (err) {
      return json({ error: 'Eroare internă: ' + err.message }, 500);
    }

    // Restul cererilor merg către fișierele statice
    return env.ASSETS.fetch(request);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/* ---------- Căutare în OpenStreetMap ---------- */

async function handleSearch(url) {
  const city = (url.searchParams.get('city') || '').trim();
  const query = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!city) return json({ error: 'Parametrul "city" este obligatoriu' }, 400);

  // 1. Geocodăm orașul cu Nominatim ca să obținem bounding box-ul
  const geoRes = await fetch(
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
      encodeURIComponent(city + ', România'),
    { headers: { 'User-Agent': USER_AGENT } }
  );
  if (!geoRes.ok) return json({ error: 'Geocodarea orașului a eșuat' }, 502);
  const geo = await geoRes.json();
  if (!geo.length) return json({ error: `Orașul „${city}" nu a fost găsit` }, 404);

  const [south, north, west, east] = geo[0].boundingbox.map(Number);
  const bbox = `${south},${west},${north},${east}`;

  // 2. Căutăm firme de construcții în zona respectivă cu Overpass
  const overpassQuery = `
[out:json][timeout:25];
(
  nwr["office"="construction_company"](${bbox});
  nwr["craft"~"${CRAFT_REGEX}"](${bbox});
  nwr["shop"="trade"]["trade"~"building|construction"](${bbox});
);
out center tags 200;`;

  const opRes = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(overpassQuery),
  });
  if (!opRes.ok) return json({ error: 'Căutarea Overpass a eșuat, reîncearcă' }, 502);
  const data = await opRes.json();

  let results = (data.elements || [])
    .filter((el) => el.tags && el.tags.name)
    .map((el) => {
      const t = el.tags;
      const adresa = [t['addr:street'], t['addr:housenumber'], t['addr:city']]
        .filter(Boolean)
        .join(' ');
      return {
        osm_id: `${el.type}/${el.id}`,
        nume: t.name,
        tip: t.office === 'construction_company' ? 'firmă construcții' : t.craft || t.shop || '',
        adresa: adresa || null,
        telefon: t.phone || t['contact:phone'] || null,
        email: t.email || t['contact:email'] || null,
        website: t.website || t['contact:website'] || null,
        oras: t['addr:city'] || geo[0].name || city,
      };
    });

  if (query) {
    results = results.filter(
      (r) => r.nume.toLowerCase().includes(query) || (r.tip || '').toLowerCase().includes(query)
    );
  }

  // Eliminăm duplicatele după nume
  const seen = new Set();
  results = results.filter((r) => {
    const key = r.nume.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return json({ oras: geo[0].display_name, total: results.length, rezultate: results });
}

/* ---------- CRUD firme salvate (D1) ---------- */

async function listFirms(env, url) {
  const status = url.searchParams.get('status');
  let stmt;
  if (status) {
    stmt = env.DB.prepare('SELECT * FROM firme WHERE status = ? ORDER BY creat_la DESC').bind(status);
  } else {
    stmt = env.DB.prepare('SELECT * FROM firme ORDER BY creat_la DESC');
  }
  const { results } = await stmt.all();
  return json({ total: results.length, firme: results });
}

async function createFirm(env, request) {
  const body = await request.json().catch(() => null);
  if (!body || !body.nume || !String(body.nume).trim()) {
    return json({ error: 'Câmpul "nume" este obligatoriu' }, 400);
  }

  if (body.osm_id) {
    const existing = await env.DB.prepare('SELECT id FROM firme WHERE osm_id = ?')
      .bind(body.osm_id)
      .first();
    if (existing) return json({ error: 'Firma este deja salvată', id: existing.id }, 409);
  }

  const result = await env.DB.prepare(
    `INSERT INTO firme (nume, oras, adresa, telefon, email, website, sursa, osm_id, notite)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      String(body.nume).trim(),
      body.oras || null,
      body.adresa || null,
      body.telefon || null,
      body.email || null,
      body.website || null,
      body.osm_id ? 'openstreetmap' : 'manual',
      body.osm_id || null,
      body.notite || null
    )
    .run();

  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

const ALLOWED_STATUS = ['nou', 'contactat', 'oferta_trimisa', 'client', 'respins'];

async function updateFirm(env, request, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Body JSON invalid' }, 400);
  if (body.status && !ALLOWED_STATUS.includes(body.status)) {
    return json({ error: 'Status invalid. Permise: ' + ALLOWED_STATUS.join(', ') }, 400);
  }

  const existing = await env.DB.prepare('SELECT * FROM firme WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'Firma nu există' }, 404);

  await env.DB.prepare(
    `UPDATE firme SET nume = ?, oras = ?, adresa = ?, telefon = ?, email = ?, website = ?, status = ?, notite = ?
     WHERE id = ?`
  )
    .bind(
      body.nume ?? existing.nume,
      body.oras ?? existing.oras,
      body.adresa ?? existing.adresa,
      body.telefon ?? existing.telefon,
      body.email ?? existing.email,
      body.website ?? existing.website,
      body.status ?? existing.status,
      body.notite ?? existing.notite,
      id
    )
    .run();

  return json({ ok: true });
}

async function deleteFirm(env, id) {
  const result = await env.DB.prepare('DELETE FROM firme WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return json({ error: 'Firma nu există' }, 404);
  return json({ ok: true });
}
