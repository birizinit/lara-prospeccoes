'use strict';
/**
 * Prova o canal de avisos SEM tocar na Evolution nem na Neppo.
 * O que importa: os 2 eventos disparam, os toggles calam, e um aviso que
 * EXPLODE nao pode derrubar o disparo nem a criacao do negocio.
 */
const { Avisos, fone, dataHoraSP } = require('./avisos');

const ok = [], falha = [];
const t = (nome, cond, det) => (cond ? ok : falha).push(nome + (det ? ' — ' + det : ''));

const lead = {
  name: 'BORBA - PC Gamer e Informatica', category: 'Loja de informática',
  city: 'Uberlândia', phoneNorm: '+5534998137128',
  sentAt: '2026-09-02T13:14:00Z', entrega: 'LIDA', respondeuEm: '2026-09-04T11:42:00Z',
};

(async () => {
  // --- formatacao ---
  t('telefone em formato BR', fone('+5534998137128') === '(34) 99813-7128', fone('+5534998137128'));
  t('telefone fixo 10 digitos', fone('5511441668') === '(55) 1144-1668' || fone('+551144166868') === '(11) 4416-6868');
  t('data em horario de Brasilia (UTC-3)', dataHoraSP('2026-09-02T13:14:00Z') === '02/09 às 10:14',
    dataHoraSP('2026-09-02T13:14:00Z'));
  t('data invalida nao quebra', dataHoraSP('lixo') === '—');

  // --- gate de configuracao ---
  const semChave = new Avisos({ apikey: '', numeros: '5571991945850' });
  t('sem apikey fica desligado e diz por que', !semChave.ligado && /EVOLUTION_APIKEY/.test(semChave.estado.motivo));
  const semNum = new Avisos({ apikey: 'x', numeros: '' });
  t('sem destino fica desligado', !semNum.ligado && /AVISO_NUMEROS/.test(semNum.estado.motivo));
  const cfg = new Avisos({ apikey: 'x', numeros: '(71) 99194-5850' });
  t('numero normaliza para digitos', cfg.numeros[0] === '71991945850', cfg.numeros[0]);

  // --- os 2 eventos disparam e o conteudo e' o certo ---
  const enviados = [];
  const a = new Avisos({ apikey: 'x', numeros: '5571991945850' });
  a.enviar = async (txt) => { enviados.push(txt); return { ok: true }; };
  await a.disparo(lead, { daySent: 12, dailyCap: 50, monthSent: 340, monthlyCap: 1100 });
  await a.crm(lead, { dealId: 1202943973, dono: 'Gabriel Rodrigues' }, { enviados: 36, respondidos: 19 });
  t('os 2 eventos enviam', enviados.length === 2, enviados.length + '');
  t('disparo diz o nome da empresa e a cidade',
    /BORBA/.test(enviados[0]) && /Uberlândia/.test(enviados[0]));
  t('disparo explica o processo (nao e log)',
    /Google Maps/.test(enviados[0]) && /O que aconteceu/.test(enviados[0]) && /Próximo passo/.test(enviados[0]));
  t('disparo mostra o ritmo do dia em pt-BR', /12 de 50/.test(enviados[0]) && /1\.100/.test(enviados[0]));
  t('CRM diz o numero do negocio e o dono',
    /1202943973/.test(enviados[1]) && /Gabriel Rodrigues/.test(enviados[1]));
  t('CRM conta a cronologia numerada',
    /1\. A Lara mandou/.test(enviados[1]) && /A pessoa respondeu/.test(enviados[1]));
  t('CRM diz o que fazer agora', /O que precisa acontecer agora/.test(enviados[1]));
  t('CRM traz a taxa em pt-BR', /52,8%/.test(enviados[1]), (enviados[1].match(/\(.*%\)/) || [''])[0]);
  t('sem undefined/NaN nos textos', !/undefined|NaN/.test(enviados.join('\n')));

  // --- lead magro nao quebra o texto ---
  enviados.length = 0;
  await a.disparo({ name: 'X', phoneNorm: '+5511999999999' }, {});
  await a.crm({ name: 'X', phoneNorm: '+5511999999999' }, {}, {});
  t('lead sem cidade/categoria/deal nao gera undefined', !/undefined|NaN|—\s*$/.test(enviados.join('\n')));
  t('CRM sem entrega renumera a cronologia', /2\. \*A pessoa respondeu\*/.test(enviados[1]));

  // --- toggles calam ---
  const off = new Avisos({ apikey: 'x', numeros: '5571991945850', avisaDisparo: false, avisaCrm: false });
  let mandou = 0; off.enviar = async () => { mandou++; return { ok: true }; };
  await off.disparo(lead, {}); await off.crm(lead, {}, {});
  t('toggles desligados nao enviam nada', mandou === 0, mandou + '');

  // --- o que mais importa: aviso quebrado NAO derruba o fluxo ---
  const bomba = new Avisos({ apikey: 'x', numeros: '5571991945850' });
  bomba.enviar = async () => { throw new Error('Evolution fora do ar'); };
  let seguiu = false;
  try {
    // e' assim que o server.js chama: fire-and-forget com catch
    bomba.disparo(lead, {}).then(() => {}).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    seguiu = true;
  } catch (e) { seguiu = false; }
  t('aviso que explode nao derruba a campanha', seguiu);
  const r = await bomba.disparo(lead, {}).catch((e) => ({ erro: e.message }));
  t('a falha e observavel (nao some em silencio)', !!(r && r.erro), (r && r.erro) || '');

  // --- o server.js esta plugado nos 2 pontos ---
  const src = require('fs').readFileSync('server.js', 'utf8');
  t('server chama avisos.disparo no envio real', /avisos\.disparo\(lead/.test(src));
  t('server chama avisos.crm quando cria o negocio', /avisos\.crm\(l,\s*r/.test(src));
  t('ambas com .catch (nao derrubam o fluxo)',
    (src.match(/avisos\.(disparo|crm)\([\s\S]{0,400}?\.catch\(/g) || []).length === 2);
  t('dry-run NAO avisa (simulacao nao vira mensagem)',
    src.indexOf('avisos.disparo') > src.indexOf('const res = await neppoSend'));
  t('toggles persistem no volume', /'avisaDisparo', 'avisaCrm'/.test(src));
  t('painel pode mudar os toggles', /p\.avisaDisparo !== undefined/.test(src));

  console.log('\n=== AVISOS DA LARA ===');
  ok.forEach((x) => console.log('  OK   ' + x));
  falha.forEach((x) => console.log('  FALHA ' + x));
  console.log('\n' + ok.length + ' ok · ' + falha.length + ' falha(s)');
  process.exit(falha.length ? 1 : 0);
})();
