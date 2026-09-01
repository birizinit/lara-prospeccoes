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
// ⚠️ Gravação ATÔMICA (.tmp + rename). Sem isto, o SIGKILL de um redeploy no meio da
// escrita deixa o JSON truncado — e o loadJSON cai no default EM SILÊNCIO: some a fila
// (leads.json) e zera o contador do mês, que é a trava do teto de 1000. Aconteceu em
// 01/09: o dryRun voltou sozinho para o padrão depois de um deploy.
function saveJSON(f, o) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, f);                       // rename no mesmo disco é atômico
}
// Arquivo ilegível NÃO é o mesmo que arquivo ausente: no 1º caso guarda a cópia e grita,
// senão o próximo save apaga por cima a única chance de recuperar.
function loadJSON(f, def) {
  let cru;
  try { cru = fs.readFileSync(f, 'utf8'); } catch { return def; }   // não existe ainda: normal
  try { return JSON.parse(cru); } catch (e) {
    const bkp = f + '.corrompido-' + Date.now();
    try { fs.writeFileSync(bkp, cru); } catch (_) {}
    console.error('[estado] ' + path.basename(f) + ' ILEGÍVEL (' + cru.length + ' bytes) — ' +
      'recomecei do zero; a cópia ficou em ' + bkp);
    return def;
  }
}

let state = loadJSON(STATE_FILE, { monthKey: '', dayKey: '', monthSent: 0, daySent: 0, lastSendAt: 0, runtimeCfg: {} });
let leads = loadJSON(LEADS_FILE, []);
// runtime overrides persistem por cima do config.json: o que se ajusta no painel
// mora aqui (e no volume), para sobreviver a redeploy sem precisar mexer em codigo.
const RT_CAMPOS = ['paused', 'dryRun', 'dailyCap', 'monthlyCap', 'hourStart', 'hourEnd', 'niche', 'cities'];
const rt = Object.assign({
  paused: CFG.campaign.paused, dryRun: CFG.campaign.dryRun,
  dailyCap: CFG.campaign.dailyCap, monthlyCap: CFG.campaign.monthlyCap,
  hourStart: CFG.campaign.businessHourStart, hourEnd: CFG.campaign.businessHourEnd,
  niche: CFG.campaign.niche || '', cities: CFG.campaign.cities || [],
}, state.runtimeCfg || {});
function persist() {
  state.runtimeCfg = {};
  for (const k of RT_CAMPOS) state.runtimeCfg[k] = rt[k];
  saveJSON(STATE_FILE, state); saveJSON(LEADS_FILE, leads);
}

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
    if (!_evoWarned) { _evoWarned = true; console.log(`[evo] alerta OFF — url:${EVO.url ? 1 : 0} inst:${EVO.instance ? 1 : 0} key:${EVO.apikey ? 1 : 0} to:${EVO.to ? 1 : 0}`); }
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
/**
 * Toda chamada autenticada passa por aqui. ⚠️ A Neppo emite UM token por credencial:
 * outro consumidor (Briefing, Reconciliador, uma sonda manual) que peça token novo com a
 * mesma conta INVALIDA o nosso — e o cache só expira pelo relógio, então sem isto a Lara
 * ficaria uma hora sem disparar, em silêncio. No 401, descarta o cache e tenta UMA vez.
 */
async function neppoPost(url, body) {
  let tok = await neppoAuth();
  const bater = () => request(url, { method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body, rejectUnauthorized: NEPPO_TLS });
  let r = await bater();
  if (r.status === 401) {                       // desiste no 2o 401: laço aqui é pior que a falha
    pushLog('info', 'Neppo 401 — token invalidado por outro consumidor; renovando');
    neppoTok = { token: null, exp: 0 };
    tok = await neppoAuth();
    r = await bater();
  }
  return r;
}

let tplCache = null;
async function neppoTemplate() {
  if (tplCache) return tplCache;
  // ⚠️ a API corta em 50 por página (ignora size maior) — paginar até achar, senão templates
  // de id alto (ex.: 110) somem silenciosamente. Mesmo bug já corrigido no app Briefing.
  let t = null;
  for (let pg = 0; pg < 20 && !t; pg++) {
    const r = await neppoPost('https://api.neppo.com.br/chatapi/1.0/api/hsm-template',
      { conditions: [], page: pg, size: 50 });
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
  const r = await neppoPost('https://api.neppo.com.br/chatapi/1.0/api/direct-message/save', body);
  if (r.status >= 200 && r.status < 300 && r.json && r.json.id) return { ok: true, id: r.json.id };
  return { ok: false, error: `HTTP ${r.status} ${(r.text || '').slice(0, 160)}` };
}

// ---------- Ploomes: a resposta vira negócio no CRM ----------
// ⚠️ ESCRITA no Ploomes (o resto do workspace é só leitura). Autorizada pelo Diretor em 01/09:
// gatilho = o prospect RESPONDEU · dono = rodízio Priscilla × Gabriel Rodrigues (o mesmo par de
// pré-vendas do bot da Neppo) · sem retroativo. Cada lead guarda o id criado → nunca duplica.
// Custo do disparo (o Diretor, 01/09): R$ 0,35 a mensagem + R$ 0,06 de spread da Neppo.
// ⚠️ É o custo do ENVIO, não o da operação: não entra Apify, tempo de vendedor nem mídia.
// Por isso o painel chama de "custo de disparo" e o CAC sai rotulado como parcial.
const CUSTO_MSG = Number(process.env.CUSTO_MSG || 0.35);
const CUSTO_SPREAD = Number(process.env.CUSTO_SPREAD || 0.06);
const CUSTO_ENVIO = CUSTO_MSG + CUSTO_SPREAD;

const PL = {
  key: () => process.env.PLOOMES_KEY || '',
  funil: 40059663,          // Entradas e Prospecção
  etapa: 40291620,          // Oportunidades (1ª etapa)
  origem: 120004066,        // "Lara IA - Whatsapp" (já existia no CRM, nunca usada)
  donos: [
    { id: 120002975, nome: 'Priscilla Caetano' },
    { id: 40040912, nome: 'Gabriel Rodrigues' },
  ],
  campoDescricao: 'deal_E556CA06-A55A-4D12-B703-8C052AF90E2A',   // "Descrição do Lead"
};

function plReq(rota, metodo, corpo) {
  return new Promise((ok, err) => {
    const body = corpo ? JSON.stringify(corpo) : null;
    const h = { 'User-Key': PL.key(), 'Content-Type': 'application/json' };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const r = https.request({ hostname: 'api2.ploomes.com', path: '/' + encodeURI(rota),
      method: metodo || 'GET', headers: h, rejectUnauthorized: false }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {}
        ok({ status: res.statusCode, json: j, text: d }); });
    });
    r.on('error', err); if (body) r.write(body); r.end();
  });
}

/** DDD + 8 dígitos finais. ⚠️ Sem o DDD, "7135-3131" de Florianópolis casa com o de São Paulo —
 *  aconteceu no cruzamento de 01/09 (Mix Utilidades virou CONTRANS). */
function chaveFone(t) {
  const d = String(t || '').replace(/\D/g, '');
  const n = d.length > 11 ? d.slice(-11) : d;
  return n.length >= 10 ? n.slice(0, 2) + n.slice(-8) : null;
}

/** Acha o contato pelo telefone, nas duas formas que o Ploomes usa (mascarada e crua). */
async function plContatoPorFone(e164) {
  const alvo = chaveFone(e164);
  if (!alvo) return null;
  const nac = String(e164).replace(/\D/g, '').slice(2), num = nac.slice(2);
  const oito = num.slice(-8), masc = oito.slice(0, 4) + '-' + oito.slice(4);
  for (const forma of [masc, num]) {
    const r = await plReq("Contacts?$filter=Phones/any(p: contains(p/PhoneNumber,'" + forma + "'))" +
      "&$expand=Phones($select=PhoneNumber)&$select=Id,Name&$top=10");
    const achados = (r.json && r.json.value) || [];
    const bom = achados.find((c) => (c.Phones || []).some((f) => chaveFone(f.PhoneNumber) === alvo));
    if (bom) return bom;                        // só aceita quem bate DDD + 8 dígitos
  }
  return null;
}

/** Rodízio auto-balanceado: quem recebeu menos leva o próximo. Empate → último dígito do
 *  telefone, para o MESMO prospect cair sempre com a mesma pessoa. */
function plDono(e164) {
  const conta = {};
  for (const d of PL.donos) conta[d.id] = 0;
  for (const l of leads) if (l.ploomesDonoId && conta[l.ploomesDonoId] !== undefined) conta[l.ploomesDonoId]++;
  const [a, b] = PL.donos;
  if (conta[a.id] !== conta[b.id]) return conta[a.id] < conta[b.id] ? a : b;
  const ultimo = parseInt(String(e164).slice(-1), 10) || 0;
  return PL.donos[ultimo % 2];
}

/** Cria contato (se não existir) + negócio. Devolve {dealId, contatoId, dono} ou {erro}. */
/** +5511999998888 -> (11) 99999-8888 — o telefone legível na descrição do negócio. */
function fmtFone(e164) {
  const n = String(e164 || '').replace(/\D/g, '').replace(/^55/, '');
  return n.length >= 10 ? '(' + n.slice(0, 2) + ') ' + n.slice(2, -4) + '-' + n.slice(-4) : String(e164 || '');
}

async function plCriarNegocio(lead) {
  if (!PL.key()) return { erro: 'PLOOMES_KEY ausente' };
  if (lead.ploomesDealId) return { ja: true };            // idempotente: nunca cria 2x
  const dono = plDono(lead.phoneNorm);

  // ⚠️ NÃO cria contato (decisão do Diretor 01/09, igual ao bot v9): prospect do Google Maps não
  // é cliente e não pode poluir a base. Se o telefone JÁ é de um contato do CRM, guarda o id só
  // para medir orçamento/venda depois — o negócio segue SEM vínculo.
  const contato = await plContatoPorFone(lead.phoneNorm);

  // ⚠️ sem contato vinculado, o telefone precisa estar AQUI — senão o vendedor não tem como ligar
  const ctx = ['Prospecção ativa da Lara (Google Maps → WhatsApp).',
    lead.phoneNorm ? 'WhatsApp: ' + fmtFone(lead.phoneNorm) + '.' : '',
    lead.city ? 'Cidade: ' + lead.city + '.' : '',
    lead.category ? 'Ramo no Maps: ' + lead.category + '.' : '',
    lead.niche ? 'Nicho buscado: ' + lead.niche + '.' : '',
    'Abordado em ' + String(lead.sentAt || '').slice(0, 16).replace('T', ' ') + '.',
    'RESPONDEU — a conversa está no grupo "' + CFG.neppo.groupName + '" da Neppo.',
    lead.website ? 'Site: ' + lead.website : ''].filter(Boolean).join(' ');

  const d = await plReq('Deals', 'POST', {
    Title: '[LARA] ' + String(lead.name || 'Prospect').slice(0, 80),
    ContactId: null,                                      // negócio sem contato, por decisão
    PipelineId: PL.funil,
    StageId: PL.etapa,
    OwnerId: dono.id,
    OriginId: PL.origem,
    OtherProperties: [{ FieldKey: PL.campoDescricao, StringValue: ctx.slice(0, 900) }],
  });
  const deal = ((d.json && (d.json.value || [d.json]))[0]) || null;
  if (!deal || !deal.Id) return { erro: 'negócio: HTTP ' + d.status + ' ' + String(d.text).slice(0, 140) };

  if (contato && contato.Id) lead.ploomesContatoId = contato.Id;   // só para medir, não vincula
  lead.ploomesDealId = deal.Id;
  lead.ploomesDonoId = dono.id;
  lead.ploomesEm = new Date().toISOString();
  return { dealId: deal.Id, contatoId: (contato && contato.Id) || null, dono: dono.nome };
}

// ---------- funil: o que aconteceu DEPOIS do disparo ----------
// ⚠️ A Neppo NÃO deixa filtrar envio por template (`hsmTemplate` volta null e o filtro dá 0),
// mas aceita `id EQNUM` — e a Lara guarda o msgId de cada disparo. Então é consulta por id.
// Estados: PROCESSANDO → ENVIADA → RECEBIDA → LIDA · ou ERRO (o motivo vem em `description`).
// ⚠️ RESPOSTA = `sessionId` preenchido no PRÓPRIO envio (a sessão nasce quando o prospect
// responde). O caminho oposto não serve: `directMessageId` na sessão veio nulo em 572 sessões.
const FINAIS = new Set(['LIDA', 'ERRO']);            // o resto ainda pode evoluir

async function statusDoEnvio(msgId) {
  const r = await neppoPost('https://api.neppo.com.br/chatapi/1.0/api/direct-message',
    { conditions: [{ key: 'id', value: String(msgId), operator: 'EQNUM', logic: 'AND' }], page: 0, size: 2 });
  const m = ((r.json && r.json.results) || [])[0];
  return m || null;
}

/**
 * O que aconteceu com quem virou negócio: orçou? comprou? Sem isto o funil para em
 * "respondeu" e o CAC nunca fecha. Consulta por CONTATO (não por negócio): o cliente pode
 * orçar num negócio e comprar em outro, e o que importa para o CAC é o cliente.
 */
async function sincronizarCrm(teto) {
  if (!PL.key()) return { erro: 'PLOOMES_KEY ausente' };
  // quem virou negócio entra aqui. Como o negócio nasce SEM contato, o vínculo para medir é
  // reprocurado pelo telefone a cada rodada: o prospect pode ser cadastrado no CRM depois, e aí
  // orçamento/venda voltam a aparecer sozinhos.
  const alvos = leads.filter(l => l.ploomesDealId)
    .sort((a, b) => String(a.crmEm || '').localeCompare(String(b.crmEm || '')))  // o mais defasado primeiro
    .slice(0, teto || 20);
  let mudou = 0;
  for (const l of alvos) {
    try {
      if (!l.ploomesContatoId) {
        const c = await plContatoPorFone(l.phoneNorm);
        if (c && c.Id) l.ploomesContatoId = c.Id;
        else { l.crmEm = new Date().toISOString(); continue; }   // ainda não é cliente
      }
      const q = await plReq("Quotes?$filter=ContactId eq " + l.ploomesContatoId +
        "&$select=Id,Amount,Date&$top=50");
      const o = await plReq("Orders?$filter=ContactId eq " + l.ploomesContatoId +
        "&$select=Id,Amount,Date&$top=50");
      const cot = (q.json && q.json.value) || [], ped = (o.json && o.json.value) || [];
      const antes = (l.orcamentos || {}).n + '|' + (l.vendas || {}).n;
      l.orcamentos = { n: cot.length, valor: cot.reduce((a, x) => a + (x.Amount || 0), 0) };
      l.vendas = { n: ped.length, valor: ped.reduce((a, x) => a + (x.Amount || 0), 0),
                   primeira: ped.length ? ped.map(x => x.Date).sort()[0] : null };
      l.crmEm = new Date().toISOString();
      if (antes !== l.orcamentos.n + '|' + l.vendas.n) mudou++;
    } catch (e) { pushLog('error', 'CRM ' + l.name + ': ' + e.message); break; }
  }
  if (mudou) { persist(); pushLog('info', 'CRM: ' + mudou + ' cliente(s) mudaram de estágio'); }
  return { olhados: alvos.length, mudou };
}

/** Atualiza o funil dos disparos que ainda podem mudar. Teto por rodada: a API é lenta. */
async function sincronizarFunil(teto) {
  const alvos = leads.filter(l => l.msgId && !l.dryRun && !FINAIS.has(l.entrega || ''))
    .sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))   // recentes primeiro
    .slice(0, teto || 40);
  let mudou = 0;
  for (const l of alvos) {
    try {
      const m = await statusDoEnvio(l.msgId);
      if (!m) continue;
      const antes = l.entrega;
      l.entrega = m.status || null;
      l.entregaEm = m.sentAt || null;
      l.erroMotivo = m.status === 'ERRO' ? (m.description || 'sem motivo informado') : null;
      if (m.sessionId && !l.respondeuEm) {
        l.sessionId = m.sessionId; l.respondeuEm = m.updatedAt || new Date().toISOString();
        // respondeu = lead quente: nasce no CRM agora, senão a conversa morre no WhatsApp
        // (em 01/09, 19 responderam e NENHUMA virou cadastro no Ploomes)
        try {
          const r = await plCriarNegocio(l);
          if (r.erro) pushLog('error', 'Ploomes ' + l.name + ': ' + r.erro);
          else if (r.dealId) pushLog('sent', 'CRM · negócio #' + r.dealId + ' para ' + l.name + ' → ' + r.dono);
        } catch (e) { pushLog('error', 'Ploomes ' + l.name + ': ' + e.message); }
      }
      if (antes !== l.entrega) mudou++;
    } catch (e) { pushLog('error', 'funil ' + l.msgId + ': ' + e.message); break; }  // Neppo fora: para
  }
  if (mudou) { persist(); pushLog('info', `funil atualizado: ${mudou} disparo(s) mudaram de estado`); }
  return { olhados: alvos.length, mudou };
}

/** O retrato que o cockpit consome. Números CRUS, o painel decide como mostrar. */
function funilResumo() {
  const enviados = leads.filter(l => l.status === 'sent' && !l.dryRun);
  const ent = (st) => enviados.filter(l => l.entrega === st).length;
  const chegou = enviados.filter(l => l.entrega === 'RECEBIDA' || l.entrega === 'LIDA').length;
  const respondidos = enviados.filter(l => l.respondeuEm).length;
  const semRetorno = enviados.filter(l => !l.entrega).length;   // ainda não consultado

  const conta = (campo) => {
    const m = {};
    for (const l of leads) { const k = (l[campo] || '').trim() || '(não informado)'; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const porRegiao = {};
  for (const l of leads) {
    const c = (l.city || '').trim() || '(sem cidade)';
    const r = porRegiao[c] || (porRegiao[c] = { cidade: c, leads: 0, enviados: 0, entregues: 0, lidos: 0, respondidos: 0, erro: 0 });
    r.leads++;
    if (l.status === 'sent' && !l.dryRun) {
      r.enviados++;
      if (l.entrega === 'RECEBIDA' || l.entrega === 'LIDA') r.entregues++;
      if (l.entrega === 'LIDA') r.lidos++;
      if (l.respondeuEm) r.respondidos++;
    }
    if (l.status === 'failed' || l.entrega === 'ERRO') r.erro++;
  }
  const erros = {};
  for (const l of leads) {
    if (l.entrega === 'ERRO' || l.status === 'failed') {
      const k = (l.erroMotivo || l.error || 'sem motivo informado').slice(0, 120);
      erros[k] = (erros[k] || 0) + 1;
    }
  }
  const porDia = {};
  for (const l of enviados) {
    const d = String(l.sentAt || '').slice(0, 10); if (!d) continue;
    const x = porDia[d] || (porDia[d] = { dia: d, enviados: 0, entregues: 0, respondidos: 0 });
    x.enviados++;
    if (l.entrega === 'RECEBIDA' || l.entrega === 'LIDA') x.entregues++;
    if (l.respondeuEm) x.respondidos++;
  }

  return {
    geradoEm: new Date().toISOString(),
    campanha: snapshot().campaign,
    // diagnostico: da para ver de fora se a integracao com o CRM esta de pe, sem ter de
    // esperar alguem responder para descobrir que a chave nao chegou no servidor.
    crm: { ligado: !!PL.key(), funil: PL.funil, etapa: PL.etapa, origem: PL.origem,
           donos: PL.donos.map(d => d.nome),
           criados: leads.filter(l => l.ploomesDealId).length,
           aguardando: leads.filter(l => l.respondeuEm && !l.ploomesDealId).length },
    template: { id: CFG.neppo.templateId, nome: (tplCache && tplCache.elementName) || null,
                texto: (tplCache && tplCache.text) || null, imagem: CFG.neppo.headerImage,
                grupo: CFG.neppo.groupName },
    funil: {
      capturados: leads.length,
      semTelefone: leads.filter(l => l.status === 'skipped' && /sem telefone/.test(l.reason || '')).length,
      fixo: leads.filter(l => l.status === 'skipped' && /fixo/.test(l.reason || '')).length,
      naFila: leads.filter(l => l.status === 'queued').length,
      enviados: enviados.length,
      // ⚠️ "chegou" = o WhatsApp confirmou (RECEBIDA/LIDA). ENVIADA = saiu, sem confirmação ainda.
      saiuSemConfirmar: ent('ENVIADA') + ent('PROCESSANDO'),
      entregues: chegou, lidos: ent('LIDA'), respondidos,
      erro: leads.filter(l => l.status === 'failed' || l.entrega === 'ERRO').length,
      noCrm: leads.filter(l => l.ploomesDealId).length,
      negocios: leads.filter(l => l.ploomesDealId).length,
      orcamentos: leads.filter(l => (l.orcamentos || {}).n > 0).length,
      vendas: leads.filter(l => (l.vendas || {}).n > 0).length,
      semLeitura: semRetorno,
      dryRun: leads.filter(l => l.dryRun).length,
    },
    custo: (function () {
      const env = enviados.length;
      const total = env * CUSTO_ENVIO;
      const clientes = leads.filter(l => (l.vendas || {}).n > 0);
      const receita = clientes.reduce((a, l) => a + ((l.vendas || {}).valor || 0), 0);
      const emOrc = leads.filter(l => (l.orcamentos || {}).n > 0);
      const div = (a, b) => (b ? a / b : null);   // sem base ainda → null, e o painel mostra "—"
      return {
        porMensagem: CUSTO_MSG, spread: CUSTO_SPREAD, porEnvio: CUSTO_ENVIO,
        enviados: env, total,
        porResposta: div(total, respondidos),
        porNegocio: div(total, leads.filter(l => l.ploomesDealId).length),
        porOrcamento: div(total, emOrc.length),
        cac: div(total, clientes.length),                    // custo de DISPARO por cliente
        clientes: clientes.length,
        receita,
        valorEmOrcamento: emOrc.reduce((a, l) => a + ((l.orcamentos || {}).valor || 0), 0),
        retorno: div(receita, total),                        // quantas vezes o disparo se pagou
      };
    })(),
    erros: Object.entries(erros).sort((a, b) => b[1] - a[1]).map(([motivo, n]) => ({ motivo, n })),
    regioes: Object.values(porRegiao).sort((a, b) => b.enviados - a.enviados || b.leads - a.leads),
    nichos: conta('niche').map(([nicho, n]) => ({ nicho, n })),
    porDia: Object.values(porDia).sort((a, b) => a.dia.localeCompare(b.dia)),
    respondidosLista: enviados.filter(l => l.respondeuEm)
      .sort((a, b) => String(b.respondeuEm).localeCompare(String(a.respondeuEm)))
      .slice(0, 40)
      .map(l => ({ nome: l.name, cidade: l.city, categoria: l.category, fone: l.phoneNorm,
                   enviadoEm: l.sentAt, respondeuEm: l.respondeuEm, entrega: l.entrega,
                   dealId: l.ploomesDealId || null, dono: l.ploomesDonoId || null })),
    ultimos: enviados.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))
      .slice(0, 40)
      .map(l => ({ nome: l.name, cidade: l.city, fone: l.phoneNorm, enviadoEm: l.sentAt,
                   entrega: l.entrega || 'aguardando', respondeu: !!l.respondeuEm, erro: l.erroMotivo || null })),
  };
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
  // seg-sex, dentro da janela configurada no painel (fim de semana nunca dispara)
  return t.wd >= 1 && t.wd <= 5 && t.hour >= rt.hourStart && t.hour < rt.hourEnd;
}
function rollovers(t) {
  if (state.monthKey !== t.monthKey) { state.monthKey = t.monthKey; state.monthSent = 0; }
  if (state.dayKey !== t.dayKey) { state.dayKey = t.dayKey; state.daySent = 0; }
}
function nextGapMs(t) {
  const remainDaily = Math.max(1, rt.dailyCap - state.daySent);
  const minsLeft = Math.max(1, (rt.hourEnd - (t.hour + t.minute / 60)) * 60);
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
    if (state.monthSent >= rt.monthlyCap) return;
    if (state.daySent >= rt.dailyCap) return;
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
// o funil se move DEPOIS do disparo (entregue/lido/respondido): sem isto o painel do
// Diretor só mostraria 'enviada' e pareceria que ninguém lê.
setInterval(() => sincronizarFunil(25).catch(() => {}), 5 * 60 * 1000);
// orçamento e pedido levam dias, não minutos — meia hora basta e poupa chamada ao Ploomes
setInterval(() => sincronizarCrm(20).catch(() => {}), 30 * 60 * 1000);
setTimeout(() => sincronizarFunil(60).catch(() => {}), 25000);   // uma passada logo após o boot

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
      monthSent: state.monthSent, monthlyCap: rt.monthlyCap,
      daySent: state.daySent, dailyCap: rt.dailyCap,
      businessNow: isBusinessNow(t), paused: rt.paused, dryRun: rt.dryRun,
      nextGapMin: Math.round(nextGapMs(t) / 60000), lastSendAt: state.lastSendAt,
      hours: `${rt.hourStart}h–${rt.hourEnd}h ${CFG.campaign.timezone} · seg a sex`,
      config: { dailyCap: rt.dailyCap, monthlyCap: rt.monthlyCap, hourStart: rt.hourStart,
                hourEnd: rt.hourEnd, niche: rt.niche, cities: rt.cities },
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
const JSONH = { 'Content-Type': 'application/json; charset=utf-8' };
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
  // ---------- ponte para o cockpit (máquina-a-máquina, fora do login de navegador) ----------
  // ⚠️ A Lara é a DONA do token da Neppo. O cockpit NÃO pode consultar a Neppo por conta
  // própria: pediria token novo e invalidaria o nosso a cada refresh do Diretor (foi o que
  // congelou o estoque da Shopee por 12 dias em 26/08). Aqui só se lê o que a Lara já apurou.
  {
    const u0 = new URL(req.url, 'http://x');
    if (u0.pathname === '/api/cockpit/lara') {
      const chave = process.env.COCKPIT_KEY || '';
      const veio = req.headers['x-cockpit-key'] || u0.searchParams.get('key') || '';
      if (!chave) { res.writeHead(503, JSONH); return res.end('{"error":"COCKPIT_KEY não configurada"}'); }
      if (veio !== chave) { res.writeHead(401, JSONH); return res.end('{"error":"chave inválida"}'); }
      try {
        try { await neppoTemplate(); } catch (e) { /* segue sem o texto do template */ }
        if (u0.searchParams.get('sync') === '1') { await sincronizarFunil(60); await sincronizarCrm(40); }
        res.writeHead(200, JSONH);
        return res.end(JSON.stringify(funilResumo()));
      } catch (e) {
        res.writeHead(500, JSONH); return res.end(JSON.stringify({ error: e.message }));
      }
    }
  }

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
    // ajustes da campanha pelo painel (nao precisa mexer no config.json nem redeployar)
    if (req.method === 'POST' && u.pathname === '/api/config') {
      const p = JSON.parse(await body(req) || '{}');
      const num = (v, min, max, atual) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : atual;
      };
      // TETO DURO de 50/dia: e a cadencia que nao parece robo. Deixar digitar 500 aqui
      // seria entregar o numero da Lar para a Meta marcar como spam.
      if (p.dailyCap !== undefined) rt.dailyCap = num(p.dailyCap, 1, 50, rt.dailyCap);
      if (p.monthlyCap !== undefined) rt.monthlyCap = num(p.monthlyCap, 1, 2000, rt.monthlyCap);
      if (p.hourStart !== undefined) rt.hourStart = num(p.hourStart, 0, 23, rt.hourStart);
      if (p.hourEnd !== undefined) rt.hourEnd = num(p.hourEnd, 1, 24, rt.hourEnd);
      if (rt.hourEnd <= rt.hourStart) rt.hourEnd = Math.min(24, rt.hourStart + 1);  // janela precisa existir
      if (p.niche !== undefined) rt.niche = String(p.niche || '').trim().slice(0, 80);
      if (Array.isArray(p.cities)) {
        rt.cities = p.cities.slice(0, 12)
          .map((c) => ({ name: String(c.name || '').slice(0, 80), display: String(c.display || c.name || '').slice(0, 120) }))
          .filter((c) => c.display);
      }
      pushLog('info', `config: ${rt.dailyCap}/dia · ${rt.monthlyCap}/mes · ${rt.hourStart}h–${rt.hourEnd}h`
        + (rt.niche ? ` · nicho "${rt.niche}"` : '') + (rt.cities.length ? ` · ${rt.cities.length} cidade(s)` : ''));
      persist();
      return send(200, { ok: true, config: snapshot().campaign.config });
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
