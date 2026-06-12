/**
 * Căutător Firme de Construcții
 * API: /api/search (OpenStreetMap), /api/firms (CRUD pe D1)
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const USER_AGENT = 'CautatorFirmeConstructii/1.0 (Cloudflare Worker)';

// Tag-uri OSM relevante pentru domeniul construcțiilor
const CRAFT_REGEX =
  'builder|roofer|plumber|electrician|carpenter|painter|plasterer|tiler|hvac|scaffolder|floorer|insulation|mason|window_construction';

// Cuvinte din numele firmelor românești de construcții (căutare după nume)
const NAME_REGEX =
  'construct|amenaj|instal|renov|zugrav|acoper|izola|finisaj|santier|şantier|beton|tamplarie|tâmplărie';

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/search' && request.method === 'GET') {
        return await handleSearch(url, env);
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

/* ---------- Căutare: Google Places + OpenStreetMap ---------- */

async function handleSearch(url, env) {
  const city = (url.searchParams.get('city') || '').trim();
  const query = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!city) return json({ error: 'Parametrul "city" este obligatoriu' }, 400);

  // Căutăm în paralel în ambele surse
  const [googleRes, osmRes] = await Promise.allSettled([
    env.GOOGLE_PLACES_API_KEY
      ? searchGoogle(city, query, env.GOOGLE_PLACES_API_KEY)
      : Promise.resolve([]),
    searchOsm(city, query),
  ]);

  const google = googleRes.status === 'fulfilled' ? googleRes.value : [];
  const osm = osmRes.status === 'fulfilled' && osmRes.value ? osmRes.value : null;

  if (!google.length && !osm) {
    return json({ error: 'Serviciile de căutare nu au răspuns. Reîncearcă în câteva secunde.' }, 502);
  }

  // Combinăm: Google primul (date mai bogate), apoi OSM, fără duplicate după nume
  const seen = new Set();
  const results = [];
  for (const r of [...google, ...(osm ? osm.results : [])]) {
    const key = r.nume.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(r);
  }

  return json({
    oras: (osm && osm.display_name) || city,
    surse: { google: google.length, openstreetmap: osm ? osm.results.length : 0 },
    total: results.length,
    rezultate: results,
  });
}

/** Căutare prin Google Places API (Text Search, max 60 de rezultate). */
async function searchGoogle(city, query, apiKey) {
  const textQuery = (query ? query + ' ' : '') + 'firme de construcții în ' + city + ', România';
  const results = [];
  let pageToken = null;

  for (let page = 0; page < 3; page++) {
    const body = { textQuery, languageCode: 'ro', regionCode: 'RO', pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'nextPageToken,places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.primaryTypeDisplayName',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const data = await res.json();

    for (const p of data.places || []) {
      results.push({
        osm_id: 'google/' + p.id,
        nume: (p.displayName && p.displayName.text) || 'Fără nume',
        tip: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || 'construcții',
        adresa: p.formattedAddress || null,
        telefon: p.nationalPhoneNumber || null,
        email: null,
        website: p.websiteUri || null,
        oras: city,
        rating: p.rating || null,
        recenzii: p.userRatingCount || null,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return results;
}

/** Căutare în OpenStreetMap (geocodare + Overpass). Returnează null la eșec. */
async function searchOsm(city, query) {
  const geo = await geocodeCity(city);
  if (!geo) return null;

  const bbox = `${geo.south},${geo.west},${geo.north},${geo.east}`;

  // 2. Căutăm firme de construcții în zonă: după categorie ȘI după nume
  const overpassQuery = `
[out:json][timeout:30];
(
  nwr["office"="construction_company"](${bbox});
  nwr["craft"~"${CRAFT_REGEX}"](${bbox});
  nwr["shop"="trade"]["trade"~"building|construction"](${bbox});
  nwr["name"~"${NAME_REGEX}",i]["office"](${bbox});
  nwr["name"~"${NAME_REGEX}",i]["shop"](${bbox});
  nwr["name"~"${NAME_REGEX}",i]["craft"](${bbox});
  nwr["name"~"${NAME_REGEX}",i]["building"~"commercial|industrial|office|warehouse"](${bbox});
  nwr["name"~"${NAME_REGEX}",i]["landuse"="industrial"](${bbox});
);
out center tags 300;`;

  const data = await runOverpass(overpassQuery);
  if (!data) return null;

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
        tip: t.office === 'construction_company' ? 'firmă construcții' : t.craft || t.shop || t.office || 'construcții',
        adresa: adresa || null,
        telefon: t.phone || t['contact:phone'] || null,
        email: t.email || t['contact:email'] || null,
        website: t.website || t['contact:website'] || null,
        oras: t['addr:city'] || geo.name || city,
      };
    });

  if (query) {
    results = results.filter(
      (r) => r.nume.toLowerCase().includes(query) || (r.tip || '').toLowerCase().includes(query)
    );
  }

  return { display_name: geo.display_name, results };
}

/** Geocodare cu două servicii: Nominatim, apoi Photon ca rezervă. */
async function geocodeCity(city) {
  try {
    const res = await fetch(
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
        encodeURIComponent(city + ', România'),
      { headers: { 'User-Agent': USER_AGENT } }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.length) {
        const [south, north, west, east] = data[0].boundingbox.map(Number);
        return { south, north, west, east, name: data[0].name, display_name: data[0].display_name };
      }
    }
  } catch { /* trecem la rezervă */ }

  try {
    const res = await fetch(
      'https://photon.komoot.io/api/?limit=1&q=' + encodeURIComponent(city + ', România'),
      { headers: { 'User-Agent': USER_AGENT } }
    );
    if (res.ok) {
      const data = await res.json();
      const feat = data.features && data.features[0];
      if (feat) {
        const name = feat.properties.name || city;
        if (feat.properties.extent) {
          const [west, north, east, south] = feat.properties.extent;
          return { south, north, west, east, name, display_name: name };
        }
        const [lon, lat] = feat.geometry.coordinates;
        return { south: lat - 0.15, north: lat + 0.15, west: lon - 0.2, east: lon + 0.2, name, display_name: name };
      }
    }
  } catch { /* nimic */ }

  return null;
}

/** Rulează interogarea Overpass încercând pe rând serverele disponibile. */
async function runOverpass(query) {
  for (const server of OVERPASS_SERVERS) {
    try {
      const res = await fetch(server, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (res.ok) return await res.json();
    } catch { /* încercăm următorul server */ }
  }
  return null;
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
      body.osm_id ? (String(body.osm_id).startsWith('google/') ? 'google' : 'openstreetmap') : 'manual',
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
