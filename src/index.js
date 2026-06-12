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

// Industriile din construcții (după structura CAEN 41 / 42 / 43)
const INDUSTRII = [
  'Construcții generale',
  'Infrastructură & drumuri',
  'Demolări & terasamente',
  'Amenajări interioare & finisaje',
  'Instalații sanitare',
  'Instalații electrice',
  'Încălzire & climatizare (HVAC)',
  'Acoperișuri',
  'Tâmplărie & ferestre',
  'Zugrăveli & vopsitorii',
  'Gresie, faianță & piatră',
  'Pardoseli & parchet',
  'Izolații & hidroizolații',
  'Confecții metalice',
  'Materiale de construcții',
  'Altele',
];

/** Încadrează o firmă într-o industrie pe baza tipului OSM și a numelui. */
function classifyIndustry(tip, nume) {
  const both = ((tip || '') + ' ' + (nume || '')).toLowerCase();
  if (/electrician|electric/.test(both)) return 'Instalații electrice';
  if (/hvac|climatiz|aer condi|incalzir|încălzir|central[ae] termic/.test(both)) return 'Încălzire & climatizare (HVAC)';
  if (/plumber|sanitar|instalat/.test(both)) return 'Instalații sanitare';
  if (/roofer|acoperi/.test(both)) return 'Acoperișuri';
  if (/window_construction|carpenter|joiner|termopan|tamplar|tâmplăr|geam|fereastr|\busi\b|\buși\b/.test(both)) return 'Tâmplărie & ferestre';
  if (/painter|plasterer|zugrav|vopsit|rigips|tencui/.test(both)) return 'Zugrăveli & vopsitorii';
  if (/tiler|stonemason|\bmason\b|gresie|faian|piatr[aă]|marmur/.test(both)) return 'Gresie, faianță & piatră';
  if (/floorer|flooring|pardosel|parchet/.test(both)) return 'Pardoseli & parchet';
  if (/insulation|izola|hidroizol/.test(both)) return 'Izolații & hidroizolații';
  if (/metal_construction|blacksmith|welder|confec.ii metal|fier forjat|inox|sudur/.test(both)) return 'Confecții metalice';
  if (/doityourself|\btrade\b|materiale de construc|depozit/.test(both)) return 'Materiale de construcții';
  if (/drum|asfalt|infrastructur|poduri|geniu civil/.test(both)) return 'Infrastructură & drumuri';
  if (/demol|excava|terasament|s[aă]p[aă]tur|foraj/.test(both)) return 'Demolări & terasamente';
  if (/amenaj|finisaj|design interior/.test(both)) return 'Amenajări interioare & finisaje';
  if (/builder|construction|scaffolder|construct|beton|santier|şantier/.test(both)) return 'Construcții generale';
  return 'Altele';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/search' && request.method === 'GET') {
        return await handleSearch(url, env);
      }
      if (pathname === '/api/industries' && request.method === 'GET') {
        return json({ industrii: INDUSTRII });
      }
      if (pathname === '/api/registru' && request.method === 'GET') {
        return await searchRegistru(env, url);
      }
      if (pathname === '/api/registru/judete' && request.method === 'GET') {
        return await listJudete(env);
      }
      const anafMatch = pathname.match(/^\/api\/firms\/(\d+)\/anaf$/);
      if (anafMatch && request.method === 'POST') {
        return await verifyAnaf(env, Number(anafMatch[1]));
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

  // Căutăm în paralel în toate sursele
  const [googleRes, osmRes, aiRes] = await Promise.allSettled([
    env.GOOGLE_PLACES_API_KEY
      ? searchGoogle(city, query, env.GOOGLE_PLACES_API_KEY)
      : Promise.resolve([]),
    searchOsm(city, query),
    env.AI ? searchAi(city, query, env) : Promise.resolve([]),
  ]);

  const google = googleRes.status === 'fulfilled' ? googleRes.value : [];
  const osm = osmRes.status === 'fulfilled' && osmRes.value ? osmRes.value : null;
  const ai = aiRes.status === 'fulfilled' ? aiRes.value : [];
  const aiError =
    aiRes.status === 'rejected'
      ? String((aiRes.reason && aiRes.reason.message) || aiRes.reason).slice(0, 300)
      : null;

  if (!google.length && !osm && !ai.length) {
    return json({ error: 'Serviciile de căutare nu au răspuns. Reîncearcă în câteva secunde.' }, 502);
  }

  // Combinăm: Google primul (date mai bogate), apoi OSM, apoi AI (de verificat), fără duplicate după nume
  const seen = new Set();
  let results = [];
  for (const r of [...google, ...(osm ? osm.results : []), ...ai]) {
    const key = r.nume.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    r.industrie = classifyIndustry(r.tip, r.nume);
    results.push(r);
  }

  // Filtru opțional pe industrie
  const industrie = (url.searchParams.get('industrie') || '').trim();
  if (industrie) {
    results = results.filter((r) => r.industrie === industrie);
  }

  return json({
    oras: (osm && osm.display_name) || city,
    surse: {
      google: google.length,
      openstreetmap: osm ? osm.results.length : 0,
      ai: ai.length,
      ...(aiError ? { ai_eroare: aiError } : {}),
    },
    total: results.length,
    rezultate: results,
  });
}

/** Căutare cu Cloudflare Workers AI: modelul listează firme cunoscute din oraș.
 *  AI-ul nu navighează pe internet, deci datele sunt marcate „de verificat"
 *  și nu îi cerem telefoane/email-uri (risc mare de date inventate). */
async function searchAi(city, query, env) {
  const prompt = `Listează firme de construcții reale și cunoscute din orașul ${city}, România${
    query ? `, în special legate de: ${query}` : ''
  }.

Reguli stricte:
- Include DOAR firme de a căror existență ești sigur. Mai bine puține și reale decât multe și inventate.
- NU inventa numere de telefon, adrese exacte sau email-uri. Lasă-le necompletate.
- Website doar dacă îl cunoști cu certitudine, altfel null.
- Maxim 15 firme.

Răspunde DOAR cu un array JSON valid, fără alt text, în formatul:
[{"nume":"...","tip":"construcții generale / instalații / acoperișuri etc.","website":null}]`;

  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: 'Ești un asistent care răspunde exclusiv cu JSON valid.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 1500,
  });

  // Modelul poate răspunde fie cu text JSON, fie direct cu structura parsată
  const raw = result && result.response;
  let parsed;
  if (Array.isArray(raw)) {
    parsed = raw;
  } else {
    const text = typeof raw === 'string' ? raw : '';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) {
      throw new Error('AI răspuns fără JSON: ' + JSON.stringify(result).slice(0, 200));
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error('AI JSON invalid: ' + text.slice(start, start + 200));
    }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((f) => f && typeof f.nume === 'string' && f.nume.trim())
    .slice(0, 15)
    .map((f) => ({
      osm_id: 'ai/' + f.nume.trim().toLowerCase().replace(/[^a-z0-9ăâîșşțţ]+/gi, '-'),
      nume: f.nume.trim(),
      tip: typeof f.tip === 'string' ? f.tip : 'construcții',
      adresa: null,
      telefon: null,
      email: null,
      website: typeof f.website === 'string' && f.website.startsWith('http') ? f.website : null,
      oras: city,
      ai: true,
    }));
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

/* ---------- Registrul firmelor (date oficiale MF/ONRC, importate în D1) ---------- */

// Etichete pentru codurile CAEN din construcții
const CAEN_LABELS = {
  '41': 'Construcția clădirilor',
  '42': 'Infrastructură & geniu civil',
  '431': 'Demolări & terasamente',
  '4321': 'Instalații electrice',
  '4322': 'Instalații sanitare & termice',
  '4329': 'Alte instalații',
  '4331': 'Ipsoserie & tencuieli',
  '4332': 'Tâmplărie & dulgherie',
  '4333': 'Pardoseli & placări',
  '4334': 'Zugrăveli & vopsitorii',
  '4339': 'Alte finisaje',
  '4391': 'Acoperișuri & șarpante',
  '4399': 'Alte lucrări speciale',
};

function caenLabel(caen) {
  for (const len of [4, 3, 2]) {
    const l = CAEN_LABELS[(caen || '').slice(0, len)];
    if (l) return l;
  }
  return 'Construcții';
}

async function searchRegistru(env, url) {
  const p = url.searchParams;
  const conditions = [];
  const params = [];

  if (p.get('judet')) { conditions.push('judet = ?'); params.push(p.get('judet')); }
  if (p.get('localitate')) { conditions.push('localitate LIKE ?'); params.push('%' + p.get('localitate').trim() + '%'); }
  if (p.get('caen')) { conditions.push('caen LIKE ?'); params.push(p.get('caen') + '%'); }
  if (p.get('min_angajati')) { conditions.push('angajati >= ?'); params.push(Number(p.get('min_angajati')) || 0); }
  if (p.get('min_ca')) { conditions.push('cifra_afaceri >= ?'); params.push(Number(p.get('min_ca')) || 0); }
  if (p.get('q')) { conditions.push('denumire LIKE ?'); params.push('%' + p.get('q').trim() + '%'); }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const page = Math.max(0, Number(p.get('page')) || 0);
  const LIMIT = 30;

  try {
    const totalRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM firme_registru' + where)
      .bind(...params)
      .first();
    const { results } = await env.DB.prepare(
      'SELECT * FROM firme_registru' + where +
        ' ORDER BY (cifra_afaceri IS NULL), cifra_afaceri DESC LIMIT ? OFFSET ?'
    )
      .bind(...params, LIMIT, page * LIMIT)
      .all();

    for (const r of results) r.caen_den = caenLabel(r.caen);
    return json({ total: totalRow.n, pagina: page, per_pagina: LIMIT, firme: results });
  } catch (err) {
    if (/no such table/i.test(err.message)) {
      return json({ error: 'Registrul nu este încă importat. Rulează workflow-ul de import.', total: 0, firme: [] }, 200);
    }
    throw err;
  }
}

async function listJudete(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT judet FROM firme_registru WHERE judet != '' ORDER BY judet"
    ).all();
    return json({ judete: results.map((r) => r.judet) });
  } catch {
    return json({ judete: [] });
  }
}

/* ---------- Verificare ANAF (după CUI) ---------- */

async function verifyAnaf(env, id) {
  const firm = await env.DB.prepare('SELECT * FROM firme WHERE id = ?').bind(id).first();
  if (!firm) return json({ error: 'Firma nu există' }, 404);
  const cui = Number(String(firm.cui || '').replace(/\D/g, ''));
  if (!cui) return json({ error: 'Firma nu are CUI. Adaugă CUI-ul ca să o pot verifica la ANAF.' }, 400);

  const res = await fetch('https://webservicesp.anaf.ro/PlatitorTvaRest/api/v9/ws/tva', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify([{ cui, data: new Date().toISOString().slice(0, 10) }]),
  });
  if (!res.ok) return json({ error: 'ANAF nu a răspuns (cod ' + res.status + '). Reîncearcă.' }, 502);
  const data = await res.json();
  const found = data.found && data.found[0];
  if (!found) return json({ error: 'CUI-ul ' + cui + ' nu a fost găsit la ANAF.' }, 404);

  const dg = found.date_generale || {};
  const tva = !!(found.inregistrare_scp_tva && found.inregistrare_scp_tva.scpTVA);
  const inactiv = !!(found.stare_inactiv && found.stare_inactiv.statusInactivi);

  // Îmbogățim firma cu datele oficiale (fără să suprascriem ce a completat utilizatorul)
  const verificare =
    `✓ ANAF (${new Date().toISOString().slice(0, 10)}): ` +
    `${inactiv ? 'INACTIVĂ fiscal' : 'activă'}, ${tva ? 'plătitor TVA' : 'neplătitor TVA'}` +
    (dg.nrRegCom ? `, ${dg.nrRegCom}` : '');
  const notite = (firm.notite ? firm.notite + '\n' : '') + verificare;

  await env.DB.prepare(
    'UPDATE firme SET nume = ?, adresa = ?, telefon = ?, notite = ? WHERE id = ?'
  )
    .bind(
      dg.denumire || firm.nume,
      firm.adresa || dg.adresa || null,
      firm.telefon || dg.telefon || null,
      notite,
      id
    )
    .run();

  return json({
    ok: true,
    denumire: dg.denumire || null,
    adresa: dg.adresa || null,
    telefon: dg.telefon || null,
    platitor_tva: tva,
    inactiva: inactiv,
    nr_reg_com: dg.nrRegCom || null,
  });
}

/* ---------- CRUD firme salvate (D1) ---------- */

async function listFirms(env, url) {
  const status = url.searchParams.get('status');
  const industrie = url.searchParams.get('industrie');
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (industrie) { conditions.push('industrie = ?'); params.push(industrie); }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const { results } = await env.DB.prepare('SELECT * FROM firme' + where + ' ORDER BY creat_la DESC')
    .bind(...params)
    .all();
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

  const industrie =
    body.industrie && INDUSTRII.includes(body.industrie)
      ? body.industrie
      : classifyIndustry(body.tip, body.nume);

  const id = String(body.osm_id || '');
  const sursa = !id
    ? 'manual'
    : id.startsWith('google/')
      ? 'google'
      : id.startsWith('ai/')
        ? 'ai'
        : id.startsWith('cui/')
          ? 'registru'
          : 'openstreetmap';

  const result = await env.DB.prepare(
    `INSERT INTO firme (nume, oras, adresa, telefon, email, website, sursa, osm_id, notite, industrie, cui)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      String(body.nume).trim(),
      body.oras || null,
      body.adresa || null,
      body.telefon || null,
      body.email || null,
      body.website || null,
      sursa,
      body.osm_id || null,
      body.notite || null,
      industrie,
      body.cui ? String(body.cui).replace(/\D/g, '') || null : null
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
    `UPDATE firme SET nume = ?, oras = ?, adresa = ?, telefon = ?, email = ?, website = ?, status = ?, notite = ?, industrie = ?, cui = ?
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
      body.industrie ?? existing.industrie,
      body.cui ?? existing.cui,
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
