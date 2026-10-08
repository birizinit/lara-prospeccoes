'use strict';
// Teste da ponte Neppo contra uma Neppo FALSA (nada real é tocado). node _teste_ponte.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let oks = 0, falhas = 0;
const ok = (c, m, x) => { if (c) { oks++; console.log('  ok  ' + m); } else { falhas++; console.log('  FALHA  ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };

const st = { tokens: 0, envios: [], derrubar: false, paginas: [], likes: [] };
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
    if (req.url === '/chatapi/1.0/api/direct-message' && c.conditions[0].key === 'message') {
      // esta Neppo falsa NÃO entende o curinga %: só o texto literal casa (a ponte tem de cair no 2º modo)
      st.likes.push(c.conditions[0].value);
      if (c.conditions[0].value.includes('%')) return j(200, { results: [] });
      const todos = Array.from({ length: 63 }, (_, i) => ({ id: 3000 + i, phoneNumber: '+55 11 9' + String(80000000 + i), status: i % 3 ? 'LIDA' : 'ERRO',
        description: i % 3 ? null : '131026', sessionId: i % 5 === 0 ? 400 + i : null, sentAt: '2026-09-0' + (1 + (i % 9)) + 'T12:00:00', groupName: 'Lar Plasticos WhatsApp' }));
      return j(200, { results: todos.slice(c.page * 50, c.page * 50 + 50) });
    }
    if (req.url === '/chatapi/1.0/api/direct-message') {
      const id = Number(c.conditions[0].value);
      return j(200, { results: [{ id, status: id === 901 ? 'LIDA' : 'ERRO', description: id === 901 ? null : '131049 - not delivered', sessionId: id === 901 ? 555 : null, sentAt: '2026-10-07T10:00:00', updatedAt: '2026-10-07T10:05:00' }] });
    }
    if (req.url === '/chatapi/1.0/api/v2/user-session') {
      const id = Number(c.conditions[0].value);
      return j(200, { results: id === 555 ? [{ id: 555, protocol: 'WA00000031668', status: 'OPEN', agent: { name: 'Priscilla Caetano' }, attendedAt: '2026-10-07T10:10:00', closedAt: null }] : [] });
    }
    if (req.url === '/chatapi/1.0/api/v2/messages') {
      return j(200, { results: [{ sendBy: 'system', message: 'template', createdAt: 'a' }, { sendBy: 'user', message: 'pode me tirar da lista', contentType: 'TEXT', createdAt: 'b' }, { sendBy: 'user', message: 'https://x/a.jpg', contentType: 'IMAGE', createdAt: 'c' },
        { sendBy: 'user', message: 'Não tenho interesse', contentType: 'BUTTON', createdAt: 'd' }, { sendBy: 'user', message: { text: 'Quero conhecer' }, contentType: 'INTERACTIVE', createdAt: 'e' }] });
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
    ok(msg.j.itens.length === 4 && msg.j.itens[0].texto === 'pode me tirar da lista' && msg.j.itens[1].texto === '[IMAGE]', 'mensagens: só o que o PROSPECT escreveu', msg.j);
    ok(msg.j.itens[2].texto === 'Não tenho interesse' && msg.j.itens[3].texto === 'Quero conhecer',
      'clique em botão de resposta rápida chega com o TEXTO do botão (senão quem recusou viraria negócio)', msg.j.itens.slice(2));
    ok((await req('POST', '/mensagens', { sessionId: '1 OR 1' })).s === 502, 'sessionId inválido é recusado');
    const lg = await req('GET', '/legado');
    ok(lg.j.leads.length === 1 && lg.j.leads[0].msgId === 777 && lg.j.estado.monthSent === 120, 'legado: devolve a fila e o estado da Lara antiga (só leitura)', lg.j);
    const se = await req('POST', '/sessoes', { ids: [555, 556, 'x'] });
    ok(se.j.itens.length === 1 && se.j.itens[0].protocolo === 'WA00000031668' && se.j.itens[0].atendente === 'Priscilla Caetano' && se.j.itens[0].status === 'OPEN',
      'sessões: protocolo, situação e quem assumiu (sessão inexistente e id inválido ignorados)', se.j);
    const tb = await req('GET', '/templates/110');
    ok(tb.s === 200 && tb.j.elementName === 'fixo_lara' && tb.j.nameSpace === 'ns-lar', 'template cru (para ver o cabeçalho)', tb.j);
    ok((await req('GET', '/templates/4')).s === 502, 'template cru inexistente: erro');
    const hs = await req('GET', '/historico?texto=' + encodeURIComponent('Peguei seu contato'));
    ok(hs.j.modo === 'literal' && hs.j.itens.length === 63 && st.likes[0] === '%Peguei seu contato%' && st.likes.includes('Peguei seu contato'),
      'histórico: tenta o curinga, cai no literal e pagina (63 disparos em 2 páginas)', { modo: hs.j.modo, n: hs.j.itens.length, likes: st.likes });
    ok(hs.j.itens[0].telefone === '5511980000000' && hs.j.itens[0].sessionId === 400 && hs.j.itens[0].status === 'ERRO' && hs.j.itens[0].descricao === '131026',
      'histórico: telefone só dígitos, sessão (= respondeu), estado e motivo', hs.j.itens[0]);
    ok((await req('GET', '/historico?texto=oi')).s === 502, 'histórico: texto curto demais é recusado (não varre tudo)');
    ok((await req('GET', '/nada')).s === 404, 'rota inexistente: 404');
  } catch (e2) { falhas++; console.log('  ERRO  ' + e2.stack); }
  finally {
    srv.closeAllConnections(); fake.closeAllConnections();
    srv.close(); fake.close();
    console.log(`\n${oks} ok · ${falhas} falha(s)`);
    process.exitCode = falhas ? 1 : 0;
  }
})();
