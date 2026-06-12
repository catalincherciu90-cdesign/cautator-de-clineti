# 🏗️ Căutător Firme de Construcții

Platformă web pentru căutarea firmelor de construcții din orice oraș (date din OpenStreetMap) și salvarea lor într-o bază de date proprie, cu urmărirea statusului fiecărei firme (nou → contactat → ofertă trimisă → client / respins).

## Stack

- **Cloudflare Workers** — backend API + servire fișiere statice
- **Cloudflare D1** — bază de date SQLite serverless
- **Google Places API** (opțional, cu cheie API) — sursa principală de căutare
- **OpenStreetMap** (Nominatim + Overpass API) — sursă de căutare gratuită, mereu activă
- Frontend: HTML/CSS/JavaScript vanilla, fără build step

## Cheia Google Places (opțional, dar recomandat)

Fără cheie, aplicația caută doar în OpenStreetMap. Cu cheie, primește în plus
rezultate Google Maps (telefoane, website-uri, rating-uri, recenzii):

1. [Google Cloud Console](https://console.cloud.google.com) → creează un proiect
2. Activează **Places API (New)** și facturarea (există nivel gratuit lunar)
3. Creează un **API key** (Credentials → Create credentials → API key)
4. Adaugă cheia ca secret GitHub: `GOOGLE_PLACES_API_KEY`
   (Settings → Secrets and variables → Actions)
5. La următorul deploy, cheia e trimisă automat în Cloudflare ca secret de Worker

## Funcționalități

- 🔍 Căutare firme de construcții după oraș, cu filtru opțional pe nume/meserie
- 💾 Salvare firme în baza de date cu un click (fără duplicate)
- ➕ Adăugare manuală de firme (nume, contact, notițe)
- 📊 Status pipeline per firmă: nou / contactat / ofertă trimisă / client / respins
- 🗑️ Ștergere și filtrare după status

## API

| Metodă | Rută | Descriere |
|---|---|---|
| GET | `/api/search?city=Oras&q=filtru` | Caută firme în OpenStreetMap |
| GET | `/api/firms?status=nou` | Listează firmele salvate |
| POST | `/api/firms` | Salvează o firmă |
| PUT | `/api/firms/:id` | Actualizează o firmă (status, notițe etc.) |
| DELETE | `/api/firms/:id` | Șterge o firmă |

## Rulare locală

```bash
npm install
npm run db:init:local   # creează tabelele în D1 local
npm run dev             # pornește pe http://localhost:8787
```

## Deploy pe Cloudflare

```bash
npx wrangler login
npx wrangler d1 create firme-constructii-db
# copiază database_id-ul afișat în wrangler.jsonc
npm run db:init         # creează tabelele în D1 remote
npm run deploy
```
