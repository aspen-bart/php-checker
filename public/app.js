const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LEVELS = {
  hacked: 'Mogelijk gehackt', offline: 'Offline', warning: 'Waarschuwing', ok: 'Online', new: 'Nog niet gecontroleerd', info: 'Hersteld',
};
const SEVERITY = { hacked: 0, offline: 1, warning: 2, new: 3, ok: 4 };
const pill = (l) => `<span class="pill ${esc(l)}">${esc(LEVELS[l] || l)}</span>`;
const fmtTime = (t) => (t ? new Date(t).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
const ago = (t) => {
  if (!t) return '–';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s geleden`;
  if (s < 3600) return `${Math.round(s / 60)} min geleden`;
  return fmtTime(t);
};
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

let overview = { sites: [], status: {}, openAlerts: 0, latestAlertId: 0 };
const state = {
  tab: 'sites',
  siteSort: store.get('siteSort', { key: 'level', dir: 'asc' }),
  chkSort: { key: 'ts', dir: 'desc' },
  chkPage: 0,
};

// ---------- Tabs ----------
function showTab() {
  state.tab = (location.hash || '#sites').slice(1).split('?')[0];
  if (!['sites', 'checks', 'alerts'].includes(state.tab)) state.tab = 'sites';
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('hidden', el.id !== 'tab-' + state.tab));
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === state.tab));
  if (state.tab === 'checks') loadChecks();
  if (state.tab === 'alerts') loadAlerts();
}
window.addEventListener('hashchange', showTab);

// ---------- Overzicht / polling ----------
async function refresh() {
  try {
    overview = await api('/overview');
    overview.fetchedAt = Date.now();
    // Handmatige offline-tag gaat voor op het automatische resultaat.
    for (const s of overview.sites) {
      s.autoLevel = s.level;
      if (s.manual_offline) s.level = 'offline';
    }
  } catch {
    $('#runStatus').textContent = '⚠ Server niet bereikbaar';
    return;
  }
  renderStatus();
  renderSites();
  fillSiteSelects();
  checkNewAlerts();
  if (state.tab === 'checks' && state.chkPage === 0) loadChecks();
  if (state.tab === 'alerts') loadAlerts();
}

function renderStatus() {
  const st = overview.status;
  const busy = st.active + st.queued;
  const next = Math.max(0, Math.round((st.nextRun - st.now - (Date.now() - overview.fetchedAt)) / 1000));
  $('#runStatus').innerHTML = busy
    ? `<span class="spin">⟳</span> Bezig: ${busy} website(s) in controle`
    : `Volgende ronde over ${Math.floor(next / 60)}:${String(next % 60).padStart(2, '0')} · elke ${st.intervalMin} min · browser: ${esc(st.browser || 'geen (alleen HTTP)')}`;
  const badge = $('#alertBadge');
  badge.textContent = overview.openAlerts;
  badge.classList.toggle('hidden', !overview.openAlerts);
  document.title = (overview.openAlerts ? `(${overview.openAlerts}) ` : '') + 'Website Monitor';

  const bad = overview.sites.filter((s) => s.enabled && (s.level === 'hacked' || s.level === 'offline'));
  const banner = $('#banner');
  if (bad.length) {
    const hacked = bad.filter((s) => s.level === 'hacked');
    const off = bad.filter((s) => s.level === 'offline');
    banner.className = 'banner';
    banner.innerHTML =
      (hacked.length ? `⚠ MOGELIJK GEHACKT: ${hacked.map((s) => esc(s.name)).join(', ')}. ` : '') +
      (off.length ? `⛔ OFFLINE: ${off.map((s) => esc(s.name)).join(', ')}` : '');
  } else banner.className = 'banner hidden';
}
$('#banner').onclick = () => { $('#siteLevel').value = ''; location.hash = '#sites'; };

// ---------- PHP ----------
// Support-status per oktober 2026: < 8.2 geen updates meer, 8.2 alleen security t/m 31-12-2026.
const phpNum = (v) => { const [a = 0, b = 0, c = 0] = String(v).split('.').map(Number); return a * 10000 + b * 100 + c; };
function phpClass(s) {
  if (!s.php_at) return 'unknown';
  if (!s.php_detected) return 'none';
  if (!s.php_version) return 'hidden';
  const n = phpNum(s.php_version);
  return n < 80200 ? 'old' : n < 80300 ? 'ending' : 'current';
}
const PHP_LABEL = { old: 'verouderd – geen updates meer', ending: 'security-support tot 31-12-2026', current: 'actueel', hidden: 'versie verborgen', none: 'geen PHP gedetecteerd', unknown: 'nog niet bepaald' };
function phpCell(s) {
  const c = phpClass(s);
  const tip = [PHP_LABEL[c], s.php_platform, s.php_source && `bron: ${s.php_source}`, s.php_at && `gemeten ${fmtTime(s.php_at)}`].filter(Boolean).join(' · ');
  const txt = c === 'unknown' ? '–' : c === 'none' ? 'geen' : s.php_version || 'verborgen';
  return `<span class="php ${c}" title="${esc(tip)}">${esc(txt)}</span>${s.php_platform ? `<div class="sub">${esc(s.php_platform)}</div>` : ''}`;
}
// Sorteerwaarde: versie numeriek; verborgen < geen < onbekend achteraan.
const phpSort = (s) => { const c = phpClass(s); return c === 'unknown' ? 1e9 : c === 'none' ? 1e8 : c === 'hidden' ? 1e7 : phpNum(s.php_version); };

// ---------- Websites ----------
function renderSites() {
  const sites = overview.sites;
  const counts = { total: sites.length };
  for (const s of sites) counts[s.level] = (counts[s.level] || 0) + 1;
  const sel = $('#siteLevel').value;
  $('#cards').innerHTML = [
    ['', 'Totaal', counts.total],
    ['ok', 'Online', counts.ok || 0],
    ['warning', 'Waarschuwing', counts.warning || 0],
    ['hacked', 'Mogelijk gehackt', counts.hacked || 0],
    ['offline', 'Offline', counts.offline || 0],
    ['new', 'Nog niet gecheckt', counts.new || 0],
  ].map(([k, l, n]) => `<div class="card ${k} ${sel === k ? 'sel' : ''}" data-level="${k}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const q = $('#siteSearch').value.trim().toLowerCase();
  const { key, dir } = state.siteSort;
  const val = (s) => (key === 'level' ? SEVERITY[s.level] ?? 9 : key === 'php' ? phpSort(s) : s[key] ?? (dir === 'asc' ? Infinity : -Infinity));
  const phpSel = $('#sitePhp').value;
  const list = sites
    .filter((s) => (!sel || s.level === sel) && (!phpSel || phpClass(s) === phpSel) &&
      (!q || (s.name + s.url + s.title + ' php ' + (s.php_version || '') + ' ' + (s.php_platform || '')).toLowerCase().includes(q)))
    .sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return (dir === 'asc' ? c : -c) || a.name.localeCompare(b.name);
    });
  $('#siteCount').textContent = `${list.length} van ${sites.length}`;
  markSort('#sitesTable', state.siteSort);

  $('#sitesTable tbody').innerHTML = list.map((s) => {
    const sigs = s.last_signals.map((g) => `<div class="sig ${esc(g.level)}">${esc(g.msg)}</div>`).join('');
    const thumb = s.shot_at
      ? `<img class="thumb" loading="lazy" src="/shots/${s.id}/current.png?t=${s.shot_at}" data-cmp="${s.id}" alt="">`
      : '<span class="muted">–</span>';
    return `<tr class="row-${esc(s.level)} ${s.enabled ? '' : 'disabled'}">
      <td>${s.queued ? '<span class="spin">⟳</span> ' : ''}${pill(s.level)}
        ${s.manual_offline ? `<div class="tag manual" title="Handmatig gezet op ${fmtTime(s.manual_offline_at)}">✋ handmatig</div>` : ''}
        ${s.last_signals.some((g) => g.key.startsWith('notice:')) ? '<div class="tag manual" title="De pagina meldt zelf dat hij offline/in onderhoud/gehackt is">🔎 melding op pagina</div>' : ''}</td>
      <td class="site"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>
        <div class="sub" title="${esc(s.title)}">${esc(s.title)}</div>
        ${s.manual_offline ? `<div class="sig critical">✋ Handmatig offline${s.manual_note ? ': ' + esc(s.manual_note) : ''} <span class="muted">(${fmtTime(s.manual_offline_at)})</span></div>` : ''}
        ${s.manual_offline && s.autoLevel !== 'offline' ? `<div class="sig muted">Automatische check: ${esc(LEVELS[s.autoLevel] || s.autoLevel)}</div>` : ''}${sigs}</td>
      <td class="num">${s.last_status ?? '–'}</td>
      <td class="num">${phpCell(s)}</td>
      <td class="num">${s.last_ms != null ? (s.last_ms / 1000).toFixed(1) + ' s' : '–'}</td>
      <td class="num">${s.last_diff != null ? s.last_diff + ' %' : '–'} <span class="muted">/ ${s.diff_threshold}%</span></td>
      <td class="num" title="${fmtTime(s.last_check_at)}">${ago(s.last_check_at)}</td>
      <td>${thumb}</td>
      <td><div class="actions">
        <button data-act="check" data-id="${s.id}" title="Nu controleren">⟳ Check</button>
        ${s.manual_offline
          ? `<button data-act="manual-off" data-id="${s.id}" class="on" title="Handmatige offline-tag verwijderen">✋ Offline-tag weg</button>`
          : `<button data-act="manual-on" data-id="${s.id}" title="Handmatig als offline markeren">✋ Zet offline</button>`}
        ${s.autoLevel !== 'ok' && s.autoLevel !== 'new' ? `<button data-act="accept" data-id="${s.id}" title="Huidige staat goedkeuren als nieuwe referentie">✓ Is OK</button>` : ''}
        <button data-act="history" data-id="${s.id}" title="Checks van deze website">Checks</button>
        <button data-act="threshold" data-id="${s.id}" title="Drempel visueel verschil">%</button>
        <button data-act="toggle" data-id="${s.id}">${s.enabled ? 'Pauze' : 'Hervat'}</button>
        <button data-act="delete" data-id="${s.id}" title="Verwijderen">🗑</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">Geen websites gevonden.</td></tr>';
}

function markSort(table, { key, dir }) {
  document.querySelectorAll(`${table} th[data-sort]`).forEach((th) => {
    th.classList.toggle('asc', th.dataset.sort === key && dir === 'asc');
    th.classList.toggle('desc', th.dataset.sort === key && dir === 'desc');
  });
}

$('#cards').onclick = (e) => {
  const c = e.target.closest('.card');
  if (!c) return;
  $('#siteLevel').value = $('#siteLevel').value === c.dataset.level ? '' : c.dataset.level;
  renderSites();
};
$('#siteSearch').oninput = renderSites;
$('#siteLevel').onchange = renderSites;
$('#sitePhp').onchange = renderSites;
$('#sitesTable thead').onclick = (e) => {
  const k = e.target.closest('th')?.dataset.sort;
  if (!k) return;
  const s = state.siteSort;
  state.siteSort = { key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' };
  store.set('siteSort', state.siteSort);
  renderSites();
};

$('#sitesTable tbody').onclick = async (e) => {
  const img = e.target.closest('[data-cmp]');
  if (img) return openCompare(+img.dataset.cmp);
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = +b.dataset.id;
  const site = overview.sites.find((s) => s.id === id);
  switch (b.dataset.act) {
    case 'check': await api(`/sites/${id}/check`, { body: {} }); break;
    case 'accept':
      if (!confirm(`Huidige staat van ${site.name} goedkeuren als nieuwe referentie? Open meldingen worden afgehandeld.`)) return;
      await api(`/sites/${id}/accept`, { body: {} }); break;
    case 'manual-on': {
      const note = prompt(`${site.name} handmatig als OFFLINE markeren.\nReden (optioneel), bv. "parkeerpagina hosting" of "onderhoudsscherm":`, '');
      if (note == null) return;
      await api(`/sites/${id}/manual-offline`, { body: { offline: true, note } }); break;
    }
    case 'manual-off':
      if (!confirm(`Handmatige offline-tag van ${site.name} verwijderen?`)) return;
      await api(`/sites/${id}/manual-offline`, { body: { offline: false } }); break;
    case 'history': $('#chkSite').value = id; $('#chkLevel').value = ''; state.chkPage = 0; location.hash = '#checks'; return;
    case 'threshold': {
      const v = prompt(`Vanaf welk % visueel verschil moet ${site.name} een waarschuwing geven?\n(100 = visuele check negeren, bv. bij een slider)`, site.diff_threshold);
      if (v == null) return;
      await api(`/sites/${id}`, { method: 'PATCH', body: { diff_threshold: +v } }); break;
    }
    case 'toggle': await api(`/sites/${id}`, { method: 'PATCH', body: { enabled: !site.enabled } }); break;
    case 'delete':
      if (!confirm(`${site.name} verwijderen inclusief alle checks, meldingen en screenshots?`)) return;
      await api(`/sites/${id}`, { method: 'DELETE' }); break;
  }
  refresh();
};

$('#addBtn').onclick = async () => {
  const r = await api('/sites', { body: { urls: $('#addUrls').value } });
  $('#addResult').textContent = `${r.added.length} toegevoegd` + (r.skipped.length ? `, ${r.skipped.length} overgeslagen (dubbel/ongeldig)` : '');
  if (r.added.length) $('#addUrls').value = '';
  refresh();
};

$('#runNow').onclick = async () => { await api('/run-now', { body: {} }); refresh(); };

// ---------- Vergelijken ----------
async function openCompare(id) {
  const s = overview.sites.find((x) => x.id === id);
  $('#cmpTitle').textContent = s.name;
  $('#cmpDiff').checked = false;
  $('#cmpCanvas').classList.add('hidden');
  $('#cmpCur').classList.remove('hidden');
  $('#cmpPrevCap').textContent = s.prev_shot_at ? `Vorige: ${fmtTime(s.prev_shot_at)}` : 'Vorige: (nog geen)';
  $('#cmpCurCap').textContent = `Nu: ${fmtTime(s.shot_at)}` + (s.last_diff != null ? ` · ${s.last_diff}% verschil` : '');
  $('#cmpPrev').src = s.prev_shot_at ? `/shots/${id}/previous.png?t=${s.prev_shot_at}` : '';
  $('#cmpCur').src = `/shots/${id}/current.png?t=${s.shot_at}`;
  $('#cmpSignals').innerHTML = s.last_signals.map((g) => `<div class="sig ${esc(g.level)}">${esc(g.msg)}</div>`).join('');
  $('#cmp').showModal();
}
$('#cmpClose').onclick = () => $('#cmp').close();
$('#cmpDiff').onchange = () => {
  const on = $('#cmpDiff').checked;
  $('#cmpCanvas').classList.toggle('hidden', !on);
  $('#cmpCur').classList.toggle('hidden', on);
  if (on) drawDiff();
};
function drawDiff() {
  const a = $('#cmpPrev'), b = $('#cmpCur'), cv = $('#cmpCanvas');
  if (!a.naturalWidth || !b.naturalWidth) return;
  const w = b.naturalWidth, h = b.naturalHeight;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
  const t = tmp.getContext('2d');
  t.drawImage(a, 0, 0); const pa = t.getImageData(0, 0, w, h).data;
  ctx.drawImage(b, 0, 0); const img = ctx.getImageData(0, 0, w, h); const pb = img.data;
  for (let i = 0; i < pb.length; i += 4) {
    const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
    if (d > 60) { pb[i] = 255; pb[i + 1] = 0; pb[i + 2] = 60; }
    else { const g = (pb[i] + pb[i + 1] + pb[i + 2]) / 3; pb[i] = pb[i + 1] = pb[i + 2] = 200 + g * 0.2; }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------- Checks ----------
function fillSiteSelects() {
  for (const sel of ['#chkSite', '#alSite']) {
    const el = $(sel);
    if (el.options.length - 1 === overview.sites.length) continue;
    const v = el.value;
    el.innerHTML = '<option value="">Alle websites</option>' +
      overview.sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    el.value = v;
  }
}

async function loadChecks() {
  const p = new URLSearchParams({
    site: $('#chkSite').value, level: $('#chkLevel').value, hours: $('#chkHours').value,
    q: $('#chkSearch').value.trim(), sort: state.chkSort.key, dir: state.chkSort.dir, page: state.chkPage, limit: 100,
  });
  const r = await api('/checks?' + p);
  markSort('#checksTable', state.chkSort);
  $('#chkCount').textContent = `${r.total} checks`;
  $('#chkChips').innerHTML = ['hacked', 'offline', 'warning', 'ok']
    .map((l) => `<span class="chip" data-level="${l}">${LEVELS[l]}: <b>${r.counts[l] || 0}</b></span>`).join('');
  const pages = Math.max(1, Math.ceil(r.total / 100));
  $('#chkPage').textContent = `Pagina ${state.chkPage + 1} van ${pages}`;
  $('#chkPrev').disabled = state.chkPage === 0;
  $('#chkNext').disabled = state.chkPage >= pages - 1;
  $('#checksTable tbody').innerHTML = r.rows.map((c) => `<tr class="row-${esc(c.level)}">
      <td class="num">${fmtTime(c.ts)}</td>
      <td class="site"><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.name)}</a></td>
      <td>${pill(c.level)}</td>
      <td class="num">${c.status ?? '–'}</td>
      <td class="num">${c.ms != null ? (c.ms / 1000).toFixed(1) + ' s' : '–'}</td>
      <td class="num">${c.diff != null ? c.diff + ' %' : '–'}</td>
      <td>${c.signals.map((g) => `<div class="sig ${esc(g.level)}">${esc(g.msg)}</div>`).join('') || (c.error ? `<span class="muted">${esc(c.error)}</span>` : '<span class="muted">Geen afwijkingen</span>')}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">Geen checks gevonden voor deze filters.</td></tr>';
}
for (const id of ['#chkSite', '#chkLevel', '#chkHours']) $(id).onchange = () => { state.chkPage = 0; loadChecks(); };
let chkTimer;
$('#chkSearch').oninput = () => { clearTimeout(chkTimer); chkTimer = setTimeout(() => { state.chkPage = 0; loadChecks(); }, 300); };
$('#chkChips').onclick = (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  $('#chkLevel').value = $('#chkLevel').value === c.dataset.level ? '' : c.dataset.level;
  state.chkPage = 0; loadChecks();
};
$('#checksTable thead').onclick = (e) => {
  const k = e.target.closest('th')?.dataset.sort;
  if (!k) return;
  const s = state.chkSort;
  state.chkSort = { key: k, dir: s.key === k && s.dir === 'desc' ? 'asc' : 'desc' };
  if (k === 'level' && s.key !== k) state.chkSort.dir = 'asc';
  loadChecks();
};
$('#chkPrev').onclick = () => { state.chkPage--; loadChecks(); };
$('#chkNext').onclick = () => { state.chkPage++; loadChecks(); };

// ---------- Meldingen ----------
async function loadAlerts() {
  const p = new URLSearchParams({ state: $('#alState').value, level: $('#alLevel').value, site: $('#alSite').value });
  const rows = await api('/alerts?' + p);
  $('#alertList').innerHTML = rows.map((a) => `<div class="alert ${esc(a.level)} ${a.ack ? 'acked' : ''}">
      <div>${pill(a.level)}</div>
      <div class="body">
        <strong>${esc(a.title)} – <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.name)}</a></strong>
        <div class="meta">${fmtTime(a.ts)}${a.ack ? ` · afgehandeld ${fmtTime(a.ack_at)}` : ''}</div>
        <div class="msg">${esc(a.message)}</div>
      </div>
      <div class="actions">
        <button data-cmp="${a.site_id}">Screenshots</button>
        ${a.ack ? '' : `<button data-ack="${a.id}">✓ Afhandelen</button>`}
      </div>
    </div>`).join('') || '<p class="muted">Geen meldingen.</p>';
}
for (const id of ['#alState', '#alLevel', '#alSite']) $(id).onchange = loadAlerts;
$('#alertList').onclick = async (e) => {
  const ack = e.target.closest('[data-ack]');
  if (ack) { await api(`/alerts/${ack.dataset.ack}/ack`, { body: {} }); refresh(); }
  const cmp = e.target.closest('[data-cmp]');
  if (cmp) openCompare(+cmp.dataset.cmp);
};
$('#ackAll').onclick = async () => {
  if (!confirm('Alle open meldingen afhandelen?')) return;
  await api('/alerts/ack-all', { body: {} });
  refresh();
};

// ---------- Live meldingen op scherm ----------
let lastSeen = store.get('lastAlertId', null);
async function checkNewAlerts() {
  if (lastSeen == null) { lastSeen = overview.latestAlertId; store.set('lastAlertId', lastSeen); return; }
  if (overview.latestAlertId <= lastSeen) return;
  const fresh = (await api(`/alerts?after=${lastSeen}`)).reverse();
  lastSeen = overview.latestAlertId;
  store.set('lastAlertId', lastSeen);
  if (fresh.some((a) => a.level !== 'info')) beep(fresh.some((a) => a.level === 'hacked'));
  for (const a of fresh.slice(-6)) {
    toast(a);
    if (window.Notification?.permission === 'granted' && a.level !== 'info')
      new Notification(`${a.title}: ${a.name}`, { body: a.message, tag: 'wm-' + a.id, requireInteraction: a.level === 'hacked' });
  }
}

function toast(a) {
  const el = document.createElement('div');
  el.className = `toast ${a.level}`;
  el.innerHTML = `<strong>${esc(a.title)}: ${esc(a.name)}</strong><div class="msg">${esc(a.message)}</div>`;
  el.onclick = () => { el.remove(); location.hash = '#alerts'; };
  $('#toasts').appendChild(el);
  if (a.level === 'info' || a.level === 'warning') setTimeout(() => el.remove(), 15000);
}

function beep(urgent) {
  try {
    const ctx = new AudioContext();
    const notes = urgent ? [880, 660, 880, 660] : [660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.22);
      o.start(ctx.currentTime + i * 0.25); o.stop(ctx.currentTime + i * 0.25 + 0.24);
    });
  } catch {}
}

$('#notifBtn').onclick = async () => {
  if (!window.Notification) return alert('Deze browser ondersteunt geen bureaubladmeldingen.');
  const p = await Notification.requestPermission();
  $('#notifBtn').textContent = p === 'granted' ? '🔔✓' : '🔕';
};
if (window.Notification?.permission === 'granted') $('#notifBtn').textContent = '🔔✓';

showTab();
refresh();
setInterval(refresh, 10000);
setInterval(renderStatus, 1000);
