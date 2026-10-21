import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, SHOTS_DIR, db, listSites, getSite, addSites, deleteSite, updateSite,
  insertCheck, insertAlert, cleanup, listCompanies, addCompany, setCompany,
  SEED_FILE, importSeed,
} from './store.js';
import { checkSite, closeBrowser, browserInfo } from './checker.js';

const PORT = Number(process.env.PORT) || 4300;
const HOST = process.env.HOST || '127.0.0.1';
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN) || 10;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 8;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 14;

// Eerste start: volledige export (seed/) inladen, anders alleen de websitelijst.
if (!listSites().length && fs.existsSync(SEED_FILE)) {
  const r = importSeed();
  console.log(`Seed ingeladen: ${r.sites} websites, ${r.checks} checks, ${r.alerts} meldingen`);
} else if (!listSites().length && fs.existsSync(path.join(ROOT, 'sites.txt'))) {
  const r = addSites(fs.readFileSync(path.join(ROOT, 'sites.txt'), 'utf8').split(/\r?\n/));
  console.log(`${r.added.length} websites ingeladen uit sites.txt`);
}

// ---------- Wachtrij + planner ----------
const queue = [];
const pending = new Set();
let active = 0;
let lastRunStart = null;
let nextRun = Date.now();

function enqueue(ids, front = false) {
  for (const id of ids) {
    if (pending.has(id)) continue;
    pending.add(id);
    front ? queue.unshift(id) : queue.push(id);
  }
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const id = queue.shift();
    active++;
    runOne(id).finally(() => {
      active--;
      pending.delete(id);
      pump();
    });
  }
}

const TITLES = {
  hacked: 'Mogelijk gehackt',
  offline: 'Website offline',
  warning: 'Afwijking gedetecteerd',
};

async function runOne(id) {
  const site = getSite(id);
  if (!site) return;
  let r;
  try {
    r = await checkSite(site);
  } catch (e) {
    r = { ts: Date.now(), level: 'offline', status: null, ms: null, diff: null, error: String(e.message || e),
      signals: [{ key: 'error', level: 'critical', msg: `Check mislukt: ${e.message || e}` }] };
  }
  insertCheck({ site_id: id, ...r });

  // Meldingen bij nieuwe of verergerde problemen, en bij herstel.
  const prevKeys = new Set(site.last_signals.map((s) => s.key));
  const fresh = r.signals.filter((s) => !prevKeys.has(s.key));
  if (r.level !== 'ok' && (r.level !== site.level || fresh.length)) {
    const ordered = [...fresh, ...r.signals.filter((s) => prevKeys.has(s.key))];
    insertAlert({ site_id: id, ts: r.ts, level: r.level, title: TITLES[r.level],
      message: ordered.map((s) => s.msg).join('\n') });
  } else if (r.level === 'ok' && site.level !== 'ok' && site.level !== 'new') {
    insertAlert({ site_id: id, ts: r.ts, level: 'info',
      title: site.level === 'offline' ? 'Weer online' : 'Weer in orde', message: 'Geen afwijkingen meer gevonden.' });
  }

  const fields = {
    level: r.level, last_check_at: r.ts, last_status: r.status, last_ms: r.ms,
    last_diff: r.diff, last_error: r.error, last_signals: r.signals,
  };
  if (r.snapshot) {
    fields.last_snapshot = r.snapshot;
    // PHP-info alleen bijwerken als de site normaal antwoordde.
    fields.php_detected = r.php ? 1 : 0;
    fields.php_version = r.php?.version || null;
    fields.php_platform = r.php?.platform || null;
    fields.php_source = r.php?.source || null;
    fields.php_at = r.ts;
    // Baseline = laatste staat zonder afwijkingen (of de allereerste meting).
    // Offline-meldingen komen alleen in de baseline via "Is OK", zodat ze blijven afgaan.
    if (r.level === 'ok') fields.baseline = r.snapshot;
    else if (!site.baseline) fields.baseline = { ...r.snapshot, notice: [] };
  }
  if (r.shotSaved) {
    fields.prev_shot_at = site.shot_at;
    fields.shot_at = r.ts;
  }
  updateSite(id, fields);
}

function scheduleTick() {
  if (Date.now() < nextRun) return;
  lastRunStart = Date.now();
  nextRun = lastRunStart + INTERVAL_MIN * 60e3;
  cleanup(RETENTION_DAYS);
  enqueue(listSites().filter((s) => s.enabled).map((s) => s.id));
}
setInterval(scheduleTick, 10e3);
scheduleTick();

// ---------- API ----------
const app = express();

// Inloggen (verplicht als de tool online staat): zet AUTH_USER en AUTH_PASS.
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || '';
if (AUTH_PASS) {
  app.use((req, res, next) => {
    const [type, token] = String(req.headers.authorization || '').split(' ');
    if (type === 'Basic' && token) {
      const [u, ...p] = Buffer.from(token, 'base64').toString().split(':');
      if (u === AUTH_USER && p.join(':') === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Website Monitor", charset="UTF-8"').status(401).send('Inloggen vereist');
  });
} else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.warn('LET OP: de tool is bereikbaar via het netwerk zonder wachtwoord. Zet AUTH_PASS!');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shots', express.static(SHOTS_DIR, { maxAge: 0 }));

const publicSite = (s) => {
  const { baseline, last_snapshot, ...rest } = s;
  return { ...rest, title: last_snapshot?.title || baseline?.title || '', queued: pending.has(s.id) };
};

app.get('/api/overview', (req, res) => {
  const company = +req.query.company || null;
  const open = db
    .prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN sites s ON s.id = a.site_id
      WHERE a.ack = 0 AND a.level != 'info' ${company ? 'AND s.company_id = ?' : ''}`)
    .get(...(company ? [company] : [])).n;
  const latest = db.prepare('SELECT MAX(id) AS id FROM alerts').get().id || 0;
  res.json({
    sites: listSites().map(publicSite),
    companies: listCompanies(),
    openAlerts: open,
    latestAlertId: latest,
    status: {
      browser: browserInfo(), queued: queue.length, active, lastRunStart, nextRun,
      intervalMin: INTERVAL_MIN, now: Date.now(),
    },
  });
});

app.post('/api/sites', (req, res) => {
  const lines = String(req.body?.urls || '').split(/[\r\n,\s]+/);
  const r = addSites(lines, +req.body?.company_id || null);
  enqueue(r.added, true);
  res.json(r);
});

app.post('/api/companies', (req, res) => {
  const c = addCompany(req.body?.name);
  if (!c) return res.status(400).json({ error: 'Naam ontbreekt' });
  res.json(c);
});

// Bulk-acties op geselecteerde websites.
app.post('/api/sites/bulk', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  const action = req.body?.action;
  if (action === 'company') setCompany(ids, +req.body.company_id || null);
  else if (action === 'check') enqueue(ids, true);
  else return res.status(400).json({ error: 'Onbekende actie' });
  res.json({ ok: true, count: ids.length });
});

app.patch('/api/sites/:id', (req, res) => {
  const id = +req.params.id;
  const f = {};
  if ('enabled' in req.body) f.enabled = !!req.body.enabled;
  if ('diff_threshold' in req.body) f.diff_threshold = Math.min(100, Math.max(1, +req.body.diff_threshold || 50));
  if ('name' in req.body) f.name = String(req.body.name).slice(0, 100);
  updateSite(id, f);
  res.json(publicSite(getSite(id)));
});

app.delete('/api/sites/:id', (req, res) => {
  const id = +req.params.id;
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  pending.delete(id);
  deleteSite(id);
  res.json({ ok: true });
});

app.post('/api/sites/:id/check', (req, res) => {
  enqueue([+req.params.id], true);
  res.json({ ok: true });
});

// Huidige staat accepteren als nieuwe "goede" staat (na bewuste wijziging door klant).
// Handmatig offline markeren (bv. onderhouds-/parkeerpagina die er "online" uitziet) en weer opheffen.
const MANUAL_TITLE = 'Handmatig offline gezet';
app.post('/api/sites/:id/manual-offline', (req, res) => {
  const s = getSite(+req.params.id);
  if (!s) return res.status(404).json({ error: 'Niet gevonden' });
  const offline = !!req.body?.offline;
  if (offline === s.manual_offline) return res.json({ ok: true });
  const note = String(req.body?.note || '').trim().slice(0, 500);
  const now = Date.now();
  if (offline) {
    updateSite(s.id, { manual_offline: true, manual_offline_at: now, manual_note: note || null });
    insertAlert({ site_id: s.id, ts: now, level: 'offline', title: MANUAL_TITLE,
      message: note || 'Website handmatig als offline gemarkeerd.' });
  } else {
    updateSite(s.id, { manual_offline: false, manual_offline_at: null, manual_note: null });
    db.prepare('UPDATE alerts SET ack = 1, ack_at = ? WHERE site_id = ? AND ack = 0 AND title = ?').run(now, s.id, MANUAL_TITLE);
    insertAlert({ site_id: s.id, ts: now, level: 'info', title: 'Handmatige offline-tag verwijderd',
      message: s.manual_note ? `Was: ${s.manual_note}` : 'Website staat weer als online.' });
  }
  res.json({ ok: true });
});

app.post('/api/sites/:id/accept', (req, res) => {
  const s = getSite(+req.params.id);
  if (!s) return res.status(404).json({ error: 'Niet gevonden' });
  updateSite(s.id, { baseline: s.last_snapshot || s.baseline, level: s.last_snapshot ? 'ok' : s.level, last_signals: [] });
  db.prepare('UPDATE alerts SET ack = 1, ack_at = ? WHERE site_id = ? AND ack = 0').run(Date.now(), s.id);
  res.json({ ok: true });
});

app.post('/api/run-now', (req, res) => {
  nextRun = 0;
  scheduleTick();
  res.json({ ok: true });
});

const LEVEL_ORDER = "CASE c.level WHEN 'hacked' THEN 0 WHEN 'offline' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END";

app.get('/api/checks', (req, res) => {
  const where = [];
  const p = {};
  if (req.query.site) { where.push('c.site_id = :site'); p.site = +req.query.site; }
  if (req.query.company) { where.push('s.company_id = :company'); p.company = +req.query.company; }
  if (req.query.level) { where.push('c.level = :level'); p.level = String(req.query.level); }
  if (req.query.hours) { where.push('c.ts >= :since'); p.since = Date.now() - +req.query.hours * 3600e3; }
  if (req.query.q) { where.push('(s.name LIKE :q OR c.signals LIKE :q OR c.error LIKE :q)'); p.q = `%${req.query.q}%`; }
  const sorts = { ts: 'c.ts', site: 's.name', company: 'co.name', level: LEVEL_ORDER, status: 'c.status', ms: 'c.ms', diff: 'c.diff' };
  const sort = sorts[req.query.sort] || 'c.ts';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(500, +req.query.limit || 100);
  const page = Math.max(0, +req.query.page || 0);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM checks c JOIN sites s ON s.id = c.site_id LEFT JOIN companies co ON co.id = s.company_id ${w}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(p).n;
  const rows = db
    .prepare(`SELECT c.*, s.name, s.url, co.name AS company ${from} ORDER BY ${sort} ${dir}, c.id DESC LIMIT ${limit} OFFSET ${page * limit}`)
    .all(p)
    .map((r) => ({ ...r, signals: JSON.parse(r.signals || '[]') }));
  const counts = Object.fromEntries(
    db.prepare(`SELECT c.level, COUNT(*) AS n ${from} GROUP BY c.level`).all(p).map((r) => [r.level, r.n])
  );
  res.json({ total, rows, counts });
});

app.get('/api/alerts', (req, res) => {
  const where = [];
  const p = {};
  if (req.query.state === 'open') where.push('a.ack = 0');
  if (req.query.state === 'done') where.push('a.ack = 1');
  if (req.query.level) { where.push('a.level = :level'); p.level = String(req.query.level); }
  if (req.query.site) { where.push('a.site_id = :site'); p.site = +req.query.site; }
  if (req.query.company) { where.push('s.company_id = :company'); p.company = +req.query.company; }
  if (req.query.after) { where.push('a.id > :after'); p.after = +req.query.after; }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT a.*, s.name, s.url, co.name AS company FROM alerts a JOIN sites s ON s.id = a.site_id LEFT JOIN companies co ON co.id = s.company_id ${w} ORDER BY a.id DESC LIMIT 500`)
    .all(p);
  res.json(rows);
});

app.post('/api/alerts/:id/ack', (req, res) => {
  db.prepare('UPDATE alerts SET ack = 1, ack_at = ? WHERE id = ?').run(Date.now(), +req.params.id);
  res.json({ ok: true });
});

app.post('/api/alerts/ack-all', (req, res) => {
  const company = +req.body?.company || null;
  if (company)
    db.prepare('UPDATE alerts SET ack = 1, ack_at = ? WHERE ack = 0 AND site_id IN (SELECT id FROM sites WHERE company_id = ?)').run(Date.now(), company);
  else db.prepare('UPDATE alerts SET ack = 1, ack_at = ? WHERE ack = 0').run(Date.now());
  res.json({ ok: true });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Website Monitor draait op http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Controle elke ${INTERVAL_MIN} min, ${CONCURRENCY} tegelijk.`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
