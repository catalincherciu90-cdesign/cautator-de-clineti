CREATE TABLE IF NOT EXISTS firme (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nume TEXT NOT NULL,
  oras TEXT,
  adresa TEXT,
  telefon TEXT,
  email TEXT,
  website TEXT,
  sursa TEXT DEFAULT 'manual',
  osm_id TEXT,
  status TEXT DEFAULT 'nou',
  notite TEXT,
  creat_la TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_firme_osm ON firme(osm_id) WHERE osm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_firme_oras ON firme(oras);
CREATE INDEX IF NOT EXISTS idx_firme_status ON firme(status);
