#!/usr/bin/env python3
"""
Import firme de construcții (CAEN 41/42/43) din datele deschise ale
Ministerului Finanțelor (data.gov.ro):
  1. Situații financiare anuale  -> CUI, CAEN, cifră de afaceri, profit, angajați
  2. Date de identificare plătitori -> denumire, județ, localitate, adresă

Produce fișiere SQL în out/ pentru încărcare în Cloudflare D1.
Rulat din GitHub Actions (vezi .github/workflows/import-registru.yml).
"""

import csv
import io
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request

CKAN = "https://data.gov.ro/api/3/action"
OUT = "out"
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
}
RETRIES = 4

# data.gov.ro blochează rețelele cloud — descărcăm prin tunelul din Worker
PROXY_URL = os.environ.get("IMPORT_PROXY_URL", "")
PROXY_KEY = os.environ.get("IMPORT_PROXY_KEY", "")

csv.field_size_limit(10_000_000)


def fetch(url, timeout):
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            real_url = url
            headers = dict(UA)
            if PROXY_URL and "data.gov.ro" in url:
                real_url = PROXY_URL + "?url=" + urllib.parse.quote(url, safe="")
                headers["X-Import-Key"] = PROXY_KEY
            req = urllib.request.Request(real_url, headers=headers)
            resp = urllib.request.urlopen(req, timeout=timeout)
            if resp.status >= 400:
                raise RuntimeError(f"HTTP {resp.status}")
            return resp
        except Exception as e:
            last = e
            wait = 15 * attempt
            print(f"  încercarea {attempt}/{RETRIES} a eșuat ({e}); reîncerc în {wait}s")
            import time
            time.sleep(wait)
    raise last


def get_json(url):
    with fetch(url, 120) as r:
        return json.load(r)


def download(url, dest):
    print(f"  descarc {url}")
    with fetch(url, 900) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    size = os.path.getsize(dest)
    print(f"  salvat {dest} ({size/1e6:.1f} MB)")
    return dest


def norm(s):
    """Normalizează un nume de coloană: fără diacritice, majuscule, fără spații."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^A-Z0-9]", "_", s.upper().strip())


def find_package(query, org, title_regex):
    data = get_json(f"{CKAN}/package_search?q={urllib.parse.quote(query)}&rows=50")
    best, best_key = None, ""
    for pkg in data["result"]["results"]:
        if org and (pkg.get("organization") or {}).get("name") != org:
            continue
        title = pkg.get("title", "")
        if not re.search(title_regex, title, re.I):
            continue
        key = pkg.get("metadata_modified", "")
        if key > best_key:
            best, best_key = pkg, key
    if not best:
        print(f"EROARE: nu am găsit pachetul pentru '{query}' (regex {title_regex})")
        sys.exit(1)
    print(f"Pachet ales: {best['title']} (modificat {best_key})")
    for r in best["resources"]:
        print(f"  resursă: {r.get('name')!r} format={r.get('format')} url={r.get('url')}")
    return best


def sniff_delimiter(line):
    counts = {d: line.count(d) for d in ["|", ";", "\t", ","]}
    return max(counts, key=counts.get)


def open_text(path):
    return open(path, "r", encoding="utf-8", errors="replace", newline="")


def read_header(path):
    with open_text(path) as f:
        first = f.readline().rstrip("\r\n")
    delim = sniff_delimiter(first)
    cols = [norm(c) for c in first.split(delim)]
    return delim, cols


def col_index(cols, *patterns):
    """Prima coloană al cărei nume normalizat se potrivește cu vreun regex."""
    for pat in patterns:
        for i, c in enumerate(cols):
            if re.search(pat, c):
                return i
    return None


def to_num(v):
    v = (v or "").strip().replace(",", ".")
    try:
        return float(v)
    except ValueError:
        return None


def main():
    os.makedirs(OUT, exist_ok=True)

    # ---------- 1. Situații financiare (indicatori per CUI) ----------
    fin_pkg = find_package("situatii financiare", "mfp", r"situa\S*\s*financiare")
    firms = {}  # cui -> dict
    an_bilant = "?"
    m = re.search(r"(20\d\d)", fin_pkg["title"])
    if m:
        an_bilant = m.group(1)

    for res in fin_pkg["resources"]:
        url = res.get("url", "")
        name = (res.get("name") or "") + " " + url
        if not re.search(r"\.(txt|csv)(\?|$)", url, re.I):
            continue
        # excludem fișierele de specificație și instituțiile publice
        if re.search(r"instit|public|primar|spital|scol|uat", name, re.I):
            continue
        path = os.path.join(OUT, "fin_" + re.sub(r"[^a-zA-Z0-9.]", "_", os.path.basename(url))[:80])
        try:
            download(url, path)
        except Exception as e:
            print(f"  AVERTISMENT: descărcare eșuată ({e}), trec mai departe")
            continue

        delim, cols = read_header(path)
        print(f"  coloane ({delim!r}): {cols[:25]}")
        i_cui = col_index(cols, r"^CUI$", r"^COD_?UNIC", r"^CIF$", r"CUI")
        i_caen = col_index(cols, r"^CAEN$", r"^COD_?CAEN", r"CAEN")
        i_ca = col_index(cols, r"CIFRA_?DE_?AFACERI", r"^CA_?NETA", r"CIFRA")
        i_profit = col_index(cols, r"PROFIT_?NET", r"^PROFIT$", r"REZULTAT_?NET", r"PROFIT")
        i_ang = col_index(cols, r"NUMAR_?MEDIU_?(DE_?)?SALARIATI", r"SALARIATI", r"ANGAJATI")
        i_den = col_index(cols, r"^DENUMIRE", r"^DEN$")
        print(f"  index: cui={i_cui} caen={i_caen} ca={i_ca} profit={i_profit} ang={i_ang} den={i_den}")
        if i_cui is None or i_caen is None:
            print("  -> fișier fără CUI/CAEN, îl sar")
            os.remove(path)
            continue

        count = 0
        with open_text(path) as f:
            reader = csv.reader(f, delimiter=delim)
            next(reader, None)
            for row in reader:
                if len(row) <= max(i_cui, i_caen):
                    continue
                caen = re.sub(r"\D", "", row[i_caen])
                if not caen.startswith(("41", "42", "43")):
                    continue
                cui = re.sub(r"\D", "", row[i_cui])
                if not cui:
                    continue
                firms[cui] = {
                    "caen": caen,
                    "ca": to_num(row[i_ca]) if i_ca is not None and len(row) > i_ca else None,
                    "profit": to_num(row[i_profit]) if i_profit is not None and len(row) > i_profit else None,
                    "ang": to_num(row[i_ang]) if i_ang is not None and len(row) > i_ang else None,
                    "den": row[i_den].strip() if i_den is not None and len(row) > i_den else "",
                    "judet": "",
                    "loc": "",
                    "adresa": "",
                }
                count += 1
        print(f"  -> {count} firme de construcții din acest fișier (total: {len(firms)})")
        os.remove(path)

    print(f"TOTAL firme construcții (CAEN 41-43): {len(firms)}")
    if not firms:
        print("EROARE: nicio firmă găsită — verifică structura fișierelor de mai sus")
        sys.exit(1)

    # ---------- 2. Date de identificare (denumire + adresă) ----------
    try:
        id_pkg = find_package("date identificare platitori", "mfp", r"identificare")
        for res in id_pkg["resources"]:
            url = res.get("url", "")
            if not re.search(r"\.(txt|csv)(\?|$)", url, re.I):
                continue
            path = os.path.join(OUT, "id_" + re.sub(r"[^a-zA-Z0-9.]", "_", os.path.basename(url))[:80])
            try:
                download(url, path)
            except Exception as e:
                print(f"  AVERTISMENT: descărcare eșuată ({e})")
                continue
            delim, cols = read_header(path)
            print(f"  coloane ({delim!r}): {cols[:25]}")
            i_cui = col_index(cols, r"^CUI$", r"^COD_?FISCAL", r"^CIF$", r"CUI")
            i_den = col_index(cols, r"^DENUMIRE", r"^DEN$", r"NUME")
            i_jud = col_index(cols, r"JUDET")
            i_loc = col_index(cols, r"LOCALITATE", r"ORAS")
            i_adr = col_index(cols, r"ADRESA", r"STRADA")
            print(f"  index: cui={i_cui} den={i_den} judet={i_jud} loc={i_loc} adr={i_adr}")
            if i_cui is None:
                os.remove(path)
                continue
            matched = 0
            with open_text(path) as f:
                reader = csv.reader(f, delimiter=delim)
                next(reader, None)
                for row in reader:
                    if len(row) <= i_cui:
                        continue
                    cui = re.sub(r"\D", "", row[i_cui])
                    firm = firms.get(cui)
                    if not firm:
                        continue
                    if i_den is not None and len(row) > i_den and row[i_den].strip():
                        firm["den"] = row[i_den].strip()
                    if i_jud is not None and len(row) > i_jud:
                        firm["judet"] = row[i_jud].strip()
                    if i_loc is not None and len(row) > i_loc:
                        firm["loc"] = row[i_loc].strip()
                    if i_adr is not None and len(row) > i_adr:
                        firm["adresa"] = row[i_adr].strip()[:200]
                    matched += 1
            print(f"  -> potriviri: {matched}")
            os.remove(path)
    except SystemExit:
        raise
    except Exception as e:
        print(f"AVERTISMENT: nu am putut procesa datele de identificare: {e}")

    # ---------- 3. Generăm SQL pentru D1 ----------
    def esc(s):
        return (s or "").replace("'", "''")

    rows = []
    for cui, f in firms.items():
        if not f["den"]:
            continue  # fără denumire nu e utilizabilă
        rows.append(
            f"({cui},'{esc(f['den'])[:150]}','{esc(f['judet'])[:60]}','{esc(f['loc'])[:80]}',"
            f"'{esc(f['adresa'])}','{f['caen']}',"
            f"{f['ca'] if f['ca'] is not None else 'NULL'},"
            f"{f['profit'] if f['profit'] is not None else 'NULL'},"
            f"{int(f['ang']) if f['ang'] is not None else 'NULL'},{an_bilant or 'NULL'})"
        )

    print(f"Rânduri cu denumire completă: {len(rows)}")
    if not rows:
        print("EROARE: nicio firmă cu denumire — datele de identificare nu s-au potrivit")
        sys.exit(1)

    PER_STMT = 400
    PER_FILE = 50  # ~20k rânduri / fișier
    stmts = []
    for i in range(0, len(rows), PER_STMT):
        stmts.append(
            "INSERT INTO firme_registru (cui,denumire,judet,localitate,adresa,caen,cifra_afaceri,profit,angajati,an) VALUES\n"
            + ",\n".join(rows[i : i + PER_STMT])
            + ";"
        )

    nfiles = 0
    for i in range(0, len(stmts), PER_FILE):
        nfiles += 1
        with open(os.path.join(OUT, f"chunk_{nfiles:03d}.sql"), "w", encoding="utf-8") as f:
            f.write("\n".join(stmts[i : i + PER_FILE]))
    print(f"Generat {nfiles} fișiere SQL în {OUT}/ ({len(rows)} firme, an bilanț {an_bilant})")


if __name__ == "__main__":
    main()
