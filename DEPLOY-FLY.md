# Deploy da Lara no Fly.io (região gru/SP)

**Por que Fly e não Railway:** o Neppo (WhatsApp) **bloqueia IP fora do Brasil**. O disparo
só funciona de um host BR → região **`gru` (São Paulo)**. Já está cravado no `fly.toml`.

**Por que GitHub CI:** o build/deploy da imagem **não roda do sandbox do Claude** (a rede não
alcança os builders do Fly). O `.github/workflows/fly.yml` builda no runner do GitHub e faz o
deploy. Depois disso, todo `git push` na `main` = deploy automático.

---

## Passo a passo (você roda, uma vez)

Pré-requisito: `flyctl auth login` (na sua máquina, já autenticado no Fly).

### 1) Criar o app + o volume (na pasta `Lara - Prospecções/`)

```bash
flyctl apps create lara-prospeccoes          # se já existir, ignore o erro
flyctl volumes create lara_data --region gru --size 1 -a lara-prospeccoes -y
```

### 2) Setar os segredos (Apify + Neppo) — lê do seu `.env` local

```bash
flyctl secrets set -a lara-prospeccoes \
  $(grep -vE '^\s*#|^\s*$' .env | grep -E 'APIFY_TOKEN=|NEPPO_USERNAME=|NEPPO_PASSWORD=|NEPPO_CUSTOMER_KEY=|NEPPO_CUSTOMER_SECRET=' | tr '\n' ' ')
```

(`NEPPO_STRICT_TLS=0` e `DATA_DIR=/data` já vêm do `fly.toml` — não precisa como segredo.)

### 3) Token de deploy p/ o GitHub CI

```bash
flyctl tokens create deploy -a lara-prospeccoes
```

Copie o token que ele imprime.

### 4) GitHub

1. Crie o repo (ex.: `birizinit/lara-prospeccoes`), **privado**.
2. Em **Settings → Secrets and variables → Actions → New repository secret**:
   - Nome: `FLY_API_TOKEN` · Valor: o token do passo 3.
3. Suba o código (já está commitado na `main`):
   ```bash
   git remote add origin https://github.com/birizinit/lara-prospeccoes.git
   git push -u origin main
   ```
4. O push dispara o **Actions → Deploy Lara → Fly**. Acompanhe em Actions; ao terminar,
   `https://lara-prospeccoes.fly.dev` está no ar.

> Alternativa ao passo 4 (deploy imediato, sem GitHub): na sua máquina, na pasta,
> `flyctl deploy` — a sua rede alcança os builders. O GitHub CI serve pros deploys seguintes.

---

## Depois de no ar

- **Sobe em `dryRun: true`** (config.json) — nada é enviado até você desligar o dry-run no painel.
- Grupo de envio = **"Lar Plasticos WhatsApp" (groupConfId 1)** — o que ENTREGA (o ENTRADAS 35 trava).
- Template **110** (`fixo_lara`, com imagem no header).
- Cadência: **1000/mês · 50/dia útil · seg–sex 9–17h SP**.
- Estado (`state.json`/`leads.json`) persiste no **Volume `/data`** (sobrevive a redeploy).
- Antes de soltar de verdade: use o botão **"Enviar teste"** do painel com seu número.

## Operar/depurar daqui (o Claude consegue, com um token)

`api.fly.io` é alcançável do sandbox → com um deploy/org token dá pra rodar
`flyctl status/logs/secrets/scale -a lara-prospeccoes`. Só o `flyctl deploy` (build) é que
precisa do GitHub/sua máquina.
