'use strict';
// Teste da ponte Neppo contra uma Neppo FALSA (nada real é tocado). node _teste_ponte.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let oks = 0, falhas = 0;
const ok = (c, m, x) => { if (c) { oks++; console.log('  ok  ' + m); } else { falhas++; console.log('  FALHA  ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };

const st = { tokens: 0, envios: [], derrubar: false, paginas: [] };
const TEMPLATES = Array.from({ length: 60 }, (_, i) => ({ id: i + 60, elementName: 'tpl_' + (i + 60), nameSpace: 'ns', template: 'Olá ' + (i + 60), parameterCount: i + 60 === 99 ? 2 : 0 }));
TEMPLATES[50] = { id: 110, elementName: 'fixo_lara', nameSpace: 'ns-lar', template: 'Oi! Vi sua empresa no Google…', parameterCount: 0 };
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const j = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/oauth2/token') { st.tokens++; return j(200, { access_token: 'tok' + st.tokens, expires_in: 3600 }); }
    const auth = req.headers.authorization || '';
    if (st.derrubar && auth === 'Bearer tok' + st.tokens && st.tokens === 1) { st.derrubar = false; return j(401, { erro: 'outro consumidor renovou' }); }
    const c = b ? JSON.parse(b) : {};
    if (req.url === '/chatapi/1.0/api/hsm-template') { st.paginas.push(c.page); return j(200, { results: TEMPLATES.slice(c.page * 50, c.page * 50 + 50) }); }
    if (req.url === '/chatapi/1.0/api/direct-message/save') { st.envios.push(c); return j(200, { id: 900 + st.envios.length }); }
    if (req.url === '/chatapi/1.0/api/direct-message') {
      const id = Number(c.conditions[0].value);
      return j(200, { results: [{ id, status: id === 901 ? 'LIDA' : 'ERRO', description: id === 901 ? null : '131049 - not delivered', sessionId: id === 901 ? 555 : null, sentAt: '2026-10-07T10:00:00', updatedAt: '2026-10-07T10:05:00' }] });
    }
    if (req.url === '/chatapi/1.0/api/v2/messages') {
      return j(200, { results: [{ sendBy: 'system', message: 'template', createdAt: 'a' }, { sendBy: 'user', message: 'pode me tirar da lista', contentType: 'TEXT', createdAt: 'b' }, { sendBy: 'user', message: 'https://x/a.jpg', contentType: 'IMAGE', createdAt: 'c' }] });
    }
    return j(404, {});
  });
});

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fp = fake.address().port;
  const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-'));
  fs.writeFileSync(path.join(dados, 'leads.json'), JSON.stringify([{ id: 'L1', name: 'Loja A', status: 'sent', msgId: 777 }]));
  fs.writeFileSync(path.join(dados, 'state.json'), JSON.stringify({ monthSent: 120 }));
  Object.assign(process.env, { NEPPO_BASE: `http://127.0.0.1:${fp}`, NEPPO_AUTH_URL: `http://127.0.0.1:${fp}/oauth2/token`, DATA_DIR: dados,
    NEPPO_USERNAME: 'u', NEPPO_PASSWORD: 'p', NEPPO_CUSTOMER_KEY: 'k', NEPPO_CUSTOMER_SECRET: 's', COCKPIT_KEY: 'chave-teste' });
  const { srv } = require('./ponte');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (m, rota, corpo, chave) => {
    const r = await fetch(base + rota, { method: m, headers: { 'content-type': 'application/json', ...(chave === false ? {} : { 'x-cockpit-key': chave || 'chave-teste' }) }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { s: r.status, j: await r.json() };
  };
  try {
    const h = await req('GET', '/health', null, false);
    ok(h.s === 200 && h.j.neppo === true && h.j.chave === true, '/health é público e diz se há credencial', h.j);
    ok((await req('GET', '/templates', null, false)).s === 401, 'sem a chave: 401');
    ok((await req('GET', '/templates', null, 'errada')).s === 401, 'chave errada: 401');

    const t = await req('GET', '/templates');
    ok(t.j.itens.length === 60 && st.paginas.join() === '0,1', 'templates: segue a paginação de 50 (2 páginas)', st.paginas);
    const t110 = t.j.itens.find((x) => x.id === 110);
    ok(t110 && t110.nome === 'fixo_lara' && t110.parametros === 0 && /Google/.test(t110.texto), 'o 110 (da 2ª página) aparece com nome e texto', t110);

    ok((await req('POST', '/enviar', { telefone: '123', templateId: 110 })).j.erro.includes('telefone inválido'), 'telefone inválido é recusado');
    ok(/não existe/.test((await req('POST', '/enviar', { telefone: '5511999998888', templateId: 4 })).j.erro), 'template inexistente é recusado');
    ok(/parâmetro/.test((await req('POST', '/enviar', { telefone: '5511999998888', templateId: 99 })).j.erro), 'template com parâmetro é recusado (não suportado)');
    ok(/https/.test((await req('POST', '/enviar', { telefone: '5511999998888', templateId: 110, imagem: 'http://x/a.jpg' })).j.erro), 'imagem sem https é recusada');
    st.derrubar = true;   // o próximo pedido leva 401 (outro app renovou o token)
    const e = await req('POST', '/enviar', { telefone: '5511999998888', templateId: 110, imagem: 'https://cdn.x/prospec.jpg' });
    ok(e.j.ok === true && e.j.id === 901, 'envia e devolve o id da mensagem', e.j);
    ok(st.tokens === 2 && st.envios.length === 1, '401 de token roubado: renova e tenta UMA vez (sem duplicar o envio)', { tokens: st.tokens, envios: st.envios.length });
    const env = st.envios[0];
    const info = JSON.parse(env.additionalInfo);
    ok(env.phoneNumber === '5511999998888' && env.groupName === 'Lar Plasticos WhatsApp' && env.groupConfId === 1 && env.userId === 106,
      'vai pelo grupo que entrega (Lar Plasticos WhatsApp, conf 1)', env);
    ok(info.elementName === 'fixo_lara' && info.namespace === 'ns-lar' && info.medias.HEADER[0].url === 'https://cdn.x/prospec.jpg' && info.medias.HEADER[0].extension === '.jpg',
      'template e imagem do cabeçalho vão no additionalInfo', info);

    const s = await req('POST', '/status', { ids: [901, 902, 'x; drop'] });
    ok(s.j.itens.length === 2 && s.j.itens[0].status === 'LIDA' && s.j.itens[0].sessionId === 555 && /131049/.test(s.j.itens[1].descricao),
      'status: estado, sessão (= respondeu) e motivo do erro; id não numérico é ignorado', s.j);
    const msg = await req('POST', '/mensagens', { sessionId: 555 });
    ok(msg.j.itens.length === 2 && msg.j.itens[0].texto === 'pode me tirar da lista' && msg.j.itens[1].texto === '[IMAGE]', 'mensagens: só o que o PROSPECT escreveu', msg.j);
    ok((await req('POST', '/mensagens', { sessionId: '1 OR 1' })).s === 502, 'sessionId inválido é recusado');
    const lg = await req('GET', '/legado');
    ok(lg.j.leads.length === 1 && lg.j.leads[0].msgId === 777 && lg.j.estado.monthSent === 120, 'legado: devolve a fila e o estado da Lara antiga (só leitura)', lg.j);
    ok((await req('GET', '/nada')).s === 404, 'rota inexistente: 404');
  } catch (e2) { falhas++; console.log('  ERRO  ' + e2.stack); }
  finally {
    srv.closeAllConnections(); fake.closeAllConnections();
    srv.close(); fake.close();
    console.log(`\n${oks} ok · ${falhas} falha(s)`);
    process.exitCode = falhas ? 1 : 0;
  }
})();
