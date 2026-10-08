'use strict';
/**
 * Avisos da Lara no WhatsApp do Diretor.
 *
 * Dois eventos, e só eles:
 *   1. a Lara mandou a apresentação para um prospect
 *   2. o prospect respondeu e virou negócio no Ploomes
 *
 * ⚠️ Canal = EVOLUTION, não Neppo. A Neppo só entrega TEMPLATE APROVADO (texto
 *    fixo, sem variável livre) — aviso operacional muda a cada ocorrência, então
 *    template não serve. A Evolution manda texto livre.
 * ⚠️ O nome da instância tem ESPAÇO ("Gabriel Hernandes") -> encodeURIComponent.
 * ⚠️ Aviso NUNCA derruba o disparo: quem chama usa fire-and-forget com catch.
 *    Perder um aviso é chato; perder um lead porque o aviso falhou é inaceitável.
 *
 * O texto é escrito para o Diretor: diz o que aconteceu, o que a Lara fez e
 * qual é o próximo passo — não é log técnico.
 */

const URL_PADRAO = 'https://evolution-api-production-14c9.up.railway.app';

function digitos(s) { return String(s || '').replace(/\D/g, ''); }

/** 1100 -> 1.100 · 52.8 -> 52,8 — o Diretor le em pt-BR. */
function n(v, casas) {
  return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas || 0,
                                                  maximumFractionDigits: casas || 0 });
}

/** +5534998137128 -> (34) 99813-7128 — como o Diretor lê um telefone. */
function fone(e164) {
  const d = digitos(e164).replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return e164 || '—';
}

/** O container roda em UTC; quem lê pensa em horário de Brasília. */
function dataHoraSP(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d)) return '—';
  const sp = new Date(d.getTime() - 3 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(sp.getUTCDate())}/${p(sp.getUTCMonth() + 1)} às ${p(sp.getUTCHours())}:${p(sp.getUTCMinutes())}`;
}

class Avisos {
  constructor(cfg = {}) {
    this.url = String(cfg.url || process.env.EVOLUTION_URL || URL_PADRAO).replace(/\/+$/, '');
    this.instancia = cfg.instancia || process.env.EVOLUTION_INSTANCIA || 'Gabriel Hernandes';
    this.apikey = cfg.apikey || process.env.EVOLUTION_APIKEY || '';
    this.numeros = String(cfg.numeros || process.env.AVISO_NUMEROS || '')
      .split(',').map(digitos).filter(Boolean);
    // cada evento liga/desliga sozinho: 50 disparos/dia é muita mensagem, e o
    // Diretor precisa poder calar o "enviou" sem perder o "virou negócio".
    this.avisaDisparo = cfg.avisaDisparo !== false;
    this.avisaCrm = cfg.avisaCrm !== false;
    this.ligado = !!(this.url && this.instancia && this.apikey && this.numeros.length);
  }

  get estado() {
    return {
      ligado: this.ligado, instancia: this.instancia, destinos: this.numeros.length,
      avisaDisparo: this.avisaDisparo, avisaCrm: this.avisaCrm,
      motivo: this.ligado ? null : (!this.apikey ? 'falta EVOLUTION_APIKEY'
        : (!this.numeros.length ? 'falta AVISO_NUMEROS' : 'configuração incompleta')),
    };
  }

  async enviar(texto) {
    if (!this.ligado) return { ok: false, motivo: this.estado.motivo };
    const out = [];
    for (const num of this.numeros) {
      try {
        const r = await fetch(this.url + '/message/sendText/' + encodeURIComponent(this.instancia), {
          method: 'POST',
          headers: { apikey: this.apikey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: num, text: texto }),
        });
        const t = await r.text();
        out.push({ num, ok: r.ok, status: r.status, resp: r.ok ? '' : t.slice(0, 140) });
      } catch (e) {
        out.push({ num, ok: false, erro: String(e.message || e).slice(0, 140) });
      }
    }
    return { ok: out.some((o) => o.ok), detalhe: out };
  }

  /** 1) A Lara mandou a apresentação para um prospect. */
  async disparo(lead, ctx = {}) {
    if (!this.avisaDisparo) return { ok: false, motivo: 'aviso de disparo desligado' };
    const L = [];
    L.push('🤖 *LARA · mensagem enviada*');
    L.push('');
    L.push(`*${lead.name || 'empresa sem nome'}*`);
    if (lead.category) L.push(`_${lead.category}_`);
    if (lead.city) L.push(`📍 ${lead.city}`);
    L.push(`📱 ${fone(lead.phoneNorm)}`);
    L.push('');
    L.push('*O que aconteceu*');
    L.push('A Lara achou essa empresa no Google Maps, conferiu que o número tem WhatsApp e mandou a '
           + 'apresentação da Lar — a peça com a foto e o texto aprovado. Ninguém do time precisou fazer nada.');
    L.push('');
    L.push('*Próximo passo*');
    L.push('Se ela responder, a Lara abre o negócio no Ploomes sozinha e te avisa aqui de novo. '
           + 'Se não responder, nada acontece — não insistimos.');
    if (ctx.daySent != null) {
      L.push('');
      L.push(`_Hoje: ${n(ctx.daySent)} de ${n(ctx.dailyCap)} disparos · no mês: `
              + `${n(ctx.monthSent)} de ${n(ctx.monthlyCap)}_`);
    }
    return this.enviar(L.join('\n'));
  }

  /** 2) O prospect respondeu e a Lara criou o negócio no Ploomes. */
  async crm(lead, deal, ctx = {}) {
    if (!this.avisaCrm) return { ok: false, motivo: 'aviso de CRM desligado' };
    const L = [];
    L.push('🎯 *LARA · o prospect RESPONDEU e já virou negócio no CRM*');
    L.push('');
    L.push(`*${lead.name || 'empresa sem nome'}*`);
    if (lead.category) L.push(`_${lead.category}_`);
    if (lead.city) L.push(`📍 ${lead.city}`);
    L.push(`📱 ${fone(lead.phoneNorm)}`);
    L.push('');
    L.push('*Como chegamos aqui*');
    L.push(`1. A Lara mandou a apresentação em ${dataHoraSP(lead.sentAt)}`);
    if (lead.entrega) L.push(`2. A mensagem foi ${String(lead.entrega).toLowerCase()} no WhatsApp dele`);
    L.push(`${lead.entrega ? 3 : 2}. *A pessoa respondeu* — foi em ${dataHoraSP(lead.respondeuEm)}`);
    L.push(`${lead.entrega ? 4 : 3}. Responder é sinal de interesse, então a Lara já cadastrou no Ploomes`);
    L.push('');
    L.push('*No CRM*');
    if (deal && deal.dealId) L.push(`Negócio nº ${deal.dealId}`);
    L.push('Funil: Entradas e Prospecção → etapa Oportunidades');
    if (deal && deal.dono) L.push(`Responsável: *${deal.dono}* (rodízio da pré-vendas)`);
    L.push('Origem marcada: Lara IA - Whatsapp');
    L.push('');
    L.push('*O que precisa acontecer agora*');
    L.push(`A conversa está aberta no grupo "Lar Plasticos WhatsApp" da Neppo. `
           + `${(deal && deal.dono) ? deal.dono.split(' ')[0] : 'O responsável'} assume dali — o negócio já `
           + 'está no funil dele, não precisa cadastrar nada à mão.');
    if (ctx.respondidos != null && ctx.enviados) {
      const tx = ctx.enviados ? (100 * ctx.respondidos / ctx.enviados) : 0;
      L.push('');
      L.push(`_Campanha até agora: ${n(ctx.enviados)} enviadas · ${n(ctx.respondidos)} responderam `
              + `(${n(tx, 1)}%)_`);
    }
    return this.enviar(L.join('\n'));
  }

  /** Mensagem de teste — para provar o canal sem esperar um disparo real. */
  async teste() {
    return this.enviar(
      '🤖 *LARA · teste de aviso*\n\n' +
      'Este é um teste do canal. A partir de agora você recebe aqui:\n\n' +
      '• *quando a Lara manda* a apresentação para uma empresa nova\n' +
      '• *quando alguém responde* e a Lara cria o negócio no Ploomes\n\n' +
      '_Se quiser calar um dos dois, é no painel da Lara._');
  }
}

module.exports = { Avisos, fone, dataHoraSP };
