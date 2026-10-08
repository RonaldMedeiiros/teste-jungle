# O que não fiz, e por quê

Este documento existe porque eu prefiro ser claro sobre o tamanho da entrega do que deixar vocês descobrirem.

**Resumo honesto:** eu desconhecia boa parte dos assuntos deste desafio antes de começar. Estudei, pesquisei e usei IA para entender os conceitos. Entreguei a metade que eu consigo explicar e defender, e deixei de fora a metade que eu não conseguiria. Achei que entregar menos sabendo o que fiz valia mais que entregar tudo sem saber.

---

## Não implementei

### 1. Toda a parte de SQS

Não existe produtor, consumidor, DLQ, inbox nem publisher de outbox. O `docker-compose.yml` não sobe LocalStack.

**Por quê:** foi o assunto mais distante do que eu já tinha visto. Entendi o problema que o padrão resolve — e descrevo abaixo — mas implementar consumidor com visibility timeout, classificação de erro em três destinos, backoff por `ChangeMessageVisibility` e shutdown gracioso sem entender bem cada peça ia gerar código que eu não saberia defender.

**O que eu entendi do problema:** o SQS entrega *at-least-once*. A mensagem fica invisível por um tempo depois de entregue, e se eu não deletar ela volta. Então deletar é dar ack, e o ack precisa vir **depois** do commit — se eu deletasse antes e o commit falhasse, a mensagem estaria perdida. Para não processar a mesma mensagem duas vezes eu precisaria de uma tabela de inbox com chave `(consumer_name, message_id)`, participando da mesma transação financeira.

**Como eu faria:** uma tabela `inbox_messages` com essa chave primária, usando `INSERT ... ON CONFLICT DO NOTHING` (e não try/catch, porque violação de constraint aborta a transação inteira no Postgres), dentro da mesma transação que move o dinheiro. O consumidor reutilizaria o `WageringService.submit`, que já é o único caminho de escrita.

### 2. O publisher do outbox

A tabela `outbox_messages` **existe** e é escrita na mesma transação do dinheiro. O que não existe é o worker que lê e publica.

**Por quê:** a parte que eu entendi e consegui fazer é a que importa para a correção: o evento nunca é escrito antes do commit. O worker é a parte de infraestrutura.

**O que eu entendi:** não existe transação entre Postgres e SQS. Se eu publicar antes do commit, posso ter evento de uma aposta que não aconteceu. Se eu comitar e morrer antes de publicar, perco o evento. Nenhuma ordem resolve — por isso o evento vira dado, gravado na mesma transação.

**Como eu faria:** um worker lendo com `SELECT ... FOR UPDATE SKIP LOCKED`, que é o que permite vários publishers pegarem lotes diferentes sem combinarem nada. Publicaria com o lock da linha na mão e marcaria `published_at` na mesma transação. Isso seria at-least-once: se o SQS confirmasse e o commit falhasse, o evento sairia de novo — e eu protegeria com `MessageDeduplicationId = eventId`.

Dá para ver no teste `os eventos ficam pendentes porque nao existe publisher neste projeto` que eu sei que eles ficam lá.

### 3. `PENDING_REFERENCE` e reprocessamento de referência fora de ordem

O enunciado pede que um `REFUND` ou `ROLLBACK` que chega **antes** da transação que reverte seja guardado como `PENDING_REFERENCE` e reprocessado por um worker com backoff exponencial e limite de tentativas.

**O que eu fiz em vez disso:** rejeito com `REFERENCE_NOT_FOUND`.

**Por quê:** implementar isso exigia o worker agendado, o cálculo de backoff, o controle de tentativas e o TTL. Preferi deixar explícito que não atende o requisito 7.1 a entregar uma versão pela metade.

**Isso é uma lacuna real**, não uma simplificação defensável: num sistema de verdade, uma reordenação de fila faria o reembolso ser rejeitado injustamente. O provedor teria que reenviar.

**Como eu faria:** as colunas `reference_attempts` e `next_reference_attempt_at` na tabela, o status `PENDING_REFERENCE`, e um worker que relê as vencidas e chama o mesmo service. O backoff começaria em 2s dobrando até um teto, com limite de tentativas; esgotado, viraria `REJECTED` com um código específico.

### 4. Autenticação

Não tem nenhuma. Não existe guard, não existe IdP.

**Por quê:** o enunciado diz que vale 0 ponto e que posso documentar a decisão. Foi a primeira coisa que cortei.

**Como eu faria:** Keycloak no Compose, um client confidencial por provedor, client credentials, e validação de JWT via JWKS. A mudança que de fato vale é que o `providerId` passaria a vir **do token** e não do body — hoje um provedor poderia enviar o `providerId` de outro.

### 5. Teste com três instâncias

O `docker-compose.yml` sobe duas instâncias da API, mas eu não escrevi o teste que ataca várias de uma vez.

**Por quê:** não cheguei a estudar como orquestrar isso num teste.

**O que eu sei dizer:** a correção não depende do número de instâncias, porque a garantia não está em memória — está no banco. É o `SELECT ... FOR UPDATE` na linha da wallet mais o `CHECK (balance_amount >= 0)`. Os meus testes de concorrência rodam numa instância, e isso é uma cobertura menor do que o enunciado pede.

### 6. Hierarquia de classes de evento

O enunciado pede `IntegrationEvent` abstrata com uma subclasse concreta por evento. Eu fiz funções que montam o envelope (`transactionProcessed`, `transactionRejected`, `walletBalanceChanged`).

**Por quê:** o envelope sai igual — `eventId`, `eventType`, `version`, `correlationId`, `occurredAt`, `data` com `MoneyProps` em string. A diferença é só a forma. Funções eu consigo explicar; uma hierarquia de classes abstratas genéricas eu ia só copiar.

### 7. Status `FAILED`

Meu enum tem três estados: `PENDING`, `PROCESSED`, `REJECTED`. O enunciado tem cinco.

**Por quê:** `FAILED` é para erro permanente de infraestrutura, e sem a parte de mensageria nada no meu código chegaria nesse estado. Preferi não deixar um valor de enum que nunca acontece.

### 8. Teste de carga

Não fiz. É diferencial opcional, e eu não conseguiria montar um experimento honesto — registrar ambiente, metodologia, p50/p95/p99 e analisar. Um número solto sem metodologia não diz nada.

### 9. Double-entry bookkeeping

Meu ledger é de partida simples: um lançamento por movimento. O enunciado marca double-entry como diferencial opcional.

---

## O que eu fiz e consigo defender

| Área | O que está feito |
|---|---|
| Dinheiro | `Money` imutável com `decimal.js`, `numeric(20,2)` no banco, nunca `number` |
| Wallet | construtor privado, factories, saldo nunca negativo, versão que só sobe quando o saldo muda |
| Ledger | append-only por trigger no Postgres, cada lançamento se auto-verifica |
| Concorrência | `SELECT ... FOR UPDATE` por wallet, `lock_timeout`, retry com backoff e jitter |
| Idempotência | `UNIQUE (idempotency_key)` no banco, `payloadHash` de JSON canônico, replay com saldo histórico |
| Regras | BET, WIN, LOSS, REFUND, ROLLBACK, com reversão única por tipo garantida por índice parcial |
| Atomicidade | transação, saldo, ledger e outbox numa transação SQL, com teste que força falha no outbox |
| Schema | todas as constraints no banco, migration versionada e reversível |
| Reconciliação | compara saldo com ledger e **não corrige em silêncio** |
| Testes | 71 unitários, integração e concorrência contra Postgres real, zero mock de banco |

---

## Minha avaliação do que eu entreguei

Olhando a tabela de pontuação do enunciado, meu palpite honesto:

| Área | Pontos | Meu palpite |
|---|---|---|
| Correção financeira | 20 | fiz quase tudo |
| Concorrência | 20 | fiz o núcleo, falta o teste multi-instância |
| Idempotência | 15 | fiz a parte de HTTP, falta a inbox |
| Mensageria e falhas | 15 | praticamente nada |
| Modelagem e arquitetura | 10 | fiz |
| Testes | 10 | fiz para o que existe |
| Observabilidade | 5 | logs em JSON, 6 métricas, health separado |
| Documentação | 5 | este arquivo é parte dela |

Algo em torno de metade. E eu prefiro conversar sobre essa metade do que ter entregado o dobro e não conseguir responder.
