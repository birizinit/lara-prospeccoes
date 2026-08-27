# Lara · Prospecções

Prospecção ativa: **Apify (Google Maps)** → fila → **WhatsApp (Neppo)** em **drip** controlado.
Servidor Node local (sem dependências), pronto para migrar ao Railway.

## Como rodar
```
cd "Lara - Prospecções"
node server.js
# abre http://localhost:3100
```
Segredos ficam no **`.env`** (não commitar). Parâmetros no **`config.json`**.

## Fluxo
1. **Clique no mapa** para marcar o centro, ajuste o **raio** e digite o **nicho**.
2. **Prospectar região** → roda o Google Maps Scraper do Apify (`customGeolocation` = círculo do raio) → leads entram na **fila** (dedup por telefone/lugar).
3. O **agendador** dispara sozinho, em **drip**: até **50/dia útil**, **1000/mês**, só **seg–sex 08h–18h (SP)**, espaçado (~1 a cada N min com jitter).
4. **Mapa de calor** acende no ponto de cada lead enviado; pins mostram fila/pulados; log ao vivo.

## Segurança / boas práticas
- **Modo teste (dry-run) ligado por padrão** — nada é enviado de verdade até você desligar.
- **Enviar teste…** manda 1 WhatsApp real para um número seu (validação).
- Telefones fixos são **pulados** (WhatsApp só em celular) — configurável (`onlyMobileWhatsapp`).
- **Pausar** e **Limpar fila** a qualquer momento. Contadores persistem em `state.json`.
- Template usado: **id 97 `07_04_prospect`** (aprovado). Grupo: **ENTRADAS (35)**.

## config.json (principais)
| Campo | O quê |
|---|---|
| `apify.actorId` | `nwua9Gu5YrADL7ZDj` (Google Maps Scraper) · `maxResultsPerRun` |
| `neppo.templateId` / `groupConfId` / `userId` | template, grupo e usuário do disparo |
| `campaign.monthlyCap` / `dailyCap` | 1000 / 50 |
| `campaign.businessHourStart/End` · `timezone` | 8 / 18 · America/Sao_Paulo |
| `campaign.dryRun` / `paused` | travas de segurança |

## Migrar para Railway (depois)
- `PORT` já vem do ambiente; sem caminhos fixos.
- Colocar os segredos como **variáveis de ambiente** (não subir `.env`).
- Always-on: o drip roda 24/7 respeitando horário comercial (não depende da sua máquina ligada).
- Proteger o acesso (auth simples/basic) antes de expor publicamente.

## Endpoints
- `POST /api/prospect {niche,lat,lng,radiusKm,maxResults}` — roda Apify, enfileira leads.
- `GET /api/state` — contadores, leads (p/ mapa) e log.
- `POST /api/control {action}` — `pause|resume|dryRun|resetCounters|clearQueue|testSend`.
