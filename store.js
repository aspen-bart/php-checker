// Opslag: SQLite (ingebouwd in Node 22) + screenshots op schijf (max 2 per website).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, 'data');
export const SHOTS_DIR = path.join(DATA_DIR, 'shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'monitor.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  diff_threshold REAL NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'new',
  last_check_at INTEGER,
  last_status INTEGER,
  last_ms INTEGER,
  last_diff REAL,
  last_error TEXT,
  last_signals TEXT,
  baseline TEXT,
  last_snapshot TEXT,
  shot_at INTEGER,
  prev_shot_at INTEGER
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  status INTEGER,
  ms INTEGER,
  diff REAL,
  signals TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
CREATE INDEX IF NOT EXISTS idx_checks_site ON checks(site_id, ts);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  ack INTEGER NOT NULL DEFAULT 0,
  ack_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
`);

// Migraties voor kolommen die later zijn toegevoegd.
const siteCols = db.prepare('PRAGMA table_info(sites)').all().map((c) => c.name);
for (const [col, def] of [
  ['manual_offline', 'INTEGER NOT NULL DEFAULT 0'],
  ['manual_offline_at', 'INTEGER'],
  ['manual_note', 'TEXT'],
  ['php_version', 'TEXT'],
  ['php_platform', 'TEXT'],
  ['php_source', 'TEXT'],
  ['php_detected', 'INTEGER'],
  ['php_at', 'INTEGER'],
  ['company_id', 'INTEGER'],
]) {
  if (!siteCols.includes(col)) db.exec(`ALTER TABLE sites ADD COLUMN ${col} ${def}`);
}

// Companies (eigenaar van de websites).
db.exec('CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)');
export const DEFAULT_COMPANIES = ['Aspen Digital', 'Outtask', 'Ultimum', 'Digital Sky'];
for (const n of DEFAULT_COMPANIES) db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)').run(n);
// Bestaande websites zonder company horen bij Aspen Digital.
db.prepare("UPDATE sites SET company_id = (SELECT id FROM companies WHERE name = 'Aspen Digital') WHERE company_id IS NULL").run();

export const listCompanies = () => db.prepare('SELECT * FROM companies ORDER BY id').all();
export function addCompany(name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) return null;
  db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)').run(name);
  return db.prepare('SELECT * FROM companies WHERE name = ?').get(name);
}
export function setCompany(siteIds, companyId) {
  const st = db.prepare('UPDATE sites SET company_id = ? WHERE id = ?');
  for (const id of siteIds) st.run(companyId, id);
}

const json = (v) => (v == null ? null : JSON.parse(v));

export function siteFromRow(r) {
  if (!r) return null;
  return {
    ...r,
    enabled: !!r.enabled,
    manual_offline: !!r.manual_offline,
    last_signals: json(r.last_signals) || [],
    baseline: json(r.baseline),
    last_snapshot: json(r.last_snapshot),
  };
}

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || s === '/') return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) return null;
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export const nameFromUrl = (url) => {
  const u = new URL(url);
  const p = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return u.hostname.replace(/^www\./, '') + p;
};

export function listSites() {
  return db
    .prepare('SELECT s.*, c.name AS company FROM sites s LEFT JOIN companies c ON c.id = s.company_id ORDER BY s.name')
    .all()
    .map(siteFromRow);
}

export function getSite(id) {
  return siteFromRow(db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
}

export function addSites(lines, companyId = null) {
  companyId ||= db.prepare("SELECT id FROM companies WHERE name = 'Aspen Digital'").get()?.id;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO sites (url, name, created_at, company_id) VALUES (?, ?, ?, ?)'
  );
  const added = [];
  const skipped = [];
  for (const line of lines) {
    const url = normalizeUrl(line);
    if (!url) {
      if (String(line).trim()) skipped.push(String(line).trim());
      continue;
    }
    const r = insert.run(url, nameFromUrl(url), Date.now(), companyId);
    if (r.changes) added.push(Number(r.lastInsertRowid));
    else skipped.push(url);
  }
  return { added, skipped };
}

export function deleteSite(id) {
  db.prepare('DELETE FROM checks WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM alerts WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  fs.rmSync(path.join(SHOTS_DIR, String(id)), { recursive: true, force: true });
}

export function updateSite(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const vals = cols.map((c) => {
    const v = fields[c];
    if (v && typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
  db.prepare(`UPDATE sites SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...vals,
    id
  );
}

export function insertCheck(c) {
  db.prepare(
    'INSERT INTO checks (site_id, ts, level, status, ms, diff, signals, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(c.site_id, c.ts, c.level, c.status, c.ms, c.diff, JSON.stringify(c.signals), c.error);
}

export function insertAlert(a) {
  db.prepare(
    'INSERT INTO alerts (site_id, ts, level, title, message) VALUES (?, ?, ?, ?, ?)'
  ).run(a.site_id, a.ts, a.level, a.title, a.message);
}

export function cleanup(retentionDays) {
  const cutoff = Date.now() - retentionDays * 864e5;
  db.prepare('DELETE FROM checks WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM alerts WHERE ack = 1 AND ts < ?').run(Date.now() - 90 * 864e5);
}

// ---------- Export / import ----------
// Alle data (websites, companies, checks, meldingen) als gzip-JSON, zodat een nieuwe
// installatie (bv. online) met de volledige historie kan starten. Screenshots niet:
// die worden bij de eerste ronde opnieuw gemaakt.
export const SEED_FILE = path.join(ROOT, 'seed', 'seed.json.gz');
const TABLES = ['companies', 'sites', 'checks', 'alerts'];

export function exportSeed(file = SEED_FILE) {
  const data = { exportedAt: Date.now() };
  for (const t of TABLES) data[t] = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
  for (const s of data.sites) { s.shot_at = null; s.prev_shot_at = null; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(data), { level: 9 }));
  return Object.fromEntries(TABLES.map((t) => [t, data[t].length]));
}

export function importSeed(file = SEED_FILE) {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  db.exec('BEGIN');
  try {
    for (const t of TABLES) {
      db.exec(`DELETE FROM ${t}`);
      const rows = data[t] || [];
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const st = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of rows) st.run(...cols.map((c) => r[c]));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return Object.fromEntries(TABLES.map((t) => [t, (data[t] || []).length]));
}
