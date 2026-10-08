/* Ponte Neppo — o pedaço da Lara que PRECISA de IP brasileiro (Fly, região gru).
 * Desde 07/10/2026 a Lara do Google Maps mora no portal Lara (Railway): captura, fila, ritmo,
 * proteções, CRM e indicadores ficam lá. Aqui só sobrou o que a Neppo exige: falar com ela
 * de um IP do Brasil. Node puro, sem dependências.
 *
 * Rotas (todas com header x-cockpit-key = COCKPIT_KEY, menos /health):
 *   GET  /health              → { ok, neppo }
 *   GET  /templates           → templates HSM (paginado, a API corta em 50)
 *   POST /enviar              → { telefone, templateId, imagem?, grupoNome?, grupoConfId? } → { ok, id } | { ok:false, erro }
 *   POST /status              → { ids: [..] } → [{ id, status, descricao, sessionId, enviadoEm, atualizadoEm }]
 *   POST /mensagens           → { sessionId } → [{ em, de, texto }]  (o que o PROSPECT escreveu)
 *   POST /sessoes             → { ids: [..] } → [{ id, protocolo, status, atendente, atendidoEm, encerradoEm }]
 *   GET  /templates/:id       → o template cru da Neppo (ver cabeçalho de mídia)
 *   GET  /legado              → a fila/histórico da Lara antiga (volume /data), só leitura
 *   GET  /historico?texto=    → disparos da Neppo cujo texto contém `texto` (quem já recebeu), só leitura
 *   POST /sessoes-janela      → { desde, ate (epoch ms), pagina, contar?, debug? } → protocolos criados na janela, 50 por
 *                               página, com telefone, atendente e grupo (Aeroporto de Leads do cockpit), só leitura
 *   POST /conversa            → { sessionId } → a conversa inteira do protocolo (cliente, atendente, bot), só leitura
 *
 * ⚠️ A Neppo emite UM token por credencial: outro consumidor que peça token invalida o nosso.
 * No 401 descarta o cache e tenta UMA vez (lição de 01/09 — a Lara ficava 1 h muda).
 * ⚠️ Envio NÃO tem nova tentativa aqui: timeout não quer dizer que não saiu.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// .env local (no Fly os segredos já vêm do ambiente)
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch (_) { /* sem .env */ }

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const NEPPO = (process.env.NEPPO_BASE || 'https://api.neppo.com.br').replace(/\/+$/, '');
const NEPPO_AUTH = process.env.NEPPO_AUTH_URL || 'https://api-auth.neppo.com.br/oauth2/token';
const TLS_ESTRITO = process.env.NEPPO_STRICT_TLS === '1';
// grupo que ENTREGA (o ENTRADAS e o Sistemas travam em PROCESSANDO — HISTORICO §1.3)
const PADRAO = { canal: 'WHATSAPP', grupoNome: 'Lar Plasticos WhatsApp', grupoConfId: 1, userId: 106, criadoPor: 'felipe_admin' };

function pedir(urlStr, { metodo = 'GET', headers = {}, corpo = null, timeout = 60000 } = {}) {
  return new Promise((ok, erro) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const dados = corpo == null ? null : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    const h = { ...headers };
    if (dados) h['Content-Length'] = Buffer.byteLength(dados);
    const r = lib.request({ method: metodo, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, headers: h, rejectUnauthorized: TLS_ESTRITO }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { /* não é JSON */ } ok({ status: res.statusCode, json: j, texto: b }); });
    });
    r.on('error', erro);
    r.setTimeout(timeout, () => r.destroy(new Error('timeout')));
    if (dados) r.write(dados);
    r.end();
  });
}

// ---------- Neppo ----------
let tok = { valor: null, expira: 0 };
const configurado = () => Boolean(process.env.NEPPO_USERNAME && process.env.NEPPO_PASSWORD &&
  process.env.NEPPO_CUSTOMER_KEY && process.env.NEPPO_CUSTOMER_SECRET);

async function token() {
  if (tok.valor && Date.now() < tok.expira) return tok.valor;
  const basic = Buffer.from(`${process.env.NEPPO_CUSTOMER_KEY}:${process.env.NEPPO_CUSTOMER_SECRET}`).toString('base64');
  const corpo = `grant_type=password&username=${encodeURIComponent(process.env.NEPPO_USERNAME)}&password=${encodeURIComponent(process.env.NEPPO_PASSWORD)}`;
  const r = await pedir(NEPPO_AUTH, { metodo: 'POST', corpo, headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!r.json || !r.json.access_token) throw new Error(`login na Neppo falhou (HTTP ${r.status})`);
  tok = { valor: r.json.access_token, expira: Date.now() + (Number(r.json.expires_in || 3600) - 120) * 1000 };
  return tok.valor;
}

async function neppo(rota, corpo) {
  const bater = async () => pedir(NEPPO + rota, { metodo: 'POST', corpo, headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' } });
  let r = await bater();
  if (r.status === 401) { tok = { valor: null, expira: 0 }; r = await bater(); }
  return r;
}

let cacheTpl = { em: 0, lista: null };
async function templates(forcar) {
  if (!forcar && cacheTpl.lista && Date.now() - cacheTpl.em < 10 * 60000) return cacheTpl.lista;
  const lista = [];
  // ⚠️ a API corta em 50 por página e IGNORA size maior → paginar, senão o 110 some
  for (let pg = 0; pg < 20; pg++) {
    const r = await neppo('/chatapi/1.0/api/hsm-template', { conditions: [], page: pg, size: 50 });
    if (r.status >= 300) throw new Error(`templates: HTTP ${r.status}`);
    const parte = (r.json && r.json.results) || [];
    lista.push(...parte);
    if (parte.length < 50) break;
  }
  cacheTpl = { em: Date.now(), lista };
  return lista;
}

const resumoTpl = (t) => ({ id: t.id, nome: t.elementName || t.name || '', namespace: t.nameSpace || null,
  texto: t.template || t.description || '', parametros: Number(t.parameterCount || 0),
  ativo: t.active !== false && t.status !== 'INACTIVE' && t.deleted !== true, idioma: t.language || t.languageCode || null,
  categoria: t.category || null });

async function enviar(c) {
  const fone = String(c.telefone || '').replace(/\D/g, '');
  if (!/^55\d{10,11}$/.test(fone)) return { ok: false, erro: 'telefone inválido (55 + DDD + número)' };
  const t = (await templates()).find((x) => Number(x.id) === Number(c.templateId));
  if (!t) return { ok: false, erro: `template ${c.templateId} não existe na Neppo` };
  if (Number(t.parameterCount || 0) > 0) return { ok: false, erro: `o template ${t.elementName} pede ${t.parameterCount} parâmetro(s) — não suportado` };
  const img = String(c.imagem || '').trim();
  if (img && !/^https:\/\//.test(img)) return { ok: false, erro: 'a imagem do cabeçalho tem de ser https' };
  // template com HEADER de mídia não entrega sem a imagem — e a API aceita mesmo assim (falha muda)
  const ext = img ? ((img.match(/\.[a-z0-9]+(?=$|\?)/i) || ['.jpg'])[0]).toLowerCase() : '.jpg';
  const additionalInfo = JSON.stringify({ namespace: t.nameSpace, elementName: t.elementName, parameters: {},
    medias: img ? { HEADER: [{ url: img, extension: ext }] } : {}, openSession: false });
  const r = await neppo('/chatapi/1.0/api/direct-message/save', {
    phoneNumber: fone, channel: PADRAO.canal, message: t.template || t.description || '',
    groupName: c.grupoNome || PADRAO.grupoNome, additionalInfo, status: 'PROCESSANDO',
    createdBy: PADRAO.criadoPor, userId: PADRAO.userId, senderUserId: null,
    groupConfId: Number(c.grupoConfId || PADRAO.grupoConfId), generatedSession: 0,
  });
  if (r.status >= 200 && r.status < 300 && r.json && r.json.id) return { ok: true, id: r.json.id };
  return { ok: false, erro: `Neppo HTTP ${r.status} ${String(r.texto || '').slice(0, 200)}` };
}

async function status(ids) {
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 40)) {
    if (!/^\d+$/.test(String(id))) continue;
    // ⚠️ filtrar por template não funciona; por id, só com EQNUM (EQ dá 500)
    const r = await neppo('/chatapi/1.0/api/direct-message',
      { conditions: [{ key: 'id', value: String(id), operator: 'EQNUM', logic: 'AND' }], page: 0, size: 2 });
    if (r.status >= 300) throw new Error(`status: HTTP ${r.status}`);
    const m = ((r.json && r.json.results) || [])[0];
    if (m) out.push({ id: m.id, status: m.status || null, descricao: m.description || null, sessionId: m.sessionId || null,
      enviadoEm: m.sentAt || null, atualizadoEm: m.updatedAt || null });
  }
  return out;
}

async function mensagens(sessionId) {
  if (!/^\d+$/.test(String(sessionId))) throw new Error('sessionId inválido');
  const r = await neppo('/chatapi/1.0/api/v2/messages', { conditions: [{ key: 'session.id', value: String(sessionId), operator: 'EQNUM', logic: 'AND' }],
    sort: true, sortColumn: 'createdAt', direction: 'ASC', page: 0, size: 50 });
  if (r.status >= 300) throw new Error(`mensagens: HTTP ${r.status}`);
  return ((r.json && r.json.results) || []).filter((m) => m.sendBy === 'user')
    .map((m) => ({ em: m.createdAt || null, tipo: m.contentType || 'TEXT', texto: textoMsg(m) }));
}

/** O que o prospect escreveu. ⚠️ Clique em botão de resposta rápida ("Não tenho interesse") pode chegar com
 *  tipo BUTTON/INTERACTIVE — o TEXTO do botão tem de passar, senão quem recusou vira negócio no Ploomes. */
const TIPO_BOTAO = /BUTTON|INTERACTIVE|QUICK|REPLY|TEMPLATE/i;
function textoMsg(m) {
  let t = m.message;
  if (t && typeof t === 'object') t = t.text || t.title || t.payload || t.body || JSON.stringify(t);
  t = String(t || '');
  if (!m.contentType || m.contentType === 'TEXT' || TIPO_BOTAO.test(m.contentType)) return t;
  return `[${m.contentType}]`;
}

/** Sessões (o atendimento que nasce quando o prospect RESPONDE): protocolo e quem assumiu. Só leitura.
 *  ⚠️ `IN` com vários valores falha em silêncio na Neppo → uma consulta por id (teto 60). */
async function sessoes(ids) {
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 60)) {
    if (!/^\d+$/.test(String(id))) continue;
    const r = await neppo('/chatapi/1.0/api/v2/user-session', { conditions: [{ key: 'id', value: String(id), operator: 'EQNUM', logic: 'AND' }], page: 0, size: 2 });
    if (r.status >= 300) throw new Error(`sessões: HTTP ${r.status}`);
    const s = ((r.json && r.json.results) || [])[0];
    if (!s) continue;
    // agent = objeto User (displayName/name/userName); lastAgent = texto (o login de quem atendeu por último)
    const ag = s.agent && typeof s.agent === 'object' ? (s.agent.displayName || s.agent.name || s.agent.userName) : null;
    const ult = typeof s.lastAgent === 'string' && s.lastAgent.trim() ? s.lastAgent.trim() : null;
    out.push({ id: s.id, protocolo: s.protocol || s.customProtocol || null, status: s.status || null,
      atendente: ag || ult || null, atendidoEm: s.attendedAt || null, encerradoEm: s.closedAt || null,
      grupo: (s.groupConf && s.groupConf.name) || null });
  }
  return out;
}

/** O template como a Neppo devolve (para ver se tem cabeçalho de mídia). Só leitura. */
async function templateBruto(id) {
  const t = (await templates(true)).find((x) => Number(x.id) === Number(id));
  if (!t) throw new Error(`template ${id} não existe`);
  return t;
}

/** Histórico de DISPAROS da Neppo cujo texto contém `texto` (ex.: "Peguei seu contato" = os templates de
 *  prospecção). Só leitura. Serve para não mandar de novo para quem já recebeu quando o volume da Lara
 *  antiga se perdeu. ⚠️ Filtrar por template não funciona na Neppo — por isso o filtro é pelo texto. */
async function historico(texto, maxPaginas) {
  const t = String(texto || '').trim();
  if (t.length < 6) throw new Error('texto curto demais para filtrar');
  const ler = async (valor) => {
    const out = [];
    for (let pg = 0; pg < Math.min(Number(maxPaginas) || 40, 80); pg++) {
      const r = await neppo('/chatapi/1.0/api/direct-message', { conditions: [{ key: 'message', value: valor, operator: 'LIKE', logic: 'AND' }], page: pg, size: 50 });
      if (r.status >= 300) throw new Error(`histórico: HTTP ${r.status}`);
      const parte = (r.json && r.json.results) || [];
      out.push(...parte);
      if (parte.length < 50) break;
    }
    return out;
  };
  let itens = await ler(`%${t}%`);
  let modo = 'curinga';
  if (!itens.length) { itens = await ler(t); modo = 'literal'; }
  return { modo, itens: itens.map((m) => ({ id: m.id, telefone: String(m.phoneNumber || '').replace(/\D/g, ''), status: m.status || null,
    descricao: m.description || null, sessionId: m.sessionId || null, enviadoEm: m.sentAt || m.createdAt || null, grupo: m.groupName || null })) };
}

/** A conversa INTEIRA de um protocolo (cliente, atendente, bot e sistema), em ordem. Só leitura.
 *  É o "abrir a conversa" do Aeroporto de Leads: prova do que foi (ou não foi) respondido.
 *  Até 8 páginas de 50 (400 mensagens); mídia volta com o link https da Neppo. */
async function conversa(sessionId) {
  if (!/^\d+$/.test(String(sessionId))) throw new Error('sessionId inválido');
  const out = [];
  let truncada = false;
  for (let pg = 0; pg < 8; pg++) {
    const r = await neppo('/chatapi/1.0/api/v2/messages', { conditions: [{ key: 'session.id', value: String(sessionId), operator: 'EQNUM', logic: 'AND' }],
      sort: true, sortColumn: 'createdAt', direction: 'ASC', page: pg, size: 50 });
    if (r.status >= 300) throw new Error(`conversa: HTTP ${r.status}`);
    const parte = (r.json && r.json.results) || [];
    out.push(...parte);
    if (parte.length < 50) break;
    if (pg === 7) truncada = true;
  }
  const quem = (m) => {
    if (m.sendBy === 'user') return 'cliente';
    if (m.sendBy === 'bot' || /@botserver/i.test(String(m.fromUser || ''))) return 'bot';
    if (m.sendBy === 'system') return 'sistema';
    const a = m.agent && typeof m.agent === 'object' ? (m.agent.displayName || m.agent.name) : null;
    return a || String(m.fromUser || 'atendente');
  };
  return { truncada, itens: out.map((m) => {
    const midia = m.contentType && m.contentType !== 'TEXT' && typeof m.message === 'string' && /^https:\/\//.test(m.message) ? m.message : null;
    return { em: m.createdAt || null, de: m.sendBy || null, quem: quem(m), tipo: m.contentType || 'TEXT',
      texto: midia ? (m.caption || '') : textoMsg(m), midia };
  }) };
}

/** Sessões (protocolos) CRIADAS numa janela — para o Aeroporto de Leads cruzar telefone × Ploomes. Só leitura.
 *  Uma página por chamada (a Neppo corta em 50); quem chama pagina. `contar` devolve só o total.
 *  ⚠️ AFTER/BEFORE só filtram com EPOCH EM MS — e, se a Neppo ignorar o filtro, ela devolve a base inteira
 *  sem erro. Por isso a rota confere as datas que voltaram e marca `filtroIgnorado` (quem chama aborta). */
const SP_MS = 3 * 3600000;
const isoBr = (s) => { const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? s : String(s) + '-03:00'); return Number.isNaN(t) ? null : t; };
function foneDe(u) {
  if (!u || typeof u !== 'object') return null;
  for (const k of ['phone', 'mobilePhone', 'cellPhone', 'whatsapp', 'phoneNumber']) {
    const d = String(u[k] || '').replace(/\D/g, '');
    if (d.length >= 10) return d;
  }
  for (const k of ['userName', 'username', 'login', 'externalId', 'identifier']) {
    const m = String(u[k] || '').match(/(\d{10,13})/);
    if (m) return m[1];
  }
  return null;
}
async function sessoesJanela(c) {
  const desde = Number(c.desde), ate = Number(c.ate), pagina = Number(c.pagina || 0);
  if (!Number.isInteger(desde) || !Number.isInteger(ate) || desde <= 0 || ate <= desde) throw new Error('janela inválida (desde/ate em epoch ms)');
  if (ate - desde > 400 * 86400000) throw new Error('janela longa demais (máx 400 dias)');
  if (!Number.isInteger(pagina) || pagina < 0 || pagina > 2000) throw new Error('página inválida');
  const conditions = [{ key: 'createdAt', value: String(desde), operator: 'AFTER', logic: 'AND' },
    { key: 'createdAt', value: String(ate), operator: 'BEFORE', logic: 'AND' }];
  if (c.contar) {
    const r = await neppo('/chatapi/1.0/api/v2/user-session/count', { conditions });
    if (r.status >= 300) throw new Error(`contagem: HTTP ${r.status}`);
    const n = typeof r.json === 'number' ? r.json : Number(String(r.texto || '').trim());
    if (!Number.isFinite(n)) throw new Error('contagem: resposta não numérica');
    return { total: n };
  }
  const r = await neppo('/chatapi/1.0/api/v2/user-session', { conditions, page: pagina, size: 50 });
  if (r.status >= 300) throw new Error(`sessões da janela: HTTP ${r.status}`);
  const lista = (r.json && r.json.results) || [];
  // folga de 2 dias nas pontas: a Neppo guarda horário de Brasília sem fuso e o epoch é UTC
  const fora = lista.filter((s) => { const t = isoBr(s.createdAt); return t != null && (t < desde - 2 * 86400000 - SP_MS || t > ate + 2 * 86400000); }).length;
  const itens = lista.map((s) => {
    const ag = s.agent && typeof s.agent === 'object' ? (s.agent.displayName || s.agent.name || s.agent.userName) : null;
    const ult = typeof s.lastAgent === 'string' && s.lastAgent.trim() ? s.lastAgent.trim() : null;
    const u = s.user && typeof s.user === 'object' ? s.user : {};
    return { id: s.id, protocolo: s.protocol || s.customProtocol || null, status: s.status || null,
      criadoEm: s.createdAt || null, atendidoEm: s.attendedAt || null, encerradoEm: s.closedAt || null,
      atendente: ag || ult || null, grupo: (s.groupConf && s.groupConf.name) || null,
      canal: s.channel || u.channel || s.originUser || null, telefone: foneDe(u),
      nome: u.name || u.displayName || u.fullName || u.firstName || null,
      envioAtivo: s.directMessageId || null, soBot: s.onlyBot === true };
  });
  const out = { pagina, itens, fim: lista.length < 50, filtroIgnorado: lista.length > 0 && fora > lista.length / 2 };
  if (c.debug && lista[0]) out.campos = { sessao: Object.keys(lista[0]), usuario: Object.keys(lista[0].user || {}) };
  return out;
}

function legado() {
  const ler = (f, pad) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (_) { return pad; } };
  return { leads: ler('leads.json', []), estado: ler('state.json', {}) };
}

// ---------- HTTP ----------
function chaveOk(req) {
  const chave = process.env.COCKPIT_KEY || '';
  return Boolean(chave) && req.headers['x-cockpit-key'] === chave;
}

function corpoJson(req) {
  return new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e5) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (_) { ok({}); } }); });
}

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const enviarJson = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/health') return enviarJson(200, { ok: true, servico: 'ponte-neppo', neppo: configurado(), chave: Boolean(process.env.COCKPIT_KEY) });
    if (!process.env.COCKPIT_KEY) return enviarJson(503, { erro: 'COCKPIT_KEY não configurada' });
    if (!chaveOk(req)) return enviarJson(401, { erro: 'chave inválida' });
    if (!configurado()) return enviarJson(503, { erro: 'credenciais da Neppo ausentes' });
    if (req.method === 'GET' && u.pathname === '/templates') {
      return enviarJson(200, { itens: (await templates(u.searchParams.get('forcar') === '1')).map(resumoTpl) });
    }
    if (req.method === 'POST' && u.pathname === '/enviar') return enviarJson(200, await enviar(await corpoJson(req)));
    if (req.method === 'POST' && u.pathname === '/status') return enviarJson(200, { itens: await status((await corpoJson(req)).ids) });
    if (req.method === 'POST' && u.pathname === '/mensagens') return enviarJson(200, { itens: await mensagens((await corpoJson(req)).sessionId) });
    if (req.method === 'POST' && u.pathname === '/sessoes') return enviarJson(200, { itens: await sessoes((await corpoJson(req)).ids) });
    if (req.method === 'POST' && u.pathname === '/sessoes-janela') return enviarJson(200, await sessoesJanela(await corpoJson(req)));
    if (req.method === 'POST' && u.pathname === '/conversa') return enviarJson(200, await conversa((await corpoJson(req)).sessionId));
    let mt;
    if (req.method === 'GET' && (mt = u.pathname.match(/^\/templates\/(\d+)$/))) return enviarJson(200, await templateBruto(mt[1]));
    if (req.method === 'GET' && u.pathname === '/legado') return enviarJson(200, legado());
    if (req.method === 'GET' && u.pathname === '/historico') return enviarJson(200, await historico(u.searchParams.get('texto'), u.searchParams.get('paginas')));
    return enviarJson(404, { erro: 'rota inexistente' });
  } catch (e) {
    return enviarJson(502, { erro: e.message });
  }
});

if (require.main === module) {
  srv.listen(PORT, () => console.log(`ponte-neppo no ar :${PORT} · neppo ${configurado() ? 'ok' : 'SEM credencial'} · chave ${process.env.COCKPIT_KEY ? 'ok' : 'AUSENTE'}`));
}
module.exports = { srv };
