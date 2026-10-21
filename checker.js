// Voert één check uit op een website: bereikbaarheid, hack-signalen in de HTML,
// cloaking (spam alleen voor Googlebot) en screenshotvergelijking met 5 minuten eerder.
import { chromium } from 'playwright-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { SHOTS_DIR } from './store.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const VIEWPORT = { width: 1366, height: 900 };

// Teksten die vrijwel altijd op een defacement duiden.
const DEFACE = [
  ['hacked-by', /h[a4]ck[e3]d\s+by\b/i, 'Tekst "hacked by" gevonden'],
  ['defaced', /defac(?:ed|ement)\s+by\b/i, 'Tekst "defaced by" gevonden'],
  ['site-hacked', /(?:this|your)\s+(?:site|website)\s+(?:has\s+been|was|is)\s+(?:hacked|pwned|owned)/i, 'Melding "this site has been hacked"'],
  ['pwned', /\bpwn[e3]d\s+by\b/i, 'Tekst "pwned by" gevonden'],
  ['greetz', /\bgreetz\b/i, 'Hacker-groet ("greetz") gevonden'],
  ['ransom', /(?:your|all)\s+(?:files|data|website)\s+(?:have|has)\s+been\s+encrypted/i, 'Ransomware-melding gevonden'],
];
// Kwaadaardige code-patronen (alleen gemeld als ze nieuw zijn t.o.v. de baseline).
const MALWARE = [
  ['miner', /coinhive|cryptonight|coin-hive|webminer|cryptoloot/i, 'Cryptominer-script'],
  ['eval-atob', /eval\s*\(\s*atob\s*\(/i, 'Verborgen code: eval(atob(...))'],
  ['eval-packer', /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e/i, 'Ingepakte (packed) JavaScript'],
  ['unescape-write', /document\.write\s*\(\s*unescape\s*\(/i, 'document.write(unescape(...))'],
  ['fromcharcode', /String\.fromCharCode\s*\(\s*(?:\d+\s*,\s*){40,}/i, 'Versleutelde code via String.fromCharCode'],
  ['ndsw', /\bvar\s+nds[wx]\s*=|\bndsj\b/i, 'Bekende WordPress-malware (ndsw)'],
  ['hidden-iframe', /<iframe[^>]*\b(?:width|height)\s*=\s*["']?0(?:px)?["'\s>]/i, 'Verborgen iframe'],
  ['webshell', /\b(?:c99|r57|wso)\s*shell\b|FilesMan|b374k/i, 'Webshell-sporen'],
];
// Spam-injecties (SEO-spam). Alleen nieuw t.o.v. baseline telt.
const SPAM = [
  ['pharma', /\b(?:viagra|cialis|levitra|kamagra)\b/i, 'farmaspam (viagra/cialis)'],
  ['gambling', /\b(?:casino|slot\s*gacor|situs\s+judi|togel|bandar\s+judi|poker\s+online)\b/i, 'gokspam (casino/slot)'],
  ['porn', /\b(?:porn|xxx\s+videos?|sex\s+cams?)\b/i, 'pornospam'],
  ['replica', /\breplica\s+(?:watches|handbags|rolex)\b/i, 'replica-spam'],
  ['loans', /\bpayday\s+loans?\b/i, 'leningspam'],
  ['crypto-scam', /\b(?:bitcoin|crypto)\s+(?:giveaway|doubler)\b/i, 'crypto-scam'],
  ['japanese', /[぀-ヿ一-龯]{30,}/, 'Japanse keyword-hack'],
];
// Zichtbare tekst die meldt dat de site offline / in onderhoud / gehackt is.
// Gevonden → website krijgt automatisch de status Offline (verdwijnt vanzelf als de tekst weg is).
const NOTICE = [
  ['maintenance', /\b(?:wegens|vanwege|in|i\.?v\.?m\.?|gepland|tijdelijk)\s+onderhoud\b|\bonderhoudsmodus\b|\bunder\s+(?:maintenance|construction)\b|\bmaintenance\s+mode\b|\bscheduled\s+maintenance\b|\bwartungs(?:arbeiten|modus)\b|\ben\s+(?:cours\s+de\s+)?maintenance\b/i, 'onderhoud'],
  ['offline', /\b(?:website|site|webshop|webwinkel|pagina|shop)\s+(?:is\s+)?(?:momenteel\s+|tijdelijk\s+|currently\s+|temporarily\s+)*(?:offline|niet\s+(?:beschikbaar|bereikbaar)|down|unavailable)\b|\btijdelijk\s+(?:offline|niet\s+(?:beschikbaar|bereikbaar)|buiten\s+gebruik)\b|\btemporarily\s+(?:unavailable|offline|down|closed)\b|\bvorübergehend\s+(?:nicht\s+erreichbar|offline|geschlossen)\b|\btemporairement\s+(?:indisponible|hors\s+ligne)\b/i, 'offline/niet beschikbaar'],
  ['back-soon', /\b(?:we|wij)\s+zijn\s+(?:zo|snel|binnenkort)\s+(?:weer\s+)?(?:terug|online|bereikbaar)\b|\bbinnenkort\s+weer\s+(?:online|beschikbaar|bereikbaar)\b|\bwe(?:'|’)?ll\s+be\s+back\s+(?:soon|shortly)\b|\bbe\s+right\s+back\b/i, 'zijn zo terug'],
  ['suspended', /\b(?:account|website|hosting)\s+(?:has\s+been\s+|is\s+)?(?:suspended|opgeschort|geblokkeerd|gedeactiveerd)\b|\b(?:dit|this)\s+dom(?:ein|ain)\s+(?:is\s+)?(?:geparkeerd|parked|te\s+koop|for\s+sale)\b/i, 'opgeschort/geparkeerd'],
  ['hack-notice', /\b(?:wegens|vanwege|door|na|i\.?v\.?m\.?|due\s+to|because\s+of)\s+(?:een\s+|a\s+)?(?:hack|hacking|beveiligingslek|beveiligingsincident|lek\s+in\s+php|php-?lek|cyber\s*-?aanval|security\s+(?:incident|breach|issue)|cyber\s*-?attack)\b|\buit\s+(?:voorzorg|veiligheidsoverwegingen)\s+(?:offline|uit\s+de\s+lucht)\b|\buit\s+de\s+lucht\s+gehaald\b|\btaken\s+offline\b/i, 'melding over hack/beveiligingsincident'],
];

const PHP_ERR = /\b(?:Fatal error|Parse error|Uncaught (?:Error|Exception)|Warning|Deprecated|Notice)\b(?:<\/b>)?:[\s\S]{0,400}?\.php(?:<\/b>)?\s+on\s+line\s+(?:<b>)?\d+/i;

let browser = null;
let browserName = null;
let launching = null;

export const browserInfo = () => browserName;

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    for (const opt of [{ channel: 'msedge' }, { channel: 'chrome' }, {}]) {
      try {
        browser = await chromium.launch({ ...opt, headless: true });
        browserName = opt.channel || 'chromium';
        return browser;
      } catch {
        /* volgende proberen */
      }
    }
    browser = null;
    browserName = null;
    return null;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
}

const errMsg = (e) => String(e?.cause?.code || e?.message || e).split('\n')[0].slice(0, 300);

const hostOf = (u, base) => {
  try {
    return new URL(u, base).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

async function fetchPage(url, ua) {
  const t = Date.now();
  const r = await fetch(url, {
    headers: {
      'user-agent': ua,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const html = (await r.text()).slice(0, 3_000_000);
  const headers = Object.fromEntries(r.headers);
  headers['set-cookie'] = r.headers.getSetCookie().join('\n');
  return { status: r.status, finalUrl: r.url, html, headers, ms: Date.now() - t };
}

function scan(list, html) {
  return list.filter(([, re]) => re.test(html)).map(([k]) => k);
}

function analyzeHtml(html, pageUrl, siteHost) {
  const title = decode(
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  ).slice(0, 200);
  const hosts = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const h = hostOf(m[1], pageUrl);
    if (h && h !== siteHost && !h.endsWith('.' + siteHost)) hosts.add(h);
  }
  return {
    title,
    scriptHosts: [...hosts].sort(),
    deface: scan(DEFACE, html),
    malware: scan(MALWARE, html),
    spam: scan(SPAM, html),
    phpError: PHP_ERR.test(html),
    htmlLength: html.length,
    finalHost: hostOf(pageUrl),
  };
}

const htmlToText = (html) =>
  decode(
    html
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ');

// Zoekt offline-/onderhouds-/hackmeldingen in zichtbare tekst; geeft [{key, label, snippet}].
function findNotices(text) {
  const found = [];
  for (const [key, re, lbl] of NOTICE) {
    const m = re.exec(text);
    if (!m) continue;
    const from = Math.max(0, m.index - 60);
    const snippet = text.slice(from, m.index + m[0].length + 60).replace(/\s+/g, ' ').trim();
    found.push({ key, label: lbl, snippet: (from ? '…' : '') + snippet + '…' });
  }
  return found;
}

// PHP-versie passief bepalen uit wat de server zelf meestuurt (headers) en platform-kenmerken.
// Geeft { version, platform, source } of null als er geen PHP te zien is.
const PLATFORMS = [
  ['WordPress', /\/wp-(?:content|includes)\//i],
  ['WooCommerce', /woocommerce/i],
  ['Magento', /\bMage\.Cookies|\/static\/version\d+\/|mage\/cookies/i],
  ['Drupal', /Drupal\.settings|drupal-settings-json|\/sites\/default\/files\//i],
  ['Joomla', /\/media\/jui\/|Joomla!/i],
  ['Shopware', /shopware/i],
  ['PrestaShop', /prestashop/i],
  ['Craft CMS', /CraftSessionId|Craft CMS/i],
];
// Bewaart X-Powered-By / Server-headers die "PHP" noemen van verzoeken naar dezelfde site.
function collectPhpHeader(extra, url, headers, siteHost) {
  if (extra.length >= 20) return;
  const h = hostOf(url);
  if (!h || (h !== siteHost && !h.endsWith('.' + siteHost))) return;
  const powered = String(headers['x-powered-by'] || '');
  const server = String(headers.server || '');
  if (!/php/i.test(powered + server)) return;
  let p = url;
  try { p = new URL(url).pathname; } catch {}
  extra.push({ path: p.slice(0, 60), powered: /php/i.test(powered) ? powered : '', server });
}

function detectPhp(headers, html, extra = []) {
  const h = (k) => String(headers[k] || '');
  const powered = h('x-powered-by');
  const cookies = h('set-cookie');
  const generator = h('x-generator') + ' ' + (html.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)/i)?.[1] || '');
  const platform =
    PLATFORMS.find(([, re]) => re.test(html) || re.test(generator) || re.test(cookies))?.[0] ||
    (/laravel_session/i.test(cookies) ? 'Laravel' : null);

  for (const [src, val] of [['X-Powered-By', powered], ['Server', h('server')]]) {
    const m = val.match(/PHP\/?\s*(\d+\.\d+(?:\.\d+)?)/i);
    if (m) return { version: m[1], platform, source: `${src}: ${val}`.slice(0, 120) };
  }
  // Headers van overige verzoeken (AJAX, REST API) – zoals Wappalyzer dat ook doet.
  for (const e of extra) {
    const val = e.powered || e.server;
    const m = val.match(/PHP\/?\s*(\d+\.\d+(?:\.\d+)?)/i);
    if (m) return { version: m[1], platform, source: `${e.path}: ${val}`.slice(0, 120) };
  }
  if (/php/i.test(powered)) return { version: null, platform, source: `X-Powered-By: ${powered}` };
  if (/PHPSESSID/i.test(cookies)) return { version: null, platform, source: 'PHPSESSID-cookie' };
  if (platform && platform !== 'Shopify') return { version: null, platform, source: `${platform} (draait op PHP)` };
  if (/\.php(?:[?"'#\s]|$)/i.test(html.slice(0, 500000))) return { version: null, platform, source: 'Links naar .php-bestanden' };
  return null;
}

function visualDiff(prevBuf, curBuf) {
  const a = PNG.sync.read(prevBuf);
  const b = PNG.sync.read(curBuf);
  if (a.width !== b.width || a.height !== b.height) return 1;
  const n = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.15 });
  return n / (a.width * a.height);
}

// Aandeel pixels met (vrijwel) dezelfde kleur als de meest voorkomende → witte/lege pagina.
function blankRatio(buf) {
  const p = PNG.sync.read(buf);
  const counts = new Map();
  let total = 0;
  for (let i = 0; i < p.data.length; i += 4 * 7) {
    const key = ((p.data[i] >> 3) << 10) | ((p.data[i + 1] >> 3) << 5) | (p.data[i + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
    total++;
  }
  return Math.max(...counts.values()) / total;
}

const label = (list, keys) => keys.map((k) => list.find(([key]) => key === k)?.[2] || k);

export async function checkSite(site) {
  const out = {
    ts: Date.now(),
    status: null,
    ms: null,
    diff: null,
    error: null,
    signals: [],
    snapshot: null,
    level: 'ok',
    shotSaved: false,
    php: null,
  };
  const siteHost = hostOf(site.url);
  let html = '';
  let headers = {};
  const extra = []; // PHP-headers uit overige verzoeken van dezelfde site
  let text = '';
  let finalUrl = site.url;
  let shot = null;

  // 1. Echte browser (Edge headless): status, ruwe HTML en screenshot.
  const b = await getBrowser();
  if (b) {
    let ctx;
    try {
      ctx = await b.newContext({ viewport: VIEWPORT, userAgent: UA, locale: 'nl-NL' });
      const page = await ctx.newPage();
      page.on('response', (r) => collectPhpHeader(extra, r.url(), r.headers(), siteHost));
      const t = Date.now();
      const resp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      out.ms = Date.now() - t;
      out.status = resp?.status() ?? null;
      finalUrl = page.url();
      html = await resp?.text().catch(() => '') || '';
      headers = await resp?.allHeaders().catch(() => ({})) || {};
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await page
        .addStyleTag({
          content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
        })
        .catch(() => {});
      await page.waitForTimeout(1500);
      text = await page
        .evaluate(() => (document.body?.innerText || '').slice(0, 300000))
        .catch(() => '');
      shot = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 15000 });
    } catch (e) {
      out.error = errMsg(e);
    } finally {
      await ctx?.close().catch(() => {});
    }
  }

  // 2. Fallback met gewone HTTP-request (geen browser, of browser geblokkeerd door firewall).
  if (out.status == null || out.status >= 400) {
    try {
      const f = await fetchPage(site.url, UA);
      if (out.status == null || f.status < 400) {
        out.status = f.status;
        out.ms = f.ms;
        finalUrl = f.finalUrl;
        html = f.html;
        headers = f.headers;
        text = '';
        out.error = null;
        if (f.status >= 400) shot = null;
      }
    } catch (e) {
      if (out.status == null) out.error = out.error || errMsg(e);
    }
  }

  const add = (key, level, msg) => out.signals.push({ key, level, msg });

  // Offline?
  if (out.status == null || out.status >= 500) {
    out.level = 'offline';
    add('offline', 'critical', out.status ? `Server geeft HTTP ${out.status}` : `Niet bereikbaar: ${out.error || 'onbekende fout'}`);
    return out;
  }
  if (out.status >= 400) {
    add(`http-${out.status}`, 'warning',
      out.status === 403 || out.status === 429
        ? `HTTP ${out.status} – mogelijk geblokkeerd door firewall/bot-bescherming`
        : `Homepage geeft HTTP ${out.status}`);
    out.level = 'warning';
    return out; // foutpagina niet vergelijken met baseline
  }

  // 3. Inhoudsanalyse t.o.v. baseline (laatste "goede" staat).
  const base = site.baseline;
  const snap = analyzeHtml(html, finalUrl, siteHost);
  const isNew = (k, field) => !base || !(base[field] || []).includes(k);

  // Pagina meldt zelf dat hij offline / in onderhoud / gehackt is → Offline-tag.
  const notices = findNotices(text.trim() ? text.replace(/\s+/g, ' ') : htmlToText(html));
  snap.notice = notices.map((n) => n.key);
  const newNotices = notices.filter((n) => isNew(n.key, 'notice'));
  for (const n of newNotices)
    add(`notice:${n.key}`, 'critical', `Pagina meldt ${n.label}: "${n.snippet}"`);

  const deface = snap.deface.filter((k) => isNew(k, 'deface'));
  if (deface.length) add('deface', 'critical', `Defacement: ${label(DEFACE, deface).join(', ')}`);

  const malware = snap.malware.filter((k) => isNew(k, 'malware'));
  if (base && malware.length) add('malware', 'critical', `Verdachte code: ${label(MALWARE, malware).join(', ')}`);

  const spam = snap.spam.filter((k) => isNew(k, 'spam'));
  if (base && spam.length) add('spam', 'warning', `Nieuwe spam-woorden: ${label(SPAM, spam).join(', ')}`);

  if (snap.phpError && !base?.phpError) add('php-error', 'warning', 'PHP-foutmelding zichtbaar op homepage');

  if (base?.finalHost && snap.finalHost && snap.finalHost !== base.finalHost)
    add('redirect', 'critical', `Homepage stuurt nu door naar ${snap.finalHost} (was ${base.finalHost})`);

  if (base?.title && snap.title !== base.title)
    add('title', 'warning', `Paginatitel gewijzigd: "${snap.title || '(leeg)'}" (was "${base.title}")`);

  const newHosts = base ? snap.scriptHosts.filter((h) => !base.scriptHosts.includes(h)) : [];
  if (newHosts.length) add('scripts', 'warning', `Nieuwe externe scripts: ${newHosts.slice(0, 5).join(', ')}`);

  if (base?.htmlLength && snap.htmlLength < base.htmlLength * 0.2)
    add('size', 'warning', `Pagina is veel kleiner geworden (${Math.round(snap.htmlLength / 1024)} KB, was ${Math.round(base.htmlLength / 1024)} KB)`);

  // Cloaking: spam die alleen aan Googlebot wordt getoond.
  try {
    const bot = await fetchPage(site.url, BOT_UA);
    if (bot.status < 400) {
      const botSpam = scan(SPAM, bot.html).filter((k) => !snap.spam.includes(k) && isNew(k, 'botSpam'));
      snap.botSpam = scan(SPAM, bot.html);
      if (botSpam.length)
        add('cloaking', 'critical', `Spam alleen zichtbaar voor Google (cloaking): ${label(SPAM, botSpam).join(', ')}`);
    }
  } catch {
    /* Googlebot-check is optioneel */
  }
  snap.botSpam ||= base?.botSpam || [];

  // 4. Screenshot vergelijken met 5 minuten geleden; max 2 per klant bewaren.
  if (shot) {
    const dir = path.join(SHOTS_DIR, String(site.id));
    fs.mkdirSync(dir, { recursive: true });
    const cur = path.join(dir, 'current.png');
    const prev = path.join(dir, 'previous.png');
    if (fs.existsSync(cur)) {
      try {
        out.diff = Math.round(visualDiff(fs.readFileSync(cur), shot) * 1000) / 10;
      } catch {
        out.diff = null;
      }
      fs.renameSync(cur, prev);
    }
    fs.writeFileSync(cur, shot);
    out.shotSaved = true;

    snap.blank = blankRatio(shot) > 0.985;
    if (snap.blank && !base?.blank) add('blank', 'warning', 'Homepage is (bijna) leeg / wit scherm');
    if (out.diff != null && out.diff >= site.diff_threshold)
      add('visual', 'warning', `Homepage ziet er ${out.diff}% anders uit dan bij de vorige check`);
  }

  out.php = detectPhp(headers, html, extra);
  if (out.php && !out.php.version) {
    // Homepage komt vaak uit de cache; dynamische endpoints lopen wél via PHP.
    const origin = new URL(finalUrl).origin;
    const paths = out.php.platform === 'WordPress' || out.php.platform === 'WooCommerce'
      ? ['/wp-json/', '/wp-admin/admin-ajax.php']
      : [];
    for (const p of paths) {
      try {
        const r = await fetch(origin + p, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
        await r.body?.cancel();
        collectPhpHeader(extra, r.url, Object.fromEntries(r.headers), siteHost);
      } catch {}
      const found = detectPhp(headers, html, extra);
      if (found?.version) { out.php = found; break; }
    }
  }
  out.snapshot = snap;
  const critical = out.signals.some((s) => s.level === 'critical');
  const visual = out.signals.some((s) => s.key === 'visual' || s.key === 'blank');
  const content = out.signals.some((s) => ['title', 'spam', 'scripts', 'size', 'php-error'].includes(s.key));
  const onlyNotices = out.signals.filter((s) => s.level === 'critical').every((s) => s.key.startsWith('notice:'));
  out.level = newNotices.length && onlyNotices
    ? 'offline'
    : critical || (visual && content) ? 'hacked' : out.signals.length ? 'warning' : 'ok';
  if (out.level === 'hacked' && !critical)
    out.signals.unshift({ key: 'combo', level: 'critical', msg: 'Visuele én inhoudelijke wijziging tegelijk' });
  return out;
}
