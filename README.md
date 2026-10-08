# Distributed Wagering Processor — entrega parcial

Serviço que processa transações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com precisão monetária exata, saldo que nunca fica negativo sob concorrência, e ledger auditável.

> **Leia antes de avaliar:** [`O-QUE-NAO-FIZ.md`](O-QUE-NAO-FIZ.md). Esta é uma entrega parcial consciente — a parte de SQS, o publisher do outbox, o reprocessamento de referência fora de ordem e a autenticação não foram implementados. Está tudo listado lá, com o que eu entendi do problema e como eu faria.

---

## Stack

| Item | Escolha |
|---|---|
| Runtime / gerenciador / test runner | Bun 1.x |
| Linguagem | TypeScript strict |
| Framework | NestJS 10 |
| Banco | PostgreSQL 16 |
| ORM | MikroORM 6 (`EntitySchema`, `em.transactional()`, `LockMode.PESSIMISTIC_WRITE`) |
| Migrations | MikroORM Migrator, versionada e reversível |
| Dinheiro | `decimal.js` + `numeric(20,2)` — nunca `number` |
| Validação | zod |
| Observabilidade | pino (JSON) + prom-client (`/metrics`) |
| Orquestração local | Docker Compose |

---

## Pré-requisitos

- **Bun 1.x** — `npm install -g bun`
- **Docker Desktop** rodando

```bash
bun --version
docker info
```

---

## Subir

```bash
cp .env.example .env
bun install
docker compose up -d --build
```

| Serviço | Porta | Papel |
|---|---|---|
| `postgres` | 5433 | banco |
| `migrator` | — | roda as migrations e sai |
| `api-1` | 3001 | instância da API |
| `api-2` | 3002 | segunda instância |
| `frontend` | 8080 | página de teste manual |

```bash
curl http://localhost:3001/health/ready
```

### Frontend de teste

Página HTML simples, sem estilo, para exercitar a API pelo navegador: criar carteira, ver saldo/extrato, reconciliar, enviar `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK` e consultar transações. Dá para escolher em qual instância (`api-1` ou `api-2`) cada chamada cai.

Sobe junto com o `docker compose up -d --build`. Acesse **http://localhost:8080**.

Para atualizar só o front depois de mexer em `frontend/`:

```bash
docker compose up -d --build frontend
```

Fora do Docker (com as APIs no ar em 3001/3002):

```bash
bun run frontend
```

O `frontend/server.ts` serve a página e repassa `/api1/*` e `/api2/*` para as duas instâncias, então a API não precisa de CORS. Não rode as duas formas ao mesmo tempo — ambas usam a porta 8080.

Derrubar:

```bash
docker compose down -v
```

### Desenvolvimento local

```bash
docker compose up -d postgres
bun run migration:up
bun run dev
```

A aplicação sobe em `http://localhost:3000`.

---

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | aplicação com watch |
| `bun run frontend` | frontend de teste em `http://localhost:8080` (fora do Docker) |
| `bun run test` | testes unitários (não precisa de Docker) |
| `bun run test:integration` | integração com Postgres real |
| `bun run test:concurrency` | corridas reais |
| `bun run test:all` | tudo |
| `bun run migration:up` | aplica as migrations |
| `bun run migration:down` | desfaz a última |
| `bun run infra:up` | sobe só o Postgres |
| `bun run stack:up` | sobe a stack completa |

Os testes de integração e concorrência **se pulam sozinhos** se o Postgres não estiver acessível, em vez de falhar com erro de conexão.

---

## API

Exemplos com `BASE=http://localhost:3001`.

### Criar wallet

```bash
curl -s -X POST $BASE/wallets \
  -H 'content-type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

Saldo inicial maior que zero gera uma transação interna `OPENING` com lançamento `CREDIT`, na mesma transação SQL. Segunda wallet para o mesmo `playerId` + moeda devolve **409**.

### Submeter transação

```bash
curl -s -X POST $BASE/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

O header `Idempotency-Key` é **obrigatório**. Default recomendado: `{providerId}:{externalTransactionId}`.

### Consultas

```bash
curl -s $BASE/wallets/$WALLET_ID
curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=50"
curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=50&cursor=$CURSOR"
curl -s $BASE/wagering/transactions/$TRANSACTION_ID
curl -s $BASE/providers/provider-a/wagering/transactions/transaction-123
```

### Reconciliação

```bash
curl -s -X POST $BASE/wallets/$WALLET_ID/reconciliation
```

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance":     { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42
}
```

Divergência **não é corrigida em silêncio**: fica registrada em `reconciliation_checks`, sobe a métrica `wagering_reconciliation_divergences_total`, vai para o log em nível `error`, e a resposta volta `consistent: false`.

### Health e métricas

```bash
curl -s $BASE/health/live
curl -s $BASE/health/ready
curl -s $BASE/metrics
```

---

## Códigos HTTP

| Situação | Status |
|---|---|
| Processada | `200` |
| Replay idêntico | `200` + `idempotentReplay: true` |
| Wallet criada | `201` |
| Payload inválido | `400` |
| Wallet ou transação inexistente | `404` |
| Mesma key com payload diferente | `409` + `IDEMPOTENCY_CONFLICT` |
| Wallet duplicada | `409` + `WALLET_ALREADY_EXISTS` |
| Rejeitada por regra de negócio | `422` + `failureCode` |
| Falha transitória de infra | `503` + `retriable: true` |

### Códigos de falha

| Código | Significa |
|---|---|
| `INSUFFICIENT_FUNDS` | jogador sem saldo para a aposta |
| `REVERSAL_WOULD_OVERDRAW_WALLET` | reverter deixaria a wallet negativa |
| `CURRENCY_MISMATCH` | moeda diferente da wallet |
| `WALLET_NOT_FOUND` | wallet não existe |
| `WALLET_PLAYER_MISMATCH` | a wallet não é desse jogador |
| `REFERENCE_NOT_FOUND` | a transação referenciada não existe |
| `REFERENCE_NOT_PROCESSED` | a referência não foi aplicada |
| `REFERENCE_KIND_NOT_REVERSIBLE` | esse tipo não pode ser revertido assim |
| `REFERENCE_ALREADY_REVERSED` | já foi revertida por esse tipo |
| `REFERENCE_SCOPE_MISMATCH` | referência de outro player, wallet, moeda ou rodada |
| `REVERSAL_AMOUNT_MISMATCH` | valor diferente do original |

---

## Regras implementadas

| Operação | Saldo | Ledger | Regra |
|---|---|---|---|
| `OPENING` | crédito | 1 `CREDIT` | interno, não pode ser submetido |
| `BET` | débito | 1 `DEBIT` | rejeita se não tem saldo |
| `WIN` | crédito | 1 `CREDIT` | — |
| `LOSS` | nenhum | nenhum | registra sem mover saldo |
| `REFUND` | crédito | 1 `CREDIT` | reverte uma `BET` `PROCESSED`, uma vez |
| `ROLLBACK` | inverso da referência | 1 entrada invertida | reverte `BET`, `WIN` ou `REFUND`, uma vez |

---

## Testes

```bash
bun run test              # 71 unitários, ~600ms, sem Docker
bun run test:integration  # Postgres real
bun run test:concurrency  # corridas reais
```

Invariante verificada no fim de todo teste que mexe em dinheiro:

```
wallets.balance_amount == soma assinada de wallet_ledger_entries
```

O helper é `assertWalletMatchesLedger` em `test/support/test-app.ts`.

---

## Estrutura

```
src/
├── main.ts                  bootstrap e shutdown
├── app.module.ts            injeção de dependência
├── mikro-orm.config.ts      conexão e migrations
├── migrations/              schema versionado e reversível
├── shared/
│   ├── money.ts             valor monetário exato
│   ├── errors.ts
│   ├── failure-code.ts
│   ├── payload-hash.ts      JSON canônico + SHA-256
│   ├── contracts.ts         schemas zod
│   ├── database-errors.ts   códigos do Postgres
│   ├── error.filter.ts      erro para HTTP
│   ├── logger.ts
│   └── metrics.ts
├── wallet/
│   ├── wallet.ts                 domínio
│   ├── wallet-ledger-entry.ts    domínio
│   ├── wallet.repository.ts      schema + conversão + queries
│   ├── wallet.service.ts         abrir, consultar, reconciliar
│   └── wallet.controller.ts
├── wagering/
│   ├── wager-transaction.ts            domínio
│   ├── wager-transaction.repository.ts
│   ├── wagering.service.ts             o caminho crítico
│   └── wagering.controller.ts
├── outbox/
│   ├── outbox-message.ts        envelope dos eventos
│   └── outbox.repository.ts     tabela escrita na mesma transação
└── health/

test/
├── unit/           domínio puro, sem IO
├── integration/    Postgres real
├── concurrency/    corridas reais
└── support/        harness
```

---

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| `docker info` falha | abra o Docker Desktop e espere |
| Testes de integração todos pulados | `docker compose up -d postgres` |
| `relation "wallets" does not exist` | `bun run migration:up` |
| Porta 5433 ocupada | mude `DATABASE_PORT` no `.env` e no `docker-compose.yml` |

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [`O-QUE-NAO-FIZ.md`](O-QUE-NAO-FIZ.md) | o escopo que ficou de fora e por quê |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | decisões, trade-offs e limitações |
