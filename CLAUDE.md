# CLAUDE.md — Lara · Prospecções (app-scoped)

> Contexto focado desta aplicação. O mapa-mestre do workspace está em `../CLAUDE.md`;
> integrações e segredos em `../sistemas-utilizados/`. **Última atualização:** 11/07/2026.

## O que é
Prospecção ativa **automatizada**: descobre empresas no **Google Maps (via Apify)** por
**nicho + cidade(s)** e dispara **WhatsApp (via Neppo)** em **drip controlado**, com **mapa de
calor** que acende a cada envio. Diferente dos outros apps do workspace, **não é HTML estático**
— é um **servidor Node local** (proxy) porque usa chaves secretas e OAuth ao vivo.

## Arquitetura
```
[navegador: mapa Leaflet + heatmap]  <->  [server.js (Node, sem deps)]  <->  Apify / Neppo / Nominatim
                                             |
                                     state.json + leads.json (persistência)
```
- **Sem dependências npm** (só built-ins: http, https, fs). Padrão do `../../neppo rafael/painel-neppo`.
- **Local-first, Railway-ready:** `PORT` vem do ambiente; sem caminhos fixos; segredos por env.

## Mapa de arquivos
| Arquivo | Papel |
|---|---|
| `server.js` | Proxy Apify+Neppo+Nominatim, agendador de drip, estado, API, serve `public/` |
| `config.json` | Parâmetros (actor, template, grupo, caps da campanha) — **sem segredos** |
| `.env` | **Segredos** (`APIFY_TOKEN`, `NEPPO_*`) — local, gitignored. Ver `../CLAUDE.md §4` |
| `public/index.html` · `app.js` · `styles.css` | Front-end (mapa, busca de cidade, chips, painel, heatmap) |
| `state.json` · `leads.json` | Runtime (contadores + fila). Gerados ao rodar; gitignored |
| `README.md` | Guia de uso rápido |

## Fluxo de dados
1. **Cidade:** usuário digita → `GET /api/cities?q=` → **Nominatim/OSM** (proxy, `countrycodes=br`)
   → sugestões → **multi-seleção** (chips). Cada cidade tem `{name, state, display, lat, lng}`.
2. **Prospecção:** `POST /api/prospect {niche, cities[], maxResults}` → para cada cidade inicia um
   run do **Apify Google Maps Scraper** com `locationQuery = "Cidade, Estado, Brasil"` (em
   **paralelo**), espera todos, agrega os lugares → **fila** (`addLeads`, dedup por telefone/lugar).
3. **Classificação:** telefone normalizado (BR, E.164). **Celular** (9 dígitos após DDD) → `queued`;
   **fixo** ou sem telefone → `skipped` (fixo não tem WhatsApp).
4. **Drip (agendador, tick 20s):** durante **horário comercial** dispara o próximo `queued` via
   Neppo, respeitando caps e ritmo. `sent` acende **calor** no mapa; `dry-run` simula sem enviar.
5. **Estado:** `GET /api/state` devolve contadores, leads (p/ mapa) e log; o front faz poll a cada 5s.

## Integrações (valores reais)
- **Apify actor:** `nwua9Gu5YrADL7ZDj` (Google Maps Scraper / compass). Input: `searchStringsArray`,
  `locationQuery` (ou `customGeolocation` como fallback), `maxCrawledPlacesPerSearch`, `countryCode:"br"`.
  ⚠️ **`language:"pt"` é rejeitado** pelo actor — deixamos `language:null` (omitido).
  Run: `POST /v2/acts/{actor}/runs` → poll `/v2/actor-runs/{id}` → `/v2/datasets/{dsId}/items`.
- **Neppo (WhatsApp):** `POST /chatapi/1.0/api/direct-message/save` (OAuth password, token 1h cacheado).
  Template **id 97 `07_04_prospect`** (prospecção "peguei seu contato no Google", 0 params, aprovado).
  Grupo **ENTRADAS** (`groupName:"ENTRADAS"`, `groupConfId:35`), `userId:106`, `senderUserId:null`,
  `status:"PROCESSANDO"`. `additionalInfo` = `{namespace,elementName,parameters:{},medias:{},openSession:false}`
  (o servidor resolve `namespace`/`elementName` do template 97 na Neppo e cacheia).
- **Nominatim/OSM:** `GET nominatim.openstreetmap.org/search` com `User-Agent` próprio (política do serviço).

## config.json — campos
| Campo | O quê |
|---|---|
| `apify.actorId` / `maxResultsPerRun` / `language`(null) / `countryCode`("br") | Actor e limites |
| `neppo.templateId`(97) / `groupName` / `groupConfId`(35) / `userId`(106) / `senderUserId` | Disparo |
| `campaign.monthlyCap`(1000) / `dailyCap`(50) / `businessDaysPerMonth`(20) | Cotas |
| `campaign.businessHourStart`(8) / `businessHourEnd`(18) / `timezone`("America/Sao_Paulo") | Janela |
| `campaign.jitterPct`(0.35) | Variação no espaçamento |
| `campaign.onlyMobileWhatsapp`(true) | Pular fixos |
| `campaign.dryRun`(true) / `paused`(false) | **Travas de segurança** (persistem em state.json) |

## Cadência / drip (lógica no server.js)
- **1000/mês, 50/dia útil**, só **seg–sex 08–18h (SP)**. Contadores resetam no virar do dia/mês (fuso SP).
- **Espaçamento:** `gap = (minutos restantes na janela) / (envios restantes no dia) × jitter` →
  espalha os 50 ao longo do dia (~1 a cada ~10 min). Envia 1 por tick só se passou o `gap`.
- **dry-run** conta nos contadores (para simular o ritmo). Ao ir pra valer: **zerar contadores**.

## Endpoints
| Método | Rota | O quê |
|---|---|---|
| GET | `/api/cities?q=` | Sugestões de cidade (Nominatim) |
| POST | `/api/prospect` | `{niche, cities[], maxResults}` → roda Apify, enfileira |
| GET | `/api/state` | Contadores + leads (mapa) + log |
| POST | `/api/control` | `pause \| resume \| dryRun \| resetCounters \| clearQueue \| testSend{phone}` |

## Como rodar
```
node server.js        # → http://localhost:3100  (dry-run ON por padrão)
```
Reiniciar após editar `server.js`/`config.json`: **mate o node antes** (`taskkill /F /IM node.exe`
no Windows) senão dá `EADDRINUSE` na porta 3100 e a instância antiga continua ativa.

## Gotchas (aprendidos na marra)
- **`language:"pt"` quebra o Apify** → omitir (`null`).
- **~¾ dos telefones do Google Maps são FIXOS** (sem WhatsApp) → rendimento de celular ~¼.
- **EADDRINUSE:** sempre encerre o node antigo antes de subir de novo.
- **TLS Neppo:** validação estrita pode falhar → `NEPPO_STRICT_TLS=0` (como o `curl -k` oficial).
- **`groupConfId`:** assumido = id do grupo (35). Confirmar no 1º envio real.
- **Compliance:** disparo cold de WhatsApp é sensível à política Meta; o drip lento + template
  aprovado mitigam, mas **volume baixo e gradual** é a regra.

## Roadmap
- **Validar 1º envio real** (botão "Enviar teste" p/ número próprio) → confirmar template/grupo.
- **Deploy Railway** (always-on: drip roda 24/7 respeitando horário; proteger acesso).
- **E-mail (v2)** via Flowbiz/MailClick (raspar site do lead p/ e-mail).
- **Dedup contra clientes existentes** (Ploomes/base 30+) p/ não prospectar quem já é cliente.
- **Personalização** do template (parâmetros) e filtro por UF nas sugestões.

## Histórico do app
- **11/07/2026 — v1:** app criado (server + front + drip), pipeline testado ponta a ponta
  (São Paulo → leads, celular vs fixo). Escopo: só WhatsApp, drip automático, local→Railway.
- **11/07/2026 — v1.1:** seleção de região trocada de "desenhar no mapa + raio" para
  **busca de cidade com sugestões + multi-seleção** (Nominatim + Apify `locationQuery` em paralelo).
