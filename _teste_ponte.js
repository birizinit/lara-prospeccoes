'use strict';
// Teste da ponte Neppo contra uma Neppo FALSA (nada real é tocado). node _teste_ponte.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let oks = 0, falhas = 0;
const ok = (c, m, x) => { if (c) { oks++; console.log('  ok  ' + m); } else { falhas++; console.log('  FALHA  ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };

const st = { tokens: 0, envios: [], derrubar: false, paginas: [], likes: [], janelas: [], contagens: [], ignorarFiltro: false };
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
    if (req.url === '/chatapi/1.0/api/v2/user-session/count') { st.contagens.push(c.conditions); return j(200, 120); }
    if (req.url === '/chatapi/1.0/api/v2/user-session' && c.conditions[0].key === 'createdAt') {
      st.janelas.push({ conds: c.conditions, page: c.page, size: c.size });
      const desde = Number(c.conditions[0].value), ate = Number(c.conditions[1].value);
      // 120 sessões espalhadas na janela, em horário de Brasília SEM fuso (como a Neppo devolve)
      const brt = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 19);
      const todas = Array.from({ length: 120 }, (_, i) => {
        const t = st.ignorarFiltro ? Date.UTC(2023, 0, 1) + i * 3600000 : desde + Math.floor((ate - desde) * (i + 0.5) / 120);
        return { id: 7000 + i, protocol: 'WA' + String(7000 + i).padStart(11, '0'), status: i % 4 ? 'CLOSED' : 'OPEN', createdAt: brt(t),
          attendedAt: i % 3 ? brt(t + 60000) : null, closedAt: i % 4 ? brt(t + 3600000) : null,
          agent: i % 3 ? { displayName: 'Vendedor ' + (i % 5) } : null, lastAgent: i % 3 ? 'vend' + (i % 5) : 'Lar Plásticos - V16 0 DOS@botserver',
          groupConf: { name: i % 2 ? 'Equipe Revenda' : 'Equipe Final' }, channel: 'WHATSAPP', directMessageId: i === 5 ? 99 : null, onlyBot: i % 3 === 0,
          user: i === 7 ? { userName: 'whatsapp_5531999990007', name: 'Cliente Sete' } : { phone: '+55 (11) 9' + String(80000000 + i), name: 'Cliente ' + i } };
      });
      return j(200, { results: todas.slice(c.page * 50, c.page * 50 + 50) });
    }
    if (req.url === '/chatapi/1.0/api/v2/user-session') {
      const id = Number(c.conditions[0].value);
      if (id === 557) return j(200, { results: [{ id: 557, protocol: 'WA00000032176', status: 'CLOSED', agent: null, lastAgent: 'priscilla.caetano', closedAt: '2026-09-02T10:00:00', groupConf: { name: 'Lar Plasticos WhatsApp' } }] });
      return j(200, { results: id === 555 ? [{ id: 555, protocol: 'WA00000031668', status: 'OPEN', agent: { id: 9, displayName: 'Priscilla Caetano', name: 'Priscilla', userName: 'priscilla.caetano' }, lastAgent: 'priscilla.caetano', attendedAt: '2026-10-07T10:10:00', closedAt: null }] : [] });
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
    const se = await req('POST', '/sessoes', { ids: [555, 556, 'x', 557] });
    ok(se.j.itens.length === 2 && se.j.itens[0].protocolo === 'WA00000031668' && se.j.itens[0].atendente === 'Priscilla Caetano' && se.j.itens[0].status === 'OPEN',
      'sessões: protocolo, situação e quem assumiu (sessão inexistente e id inválido ignorados)', se.j);
    ok(se.j.itens[1].atendente === 'priscilla.caetano' && se.j.itens[1].encerradoEm && se.j.itens[1].grupo === 'Lar Plasticos WhatsApp',
      'atendimento encerrado sem agente: usa o último que atendeu (lastAgent)', se.j.itens[1]);
    const tb = await req('GET', '/templates/110');
    ok(tb.s === 200 && tb.j.elementName === 'fixo_lara' && tb.j.nameSpace === 'ns-lar', 'template cru (para ver o cabeçalho)', tb.j);
    ok((await req('GET', '/templates/4')).s === 502, 'template cru inexistente: erro');
    const hs = await req('GET', '/historico?texto=' + encodeURIComponent('Peguei seu contato'));
    ok(hs.j.modo === 'literal' && hs.j.itens.length === 63 && st.likes[0] === '%Peguei seu contato%' && st.likes.includes('Peguei seu contato'),
      'histórico: tenta o curinga, cai no literal e pagina (63 disparos em 2 páginas)', { modo: hs.j.modo, n: hs.j.itens.length, likes: st.likes });
    ok(hs.j.itens[0].telefone === '5511980000000' && hs.j.itens[0].sessionId === 400 && hs.j.itens[0].status === 'ERRO' && hs.j.itens[0].descricao === '131026',
      'histórico: telefone só dígitos, sessão (= respondeu), estado e motivo', hs.j.itens[0]);
    ok((await req('GET', '/historico?texto=oi')).s === 502, 'histórico: texto curto demais é recusado (não varre tudo)');
    // ---- sessões por janela (Aeroporto de Leads) ----
    const D0 = Date.UTC(2026, 8, 1, 3), D1 = Date.UTC(2026, 9, 1, 3);   // set/2026 em horário de Brasília
    const jc = await req('POST', '/sessoes-janela', { desde: D0, ate: D1, contar: true });
    ok(jc.s === 200 && jc.j.total === 120, 'janela: contar devolve o total da Neppo', jc.j);
    ok(st.contagens[0][0].operator === 'AFTER' && st.contagens[0][0].value === String(D0) && st.contagens[0][1].operator === 'BEFORE' && st.contagens[0][1].value === String(D1),
      'janela: filtra createdAt com AFTER/BEFORE em EPOCH MS (a forma que a Neppo respeita)', st.contagens[0]);
    const j0 = await req('POST', '/sessoes-janela', { desde: D0, ate: D1, pagina: 0, debug: true });
    const j2 = await req('POST', '/sessoes-janela', { desde: D0, ate: D1, pagina: 2 });
    ok(j0.j.itens.length === 50 && !j0.j.fim && j2.j.itens.length === 20 && j2.j.fim && st.janelas[1].page === 2 && st.janelas[1].size === 50,
      'janela: uma página de 50 por chamada; a última diz fim', { p0: j0.j.itens.length, p2: j2.j.itens.length, fim: j2.j.fim });
    const s0 = j0.j.itens[0], s1 = j0.j.itens[1];
    ok(s0.protocolo === 'WA00000007000' && s0.telefone === '5511980000000' && s0.nome === 'Cliente 0' && s0.grupo === 'Equipe Final' && s0.canal === 'WHATSAPP',
      'janela: protocolo, telefone só dígitos, nome, grupo e canal', s0);
    ok(s0.atendente === 'Lar Plásticos - V16 0 DOS@botserver' && s0.atendidoEm === null && s0.soBot === true && s1.atendente === 'Vendedor 1' && s1.atendidoEm,
      'janela: ninguém assumiu (só bot) × atendida por vendedor', [s0, s1]);
    ok(j0.j.itens[7].telefone === '5531999990007' && j0.j.itens[5].envioAtivo === 99, 'janela: telefone tirado do whatsapp_<número> e envio ativo marcado', [j0.j.itens[7], j0.j.itens[5]]);
    ok(j0.j.filtroIgnorado === false, 'janela: datas dentro da janela → filtro respeitado');
    ok(j0.j.campos && j0.j.campos.usuario.includes('phone') && !j2.j.campos, 'janela: debug devolve os nomes dos campos (só quando pedido)', j0.j.campos);
    st.ignorarFiltro = true;
    const ji = await req('POST', '/sessoes-janela', { desde: D0, ate: D1, pagina: 0 });
    st.ignorarFiltro = false;
    ok(ji.s === 200 && ji.j.filtroIgnorado === true, 'janela: se a Neppo IGNORAR o filtro (devolve 2023), a rota acusa em vez de passar a base inteira', ji.j.filtroIgnorado);
    ok((await req('POST', '/sessoes-janela', { desde: D1, ate: D0 })).s === 502, 'janela: desde depois de ate é recusado');
    ok((await req('POST', '/sessoes-janela', { desde: 'ontem', ate: D1 })).s === 502, 'janela: data que não é epoch é recusada');
    ok((await req('POST', '/sessoes-janela', { desde: D0 - 500 * 86400000, ate: D1 })).s === 502, 'janela: mais de 400 dias é recusada');
    ok((await req('POST', '/sessoes-janela', { desde: D0, ate: D1, pagina: -1 })).s === 502, 'janela: página negativa é recusada');
    ok((await req('POST', '/sessoes-janela', { desde: D0, ate: D1 }, false)).s === 401, 'janela: sem a chave, 401');

    ok((await req('GET', '/nada')).s === 404, 'rota inexistente: 404');
  } catch (e2) { falhas++; console.log('  ERRO  ' + e2.stack); }
  finally {
    srv.closeAllConnections(); fake.closeAllConnections();
    srv.close(); fake.close();
    console.log(`\n${oks} ok · ${falhas} falha(s)`);
    process.exitCode = falhas ? 1 : 0;
  }
})();
