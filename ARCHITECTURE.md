# Arquitetura, decisões e trade-offs

O escopo que ficou de fora está em [`O-QUE-NAO-FIZ.md`](O-QUE-NAO-FIZ.md). Aqui estão as decisões do que eu **fiz**.

---

## 1. Visão geral

```
      provedor
         │ HTTP
         ▼
   WageringController
         │
         ▼
   WageringService.submit
         │
         ├── replay rápido (sem lock)
         │
         ▼
  ╔═══ UMA TRANSAÇÃO SQL ══════════════════════╗
  ║ SET LOCAL lock_timeout                     ║
  ║ SELECT wallet FOR UPDATE          ◀── lock ║
  ║ SELECT por idempotency key                 ║
  ║ decide (regras de negócio)                 ║
  ║ INSERT wager_transactions                  ║
  ║ UPDATE wallets          (saldo)            ║
  ║ INSERT wallet_ledger_entries               ║
  ║ INSERT outbox_messages  (evento)           ║
  ╚═══ COMMIT ═════════════════════════════════╝
```

A regra que organiza tudo: **transação, saldo, ledger e evento entram na mesma transação SQL.** Nenhum evento é escrito antes do commit.

---

## 2. Estrutura de pastas

Uma pasta por contexto, arquivos lado a lado:

```
src/wallet/     wallet.ts  wallet-ledger-entry.ts  wallet.repository.ts  wallet.service.ts  wallet.controller.ts
src/wagering/   wager-transaction.ts  wager-transaction.repository.ts  wagering.service.ts  wagering.controller.ts
src/outbox/     outbox-message.ts  outbox.repository.ts
src/shared/     money.ts  errors.ts  failure-code.ts  payload-hash.ts  contracts.ts  ...
```

Não separei em `domain/`, `application/` e `infra/`. A separação que de fato importa está respeitada mesmo assim: os arquivos de domínio (`money.ts`, `wallet.ts`, `wallet-ledger-entry.ts`, `wager-transaction.ts`) **não importam nada de NestJS nem de MikroORM**. Dá para testá-los sem subir nada, e é o que `test/unit` faz.

**Trade-off:** uma estrutura em camadas deixaria essa fronteira visível pelo caminho do arquivo. Eu preferi menos pastas e uma regra que eu consigo enunciar: domínio não importa framework. Se o projeto crescesse, separar é mecânico.

### Entidades de persistência dentro do repositório

Cada repositório tem, no mesmo arquivo: o `EntitySchema` do MikroORM, a classe de entidade, a função que converte para domínio, e as queries.

```ts
export const walletSchema = new EntitySchema<WalletEntity>({ ... });

function toWallet(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({ ... });
}

export class WalletRepository { ... }
```

A conversão passa pela factory `rehydrate`, que é o que o enunciado pede: reidratar **não revalida** regras de transição, só reconstrói estado já persistido. Se amanhã a regra de negócio mudasse, wallets antigas continuariam carregando.

Usei `EntitySchema` em vez de decorators porque a entidade fica um objeto de dados simples, sem metadata mágica, e porque é uma peça móvel a menos no Bun.

**Trade-off:** mapper e migration são escritos à mão e podem divergir do schema. Mitigo com `test/integration/constraints.test.ts`, que lê o `information_schema` e exercita cada constraint com SQL cru.

### Transação direto no `EntityManager`

```ts
private async inTransaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
  const em = this.orm.em.fork() as EntityManager;
  return em.transactional(async (transactional) => work(transactional as EntityManager));
}
```

O `em` viaja como argumento para os repositórios. Fica visível no código que as quatro escritas estão na mesma transação — que é justamente o ponto onde eu mais quero que isso seja óbvio.

---

## 3. Dinheiro

`Money` guarda um `Decimal` de `decimal.js` e uma moeda ISO-4217. Imutável: toda operação devolve nova instância. Construtor privado.

Entrada e saída são **string decimal com escala fixa 2**. A regex rejeita vazio, `NaN`, `Infinity`, notação científica, vírgula, negativo e mais de duas casas.

Dois factories:

```ts
Money.from({ amount: '25.00', currency: 'BRL' })      // contratos de entrada, não aceita negativo
Money.fromSigned({ amount: '-25.00', currency: 'BRL' }) // interno: negate e soma do ledger
```

O segundo existe porque `subtract` precisa poder atravessar o zero — é assim que o saldo negativo é **detectado** em vez de truncado silenciosamente.

No banco: `numeric(20,2)` para o valor e `char(3)` para a moeda. O driver `pg` devolve `numeric` como string, que entra direto no `Money.from()`. **Nenhum ponto flutuante no caminho.**

O serializador canônico **lança exceção se encontrar um `number`**. É uma barreira: se alguém tentar serializar dinheiro como número, o teste quebra em vez de o erro aparecer em produção.

---

## 4. Concorrência

**Unidade de concorrência: `walletId`.**

```ts
await this.wallets.setLockTimeout(em, LOCK_TIMEOUT_MS);
const wallet = await this.wallets.lockById(em, command.walletId);  // SELECT ... FOR UPDATE
```

### Por que lock pessimista

Hot wallet é o caso comum em iGaming: uma mesa movimentada tem muitas operações na mesma wallet. Com lock otimista, cada colisão vira retry — trabalho jogado fora exatamente quando o sistema está sob pressão. Com `FOR UPDATE`, a segunda transação espera alguns milissegundos e lê o saldo **já atualizado**, acertando na primeira passada.

**Não é lock global**, que o enunciado proíbe: é `FOR UPDATE` numa linha identificada por id. Wallets diferentes nunca se esperam — tem teste com vinte wallets em paralelo.

### `lock_timeout`

```sql
SET LOCAL lock_timeout = '5000ms'
```

`SET LOCAL` vale só até o fim da transação, então não vaza para a próxima conexão do pool. Sem timeout, uma transação travada prenderia aquela wallet para sempre. Com ele, o Postgres devolve erro `55P03` e isso vira `TransientFailureError` → `503` com `retriable: true`.

### `version`

Começa em 1 e incrementa **somente quando o saldo muda**. Abrir wallet com saldo inicial mantém a versão 1 — por isso `Wallet.open()` já nasce com o saldo e `openingLedgerEntry()` produz o lançamento sem mexer na versão.

A versão não é a trava; o `FOR UPDATE` é. Ela serve para auditoria e para aparecer no evento `WalletBalanceChanged`.

### Retry

Até 4 tentativas, com backoff exponencial e jitter, quando o erro é conflito de lock (`55P03`, `40001`, `40P01`) ou violação de um dos índices únicos.

Os dois últimos são o detalhe interessante: **a violação de constraint é transformada no caminho certo.** Se duas requisições criam a mesma `idempotency_key` ao mesmo tempo, a que perde refaz a transação inteira, e na segunda passada encontra a linha comitada e devolve replay. O jitter é essencial: sem ele, duas transações que colidiram esperariam o mesmo tempo e colidiriam de novo.

### Três camadas de defesa

| Camada | Garante |
|---|---|
| Domínio (`Wallet.applyMovement`) | lança se o movimento deixaria saldo negativo |
| Transação (`SELECT ... FOR UPDATE`) | serializa operações na mesma wallet |
| Schema (`CHECK (balance_amount >= 0)`) | o banco recusa saldo negativo, venha de onde vier |

A terceira é a que importa: mesmo com bug na aplicação, o Postgres não aceita. Tem teste que faz `UPDATE` direto e leva erro.

---

## 5. Idempotência

**Fonte da verdade: o header `Idempotency-Key`,** materializado em `UNIQUE (idempotency_key)`. Nada em memória — reiniciar não perde nada, e duas instâncias compartilham a garantia porque ela vive no banco.

### `payloadHash`

SHA-256 do JSON canônico de nove campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`.

Canônico = chaves ordenadas recursivamente, `undefined` descartado, `null` preservado, `number` proibido. O `money.amount` é **normalizado para escala 2 antes do hash**, então `"25"`, `"25.0"` e `"25.00"` dão o mesmo hash — mudar só a formatação é replay, não conflito.

Fora do hash: o header e qualquer metadado de transporte.

### As três respostas

| Situação | Resposta |
|---|---|
| Key nova | processa |
| Key conhecida, mesmo hash | **replay** com o saldo observado naquele momento, `idempotentReplay: true` |
| Key conhecida, hash diferente | **409 `IDEMPOTENCY_CONFLICT`**. Nunca replay |

O "saldo observado naquele momento" é a coluna `observed_balance_amount`, gravada na decisão. Sem ela, o replay devolveria o saldo de agora — que pode ter mudado por outras apostas. O teste aposta mais 10,00 entre a primeira chamada e o replay justamente para fixar isso.

### Verificação duas vezes

Antes do lock tem um caminho rápido de leitura, que responde direto se a key já existe com o mesmo hash. É **otimização**: sem ele, 50 replays simultâneos ficariam em fila no lock de uma linha. A checagem **autoritativa** acontece de novo depois do lock.

A ordem importa: lock **antes** da verificação autoritativa. Ao contrário, duas requisições poderiam concluir "não existe" ao mesmo tempo.

---

## 6. Outbox

O evento é gravado na mesma transação do dinheiro, na tabela `outbox_messages`. Com isso só existem dois estados: ou tudo comitou, ou nada aconteceu. Evento de uma aposta que não aconteceu: impossível. Evento perdido de uma aposta que aconteceu: impossível.

**Não existe publisher neste projeto** — ver [`O-QUE-NAO-FIZ.md`](O-QUE-NAO-FIZ.md), item 2. Os eventos ficam com `published_at NULL`, e tem um teste que confirma isso explicitamente.

Eventos escritos: `WagerTransactionProcessed` (qualquer transação aplicada, inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (somente quando o saldo muda).

O `data` carrega `MoneyProps` (string decimal), nunca a instância de `Money` — payload estável e versionável.

---

## 7. Garantias no schema

O enunciado pede unicidade, imutabilidade e não-negatividade **no banco**. O que está em `src/migrations/`:

| Garantia | Mecanismo |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance_amount >= 0)` |
| Versão nunca abaixo de 1 | `CHECK (version >= 1)` |
| Moeda com formato ISO | `CHECK (currency ~ '^[A-Z]{3}$')` |
| Idempotency key única | `UNIQUE (idempotency_key)` |
| Par provedor + id externo único | `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única por tipo | `UNIQUE (provider_id, reference_external_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Reversão exige referência | `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_... IS NOT NULL)` |
| Nada referencia a si mesmo | `CHECK (reference_... <> external_transaction_id)` |
| `failureCode` coerente com status | `CHECK ((status = 'REJECTED') = (failure_code IS NOT NULL))` |
| Terminal tem `processed_at` | `CHECK (status = 'PENDING' OR processed_at IS NOT NULL)` |
| Um lançamento por transação e wallet | `UNIQUE (wallet_id, transaction_id)` |
| Lançamento fecha a conta | `CHECK (balance_after = balance_before + (CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END))` |
| Lançamento com valor positivo | `CHECK (amount > 0)` |
| Ledger append-only | triggers `BEFORE UPDATE`, `BEFORE DELETE` e `BEFORE TRUNCATE` que levantam exceção |

Duas peças merecem nota.

**O índice único parcial de reversão** filtra por `status = 'PROCESSED'`, então uma reversão **rejeitada não consome a vaga** — o provedor pode corrigir e reenviar. E `kind` está no índice, então `REFUND` e `ROLLBACK` da mesma `BET` convivem, que é o que o enunciado pede ao dizer "duas vezes **pelo mesmo tipo**".

**As triggers de imutabilidade** são a prova mais forte do ledger auditável: nem a aplicação, nem um `psql` aberto por engano, nem um `TRUNCATE` apagam histórico. O custo é que limpar o banco em teste exigiria desabilitar a trigger — aceitei isso para proteger a produção.

A migration foi escrita à mão porque gerador não produz índice único parcial nem trigger de plpgsql, e essas são justamente as partes avaliadas. O `down()` existe e desfaz na ordem inversa, respeitando as FKs.

---

## 8. Regras de reversão

| Operação | Pode referenciar | Direção |
|---|---|---|
| `REFUND` | só `BET` | `CREDIT` |
| `ROLLBACK` | `BET`, `WIN`, `REFUND` | inverso da referência |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa casar player, wallet, moeda e rodada. Valor tem que ser igual (reversão parcial está fora de escopo no enunciado).

### Interpretações que adotei

1. **Rollback de `LOSS` é rejeitado** com `REFERENCE_KIND_NOT_REVERSIBLE`, não tratado como no-op. O enunciado lista as referências válidas e `LOSS` não está lá; se um provedor manda isso, ele tem um bug, e um no-op silencioso esconderia.
2. **Referência em estado não-`PROCESSED` → `REFERENCE_NOT_PROCESSED`.** Reverter algo que nunca foi aplicado não faz sentido.
3. **`REFERENCE_NOT_FOUND` em vez de `PENDING_REFERENCE`.** Esta é a lacuna conhecida, documentada no `O-QUE-NAO-FIZ.md` item 3.
4. **`WALLET_NOT_FOUND` não persiste transação,** porque `wager_transactions.wallet_id` tem FK para `wallets` e gravar seria impossível. É a única rejeição sem registro.
5. **`OPENING` é barrado no contrato zod**, não no domínio: o enum de entrada só aceita os cinco tipos submetíveis, então morre com `400` antes de chegar ao service.
6. **`INSUFFICIENT_FUNDS` e `REVERSAL_WOULD_OVERDRAW_WALLET` são códigos distintos**, como o enunciado pede — "jogador sem saldo" e "não consigo desfazer isso" são problemas operacionais diferentes.

---

## 9. Observabilidade

**Logs** em JSON (pino) com `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`. Uma lista de chaves é escondida automaticamente (`password`, `token`, `authorization`, `payload`, `body`), então payload financeiro completo não vai para o log.

**Não implementei propagação de `correlationId` por `AsyncLocalStorage`.** Hoje o `correlationId` nos eventos é o próprio id da transação. É uma simplificação: num sistema real eu aceitaria um header `x-correlation-id` e o propagaria por todo o fluxo.

**Métricas** em `/metrics`:

| Métrica | Para quê |
|---|---|
| `wagering_transactions_total{kind,status,failureCode}` | transações por status |
| `wagering_idempotent_replays_total` | duplicatas detectadas |
| `wagering_idempotency_conflicts_total` | provedor com bug |
| `wagering_lock_retries_total` | contenção em hot wallet |
| `wagering_reconciliation_divergences_total` | o alarme que ninguém quer ver tocar |
| `wagering_processing_duration_seconds` | latência p50/p95/p99 |

**Health separado**: `/health/live` só diz que o processo está vivo, para o liveness probe não matar um pod por causa do banco. `/health/ready` checa o Postgres e devolve `503` se estiver fora, tirando a instância do balanceador sem derrubá-la.

---

## 10. Limitações conhecidas

Além do que está em [`O-QUE-NAO-FIZ.md`](O-QUE-NAO-FIZ.md):

1. **Reversão parcial não existe.** O enunciado tira do escopo, mas num sistema real é requisito.
2. **Ledger de partida simples**, não double-entry.
3. **`WALLET_NOT_FOUND` não deixa rastro** em `wager_transactions`, por causa da FK. Uma tabela separada sem FK resolveria.
4. **Sem propagação de `correlationId`** (seção 9).
5. **Sem teste multi-instância.** A correção não depende do número de instâncias porque a garantia está no banco, mas eu não comprovei com teste.
6. **Pool de conexões fixo.** Com `FOR UPDATE` e muitas instâncias, o pool pode virar gargalo antes do lock. Mediria antes de mexer.
7. **`forceUtcTimezone` ligado, mas sem teste de fuso.**

---

## 11. Falhas eliminatórias

| Falha | Onde está a prova |
|---|---|
| `number` para dinheiro | `decimal.js` + `numeric(20,2)`; o JSON canônico lança em `number`; teste varre o `information_schema` |
| Saldo negativo por race | `FOR UPDATE` + `CHECK`; teste `duas apostas de 80.00 ao mesmo tempo contra 100.00 de saldo` |
| Débito ou crédito duplicado | `UNIQUE (idempotency_key)` + `UNIQUE (wallet_id, transaction_id)`; teste `a mesma aposta enviada 50 vezes em paralelo` |
| Idempotência em memória | nenhum cache; tudo em `wager_transactions` |
| Correto só com uma instância | garantia no banco, não em memória — mas **sem teste multi-instância** (limitação 5) |
| Evento publicado antes do commit | `outbox.addAll` recebe o `em` da transação; teste `uma falha ao escrever o outbox desfaz o dinheiro tambem` |
| Ausência de ledger auditável | `wallet_ledger_entries` append-only por trigger; teste `lancamentos do ledger nunca podem ser alterados, apagados ou truncados` |
| Testes que trocam Postgres por mock | zero mock de banco; o que não alcança o Postgres se pula explicitamente |
