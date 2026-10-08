# Ponte Neppo (ex-Lara · Prospecções)

**Desde 07/10/2026 a Lara do Google Maps mora no portal Lara** (`../Lara LinkedIn`, Railway):
captura no Google Maps, fila, ritmo, freios, CRM e indicadores ficam lá, nas telas
"WhatsApp · Google Maps".

Este app no Fly (região **gru**, São Paulo) virou só a **ponte com a Neppo**, porque a Neppo
**só responde a IP do Brasil** e o Railway não tem região no Brasil.

## Rotas (header `x-cockpit-key` = `COCKPIT_KEY`, menos `/health`)
| Método | Rota | O quê |
|---|---|---|
| GET | `/health` | Está de pé? Tem credencial da Neppo e chave? |
| GET | `/templates` | Templates HSM da Neppo (paginado — a API corta em 50) |
| POST | `/enviar` | `{telefone, templateId, imagem?, grupoNome?, grupoConfId?}` → `{ok, id}` |
| POST | `/status` | `{ids:[...]}` → estado de cada envio (chegou/leu/erro, `sessionId` = respondeu) |
| POST | `/mensagens` | `{sessionId}` → o que o prospect escreveu |
| GET | `/legado` | A fila e o histórico da Lara antiga (volume `/data`), só leitura |

## Segredos (no Fly)
`NEPPO_USERNAME` · `NEPPO_PASSWORD` · `NEPPO_CUSTOMER_KEY` · `NEPPO_CUSTOMER_SECRET` · `COCKPIT_KEY`.

## Deploy
Push na `main` → GitHub Actions → `flyctl deploy --local-only` (o sandbox do Claude não alcança
os builders do Fly). Teste: `node _teste_ponte.js` (Neppo falsa, 18 checagens).

O app antigo (painel, drip, Apify) está em `legado/`, só para consulta — não roda.
