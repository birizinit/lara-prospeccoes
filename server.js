/* Lara - Prospecções — servidor local (Node puro, sem dependências).
 * Proxy Apify (Google Maps) + Neppo (WhatsApp) + agendador de drip.
 * Segredos vêm do .env; parâmetros do config.json. Ver README.md.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// ⚠️ O disco do container é EFÊMERO: sem DATA_DIR apontando p/ um Volume, um redeploy zeraria o
// contador do mês (risco de estourar o teto de 1000) e apagaria a fila de leads.
const DATA_DIR = process.env.DATA_DIR || ROOT;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* já existe */ }
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

// ---------- .env + config ----------
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = parseInt(process.env.PORT || '3100', 10);
const NEPPO_TLS = process.env.NEPPO_STRICT_TLS === '1';

// ---------- estado ----------
const log = [];
function pushLog(level, msg) {
  const e = { t: new Date().toISOString(), level, msg };
  log.push(e); if (log.length > 500) log.shift();
  console.log(`[${e.t}] ${level.toUpperCase()} ${msg}`);
  if (level === 'sent') alertaEvo('✅ Lara enviou · ' + msg);        // avisa cada disparo
  else if (level === 'error') alertaEvo('⚠️ Lara erro · ' + msg);   // avisa cada erro
}
function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function saveJSON(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2)); }

let state = loadJSON(STATE_FILE, { monthKey: '', dayKey: '', monthSent: 0, daySent: 0, lastSendAt: 0, runtimeCfg: {} });
let leads = loadJSON(LEADS_FILE, []);
// runtime overrides (paused/dryRun) persistem por cima do config
const rt = Object.assign({ paused: CFG.campaign.paused, dryRun: CFG.campaign.dryRun }, state.runtimeCfg || {});
function persist() { state.runtimeCfg = { paused: rt.paused, dryRun: rt.dryRun }; saveJSON(STATE_FILE, state); saveJSON(LEADS_FILE, leads); }

// ---------- alerta Evolution (WhatsApp interno p/ o Gabriel) ----------
const EVO = {
  url: (process.env.EVOLUTION_URL || '').replace(/\/+$/, ''),
  instance: process.env.EVOLUTION_INSTANCE || '',
  apikey: process.env.EVOLUTION_APIKEY || '',
  to: process.env.ALERT_NUMBER || '',
};
let _evoWarned = false;
// fire-and-forget: nunca bloqueia o drip, nunca derruba a Lara, e NUNCA chama pushLog (evita loop)
function alertaEvo(text) {
  if (!(EVO.url && EVO.instance && EVO.apikey && EVO.to)) {
    if (!_evoWarned) { _evoWarned = true; console.log('[evo] alerta OFF — falta EVOLUTION_URL/INSTANCE/APIKEY/ALERT_NUMBER'); }
    return;
  }
  const url = `${EVO.url}/message/sendText/${encodeURIComponent(EVO.instance)}`;
  request(url, { method: 'POST', headers: { apikey: EVO.apikey, 'Content-Type': 'application/json' },
                 body: { number: EVO.to, text }, rejectUnauthorized: false })
    .then(r => { if (r.status >= 300) console.log('[evo] HTTP ' + r.status + ' ' + (r.text || '').slice(0, 140)); })
    .catch(e => console.log('[evo] falhou: ' + e.message));
}
// se a Lara CAIR, avisa antes de morrer (o Fly reinicia a máquina)
process.on('uncaughtException', (e) => { try { alertaEvo('🔴 Lara CAIU (exceção): ' + (e && e.message || e)); } catch {} console.error('uncaughtException', e); setTimeout(() => process.exit(1), 1500); });
process.on('unhandledRejection', (e) => { try { alertaEvo('🔴 Lara: promise rejeitada · ' + (e && e.message || e)); } catch {} console.error('unhandledRejection', e); });
// aviso de que subiu/reiniciou (também sinaliza recuperação de queda)
setTimeout(() => alertaEvo(`🤖 Lara subiu · dryRun=${rt.dryRun} · paused=${rt.paused}`), 2500);

// ---------- util HTTP ----------
function request(urlStr, { method = 'GET', headers = {}, body = null, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = { method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({}, headers), port: u.port || 443, rejectUnauthorized };
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    if (data) { opts.headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// ---------- telefone BR ----------
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!d.startsWith('55')) { if (d.length === 10 || d.length === 11) d = '55' + d; }
  if (d.length < 12 || d.length > 13) return null;          // 55 + DDD(2) + 8/9
  const sub = d.slice(4);                                    // parte após 55+DDD
  const isMobile = sub.length === 9 && sub[0] === '9';
  return { e164: d, isMobile };
}

// ---------- Apify ----------
function circlePolygon(lat, lng, radiusKm, n = 36) {
  const coords = [];
  const R = 6371;
  for (let i = 0; i <= n; i++) {
    const brng = (i / n) * 2 * Math.PI;
    const dr = radiusKm / R;
    const lat2 = Math.asin(Math.sin(lat * Math.PI / 180) * Math.cos(dr) + Math.cos(lat * Math.PI / 180) * Math.sin(dr) * Math.cos(brng));
    const lng2 = (lng * Math.PI / 180) + Math.atan2(Math.sin(brng) * Math.sin(dr) * Math.cos(lat * Math.PI / 180), Math.cos(dr) - Math.sin(lat * Math.PI / 180) * Math.sin(lat2));
    coords.push([lng2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

const APIFY = 'https://api.apify.com/v2';
function apifyInput(niche, loc, cap) {
  const input = { searchStringsArray: [niche], maxCrawledPlacesPerSearch: cap,
    countryCode: CFG.apify.countryCode, skipClosedPlaces: true, scrapePlaceDetailPage: false };
  if (CFG.apify.language) input.language = CFG.apify.language;
  if (loc.locationQuery) input.locationQuery = loc.locationQuery;
  else input.customGeolocation = circlePolygon(loc.lat, loc.lng, loc.radiusKm || 5);
  return input;
}
async function apifyStart(input) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN ausente no .env');
  const r = await request(`${APIFY}/acts/${CFG.apify.actorId}/runs?token=${token}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input });
  const run = r.json && r.json.data;
  if (!run) throw new Error('Apify não iniciou: ' + (r.text || '').slice(0, 200));
  return { runId: run.id, datasetId: run.defaultDatasetId };
}
async function apifyWait({ runId, datasetId }) {
  const token = process.env.APIFY_TOKEN;
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const st = await request(`${APIFY}/actor-runs/${runId}?token=${token}`);
    const s = st.json && st.json.data && st.json.data.status;
    if (s === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(s)) throw new Error('Apify run ' + s);
  }
  const items = await request(`${APIFY}/datasets/${datasetId}/items?token=${token}&clean=true&format=json`);
  return Array.isArray(items.json) ? items.json : [];
}

// ---------- geocoding de cidades (Nominatim/OSM) ----------
async function searchCities(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=br&addressdetails=1&limit=10&q=${encodeURIComponent(q)}`;
  const r = await request(url, { headers: { 'User-Agent': 'Lara-Prospeccoes/1.0 (ferramenta interna Lar Plasticos)' } });
  const arr = Array.isArray(r.json) ? r.json : [];
  const types = new Set(['city', 'town', 'municipality', 'village', 'administrative']);
  const out = [], seen = new Set();
  for (const it of arr) {
    const a = it.address || {};
    const name = a.city || a.town || a.municipality || a.village || (types.has(it.addresstype) ? it.name : null);
    if (!name) continue;
    const state = a.state || '';
    const key = (name + '|' + state).toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    out.push({ name, state, display: `${name}${state ? ', ' + state : ''}, Brasil`, lat: parseFloat(it.lat), lng: parseFloat(it.lon) });
  }
  return out;
}

// ---------- Neppo ----------
let neppoTok = { token: null, exp: 0 };
async function neppoAuth() {
  if (neppoTok.token && Date.now() < neppoTok.exp) return neppoTok.token;
  const basic = Buffer.from(`${process.env.NEPPO_CUSTOMER_KEY}:${process.env.NEPPO_CUSTOMER_SECRET}`).toString('base64');
  const body = `grant_type=password&username=${encodeURIComponent(process.env.NEPPO_USERNAME)}&password=${encodeURIComponent(process.env.NEPPO_PASSWORD)}`;
  const r = await request('https://api-auth.neppo.com.br/oauth2/token',
    { method: 'POST', headers: { 'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body, rejectUnauthorized: NEPPO_TLS });
  if (!r.json || !r.json.access_token) throw new Error('Neppo auth falhou: ' + r.status);
  neppoTok = { token: r.json.access_token, exp: Date.now() + (r.json.expires_in - 120) * 1000 };
  return neppoTok.token;
}
let tplCache = null;
async function neppoTemplate() {
  if (tplCache) return tplCache;
  const tok = await neppoAuth();
  // ⚠️ a API corta em 50 por página (ignora size maior) — paginar até achar, senão templates
  // de id alto (ex.: 110) somem silenciosamente. Mesmo bug já corrigido no app Briefing.
  let t = null;
  for (let pg = 0; pg < 20 && !t; pg++) {
    const r = await request('https://api.neppo.com.br/chatapi/1.0/api/hsm-template',
      { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: { conditions: [], page: pg, size: 50 }, rejectUnauthorized: NEPPO_TLS });
    const list = (r.json && r.json.results) || [];
    t = list.find(x => x.id === CFG.neppo.templateId);
    if (list.length < 50) break;
  }
  if (!t) throw new Error('Template id ' + CFG.neppo.templateId + ' não encontrado na Neppo');
  tplCache = { nameSpace: t.nameSpace, elementName: t.elementName, text: t.template || t.description || '' };
  pushLog('info', `Neppo template ${CFG.neppo.templateId} = ${t.elementName} (${t.parameterCount} params)`);
  return tplCache;
}
async function neppoSend(phoneE164) {
  const tok = await neppoAuth();
  const tpl = await neppoTemplate();
  // o template pode ter HEADER de mídia (ex.: 110 fixo_lara usa 1 imagem) — vai em `medias`
  const img = CFG.neppo.headerImage;
  const ext = img ? (img.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase() : '.jpg';
  const medias = img ? { HEADER: [{ url: img, extension: ext }] } : {};
  const additionalInfo = JSON.stringify({ namespace: tpl.nameSpace, elementName: tpl.elementName, parameters: {}, medias, openSession: false });
  const body = {
    phoneNumber: phoneE164, channel: CFG.neppo.channel, message: tpl.text,
    groupName: CFG.neppo.groupName, additionalInfo, status: 'PROCESSANDO',
    createdBy: CFG.neppo.createdBy, userId: CFG.neppo.userId, senderUserId: CFG.neppo.senderUserId,
    groupConfId: CFG.neppo.groupConfId, generatedSession: 0,
  };
  const r = await request('https://api.neppo.com.br/chatapi/1.0/api/direct-message/save',
    { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body, rejectUnauthorized: NEPPO_TLS });
  if (r.status >= 200 && r.status < 300 && r.json && r.json.id) return { ok: true, id: r.json.id };
  return { ok: false, error: `HTTP ${r.status} ${(r.text || '').slice(0, 160)}` };
}

// ---------- tempo / horário comercial (São Paulo) ----------
function spParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: CFG.campaign.timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = {}; for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dayKey: `${p.year}-${p.month}-${p.day}`, monthKey: `${p.year}-${p.month}`,
    hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10), wd: weekdayMap[p.weekday] };
}
function isBusinessNow(t) {
  return t.wd >= 1 && t.wd <= 5 && t.hour >= CFG.campaign.businessHourStart && t.hour < CFG.campaign.businessHourEnd;
}
function rollovers(t) {
  if (state.monthKey !== t.monthKey) { state.monthKey = t.monthKey; state.monthSent = 0; }
  if (state.dayKey !== t.dayKey) { state.dayKey = t.dayKey; state.daySent = 0; }
}
function nextGapMs(t) {
  const remainDaily = Math.max(1, CFG.campaign.dailyCap - state.daySent);
  const minsLeft = Math.max(1, (CFG.campaign.businessHourEnd - (t.hour + t.minute / 60)) * 60);
  const gap = (minsLeft / remainDaily) * 60000;
  const j = 1 + (Math.random() * 2 - 1) * CFG.campaign.jitterPct;
  return gap * j;
}

// ---------- agendador (drip) ----------
function queued() { return leads.filter(l => l.status === 'queued'); }
async function tick() {
  try {
    const t = spParts();
    rollovers(t);
    if (rt.paused) return;
    if (!isBusinessNow(t)) return;
    if (state.monthSent >= CFG.campaign.monthlyCap) return;
    if (state.daySent >= CFG.campaign.dailyCap) return;
    if (Date.now() - state.lastSendAt < nextGapMs(t)) return;
    const lead = queued().find(l => l.phoneNorm && (!CFG.campaign.onlyMobileWhatsapp || l.isMobile));
    if (!lead) return;
    if (rt.dryRun) {
      lead.status = 'sent'; lead.dryRun = true; lead.sentAt = new Date().toISOString();
      pushLog('dry', `(DRY) enviaria p/ ${lead.name} — ${lead.phoneNorm}`);
    } else {
      const res = await neppoSend(lead.phoneNorm);
      if (res.ok) { lead.status = 'sent'; lead.sentAt = new Date().toISOString(); lead.msgId = res.id; pushLog('sent', `WhatsApp -> ${lead.name} (${lead.phoneNorm}) id=${res.id}`); }
      else { lead.status = 'failed'; lead.error = res.error; pushLog('error', `Falha ${lead.name}: ${res.error}`); persist(); return; }
    }
    state.lastSendAt = Date.now(); state.daySent++; state.monthSent++;
    persist();
  } catch (e) { pushLog('error', 'tick: ' + e.message); }
}
setInterval(tick, 20000);

// ---------- ingest leads ----------
function addLeads(items, niche, city) {
  const seen = new Set(leads.map(l => l.key));
  let added = 0, skipped = 0;
  for (const it of items) {
    const loc = it.location || {};
    const lat = loc.lat, lng = loc.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const rawPhone = it.phoneUnformatted || it.phone || '';
    const np = normalizePhone(rawPhone);
    const key = (np && np.e164) || (it.placeId || it.title + '|' + lat.toFixed(4) + ',' + lng.toFixed(4));
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const noPhone = !np;
    leads.push({
      key, id: 'L' + (leads.length + 1), name: it.title || 's/ nome', category: it.categoryName || '',
      address: it.address || '', website: it.website || '', rawPhone, city: city || '',
      phoneNorm: np ? np.e164 : null, isMobile: np ? np.isMobile : false,
      lat, lng, niche, addedAt: new Date().toISOString(),
      status: noPhone ? 'skipped' : ((CFG.campaign.onlyMobileWhatsapp && !np.isMobile) ? 'skipped' : 'queued'),
      reason: noPhone ? 'sem telefone' : ((CFG.campaign.onlyMobileWhatsapp && !np.isMobile) ? 'fixo (não WhatsApp)' : ''),
    });
    added++;
  }
  persist();
  return { added, skipped, total: leads.length };
}

// ---------- API ----------
function snapshot() {
  const t = spParts();
  const byStatus = leads.reduce((a, l) => (a[l.status] = (a[l.status] || 0) + 1, a), {});
  return {
    campaign: {
      monthKey: state.monthKey, dayKey: state.dayKey,
      monthSent: state.monthSent, monthlyCap: CFG.campaign.monthlyCap,
      daySent: state.daySent, dailyCap: CFG.campaign.dailyCap,
      businessNow: isBusinessNow(t), paused: rt.paused, dryRun: rt.dryRun,
      nextGapMin: Math.round(nextGapMs(t) / 60000), lastSendAt: state.lastSendAt,
      hours: `${CFG.campaign.businessHourStart}h–${CFG.campaign.businessHourEnd}h ${CFG.campaign.timezone}`,
    },
    counts: { total: leads.length, queued: byStatus.queued || 0, sent: byStatus.sent || 0, failed: byStatus.failed || 0, skipped: byStatus.skipped || 0 },
    leads: leads.map(l => ({ id: l.id, name: l.name, lat: l.lat, lng: l.lng, status: l.status, category: l.category, phone: l.phoneNorm, reason: l.reason })),
    log: log.slice(-80),
  };
}

function body(req) { return new Promise((res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => res(b)); }); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// ---------- login (cookie assinado, sem libs) — protege os controles de disparo ----------
const crypto = require('crypto');
const AUTH_USER = process.env.LARA_USER || '';
const AUTH_PASS = process.env.LARA_PASS || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
const mkToken = u => { const v = u + '.' + Date.now(); return v + '.' + sign(v); };
function tokenOk(t) {
  if (!t) return false;
  const i = t.lastIndexOf('.');
  if (i < 0) return false;
  const v = t.slice(0, i), sig = t.slice(i + 1);
  const a = Buffer.from(sig), b = Buffer.from(sign(v));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(';')
  .map(c => c.trim().split('=')).filter(x => x[1] !== undefined).map(x => [x[0], decodeURIComponent(x.slice(1).join('='))]));
const LOGIN_HTML = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Lara · entrar</title><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font:15px/1.5 Inter,system-ui,sans-serif;background:#F5F9F6;color:#08110D}form{background:#fff;border:1px solid #DFEAE3;
border-radius:16px;padding:28px;width:320px;box-shadow:0 10px 34px rgba(8,17,13,.06)}h1{font-size:18px;margin:0 0 4px}
p{color:#5F6E66;font-size:13px;margin:0 0 18px}input{width:100%;padding:11px 13px;border:1px solid #DFEAE3;border-radius:10px;
font:inherit;margin-bottom:10px}button{width:100%;padding:12px;border:0;border-radius:10px;background:#0E9F6E;color:#fff;
font:inherit;font-weight:600;cursor:pointer}.e{color:#C4372C;font-size:13px;margin-top:10px}</style>
<form method=POST action=/login><h1>Lara · Prospecções</h1><p>acesso restrito</p>
<input name=u placeholder=usuário autofocus><input name=p type=password placeholder=senha>
<button>Entrar</button>__ERR__</form>`;

const server = http.createServer(async (req, res) => {
  // gate: só passa quem tem cookie válido (se LARA_USER/PASS estiverem configurados)
  if (AUTH_USER && AUTH_PASS) {
    const url0 = new URL(req.url, 'http://x');
    if (url0.pathname === '/login') {
      if (req.method === 'POST') {
        const raw = await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
        const f = Object.fromEntries(new URLSearchParams(raw));
        if (String(f.u || '').trim() === AUTH_USER && String(f.p || '') === AUTH_PASS) {
          res.writeHead(302, { 'Set-Cookie': `lara=${mkToken(AUTH_USER)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`, Location: '/' });
          return res.end();
        }
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(LOGIN_HTML.replace('__ERR__', '<div class=e>usuário ou senha inválidos</div>'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML.replace('__ERR__', ''));
    }
    if (!tokenOk(cookieOf(req).lara)) {
      if (url0.pathname.startsWith('/api/')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"não autenticado"}'); }
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
  }
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && u.pathname === '/api/state') return send(200, snapshot());
    if (req.method === 'GET' && u.pathname === '/api/cities') {
      const q = (u.searchParams.get('q') || '').trim();
      if (q.length < 3) return send(200, { results: [] });
      try { return send(200, { results: await searchCities(q) }); }
      catch (e) { return send(200, { results: [], error: e.message }); }
    }
    if (req.method === 'POST' && u.pathname === '/api/prospect') {
      const p = JSON.parse(await body(req) || '{}');
      if (!p.niche) return send(400, { error: 'informe o nicho' });
      const cap = Math.min(p.maxResults || CFG.apify.maxResultsPerRun, CFG.apify.maxResultsPerRun);
      let locs = [];
      if (Array.isArray(p.cities) && p.cities.length) locs = p.cities.map(c => ({ locationQuery: c.display || c.name, city: c }));
      else if (typeof p.lat === 'number') locs = [{ lat: p.lat, lng: p.lng, radiusKm: p.radiusKm || 5 }];
      else return send(400, { error: 'selecione ao menos uma cidade' });
      pushLog('info', `Apify: "${p.niche}" em ${locs.length} cidade(s), cap ${cap}/cidade…`);
      const runs = await Promise.all(locs.map(l =>
        apifyStart(apifyInput(p.niche, l, cap)).then(r => ({ ...r, loc: l })).catch(e => ({ error: e.message, loc: l }))));
      const results = await Promise.all(runs.map(async run => {
        if (run.error) { pushLog('error', `Apify ${(run.loc.city && run.loc.city.display) || ''}: ${run.error}`); return { items: [], loc: run.loc }; }
        const items = await apifyWait(run).catch(e => { pushLog('error', 'Apify wait: ' + e.message); return []; });
        return { items, loc: run.loc };
      }));
      let added = 0, skipped = 0;
      for (const r of results) { const a = addLeads(r.items, p.niche, r.loc.city ? (r.loc.city.display || r.loc.city.name) : ''); added += a.added; skipped += a.skipped; }
      pushLog('info', `Apify: +${added} leads (${skipped} repetidos) de ${locs.length} cidade(s).`);
      return send(200, { ok: true, added, skipped, total: leads.length });
    }
    if (req.method === 'POST' && u.pathname === '/api/control') {
      const p = JSON.parse(await body(req) || '{}');
      if (p.action === 'pause') rt.paused = true;
      else if (p.action === 'resume') rt.paused = false;
      else if (p.action === 'dryRun') rt.dryRun = !!p.value;
      else if (p.action === 'resetCounters') { state.monthSent = 0; state.daySent = 0; }
      else if (p.action === 'clearQueue') { leads = leads.filter(l => l.status !== 'queued'); }
      else if (p.action === 'testSend' && p.phone) {
        const np = normalizePhone(p.phone); if (!np) return send(400, { error: 'telefone inválido' });
        const r = await neppoSend(np.e164); pushLog(r.ok ? 'sent' : 'error', `TESTE -> ${np.e164}: ${r.ok ? 'id ' + r.id : r.error}`);
        return send(r.ok ? 200 : 500, r);
      }
      pushLog('info', `controle: ${p.action} ${p.value !== undefined ? p.value : ''}`);
      persist(); return send(200, { ok: true });
    }
    // estático
    let f = u.pathname === '/' ? '/index.html' : u.pathname;
    const fp = path.join(PUBLIC, path.normalize(f).replace(/^(\.\.[\/\\])+/, ''));
    if (fp.startsWith(PUBLIC) && fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(fp));
    }
    send(404, { error: 'not found' });
  } catch (e) { pushLog('error', req.url + ': ' + e.message); send(500, { error: e.message }); }
});
server.listen(PORT, () => pushLog('info', `Lara - Prospecções on http://localhost:${PORT}  (dryRun=${rt.dryRun}, paused=${rt.paused})`));
