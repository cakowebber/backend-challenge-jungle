# Arquitetura — Distributed Wagering Processor

Cada decisão relevante foi registrada aqui no mesmo passo em que foi tomada, por fase de construção.
A spec é o `CHALLENGE.md` (o guia original do desafio); "desafio N" abaixo se refere à seção N dele. Setup e comandos estão no `README.md`.

## Como ler este documento

| Se você quer saber                                               | Vá para                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| As escolhas principais e o que cada uma custou                   | [Resumo das escolhas](#resumo-das-escolhas-e-trade-offs)                    |
| Por que não há lost update nem saldo negativo                    | D21 (lock por wallet), D16 e D17 (constraints)                              |
| Como a idempotência funciona                                     | D24 (hash do payload), D25 (replay e conflito)                              |
| O que acontece quando um processo morre                          | D29 (ack), D35 (outbox), D41 e D42 (testes de queda)                        |
| ORM, mapeamento do `Money` e estratégia transacional (desafio 4) | D7, D22, D23                                                                |
| Transições de estado, `failureCode` e interpretações da spec     | D12, D13, D14                                                               |
| Como seria a autenticação                                        | [Autenticação](#autenticação--não-implementada-desenho-e-ponto-de-extensão) |
| O que não foi feito e por quê                                    | [O que ficou de fora](#o-que-ficou-de-fora-e-por-quê)                       |
| Onde o sistema é fraco                                           | [Limitações](#limitações-consolidado)                                       |
| Onde cada falha eliminatória está coberta no código              | [Auditoria](#auditoria-das-falhas-eliminatórias-desafio-14)                 |

## Resumo das escolhas e trade-offs

| Tema                     | Escolha                                                                                                                      | Alternativa descartada                          | Custo aceito                                                                                      | Decisão       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------- |
| Concorrência no saldo    | Lock pessimista por wallet (`SELECT ... FOR UPDATE`), com `UPDATE` condicionado à versão como alarme                         | Optimistic locking com retry                    | Operações da mesma wallet andam em fila; quem espera segura uma conexão e recebe 503 depois de 5s | D21           |
| Isolamento               | `READ COMMITTED`                                                                                                             | `SERIALIZABLE` com retry                        | A correção depende de todo cálculo de saldo passar pelo lock (há um só caminho que faz isso)      | D21           |
| ORM                      | MikroORM com `EntitySchema` e comandos explícitos                                                                            | TypeORM; flush adiado com dirty checking        | Nenhum `UPDATE` implícito, mas também nenhum dirty checking                                       | D7, D22, D23  |
| Dinheiro                 | `decimal.js` no domínio, `NUMERIC(19,2)` no banco, string no contrato                                                        | `bigint` em centavos                            | Uma dependência; em troca a escala não fica espalhada pelo código                                 | D11, D20, D23 |
| Idempotência             | Constraints de unicidade + `ON CONFLICT DO NOTHING` + hash do payload                                                        | Cache ou "consultei e não achei"                | Uma leitura a mais no replay                                                                      | D24, D25      |
| Invariantes              | Também no banco: `CHECK`, índices únicos e triggers (ledger append-only, estado terminal imutável, saldo × ledger no commit) | Só em código de aplicação                       | Uma checagem por commit; correção manual de dados fica mais difícil de propósito                  | D16 a D18     |
| Wallet inexistente       | Não persiste a transação (a FK é mantida)                                                                                    | Tirar a FK e gravar a rejeição                  | Essa rejeição só fica em log, métrica e DLQ                                                       | D19           |
| Entrada pela fila        | Inbox na mesma transação SQL; ack só depois do commit; uma mensagem por recebimento                                          | Receber em lote                                 | Mais chamadas ao SQS para o mesmo volume                                                          | D28 a D31     |
| Outbox                   | Travar (`SKIP LOCKED`), publicar e marcar em uma transação                                                                   | Reserva com `locked_until` (lease)              | Uma conexão ocupada durante o envio; entrega "pelo menos uma vez"                                 | D34 a D36     |
| Referência fora de ordem | Worker com backoff de 5s a 5 min, 8 tentativas (~15 min)                                                                     | TTL; acordar o worker quando a referência chega | O estorno espera a próxima tentativa                                                              | D38           |
| Logs e métricas          | Logger e registro de métricas próprios, sem dependência                                                                      | `pino`, `prom-client`                           | Sem métricas de processo (CPU, memória)                                                           | D44, D47      |
| Autenticação             | Não implementada, com ponto de extensão no código                                                                            | —                                               | Endpoints abertos                                                                                 | seção própria |

**Por que MikroORM** (o desafio aceita TypeORM): é o preferencial da spec, e três recursos dele são usados diretamente — `EntitySchema` (mapeamento fora das classes de domínio, que ficam sem decorators), `em.transactional()` com o contexto propagado por `AsyncLocalStorage` (os repositórios não recebem "tx") e `LockMode` (`PESSIMISTIC_WRITE` para o lock da wallet e `PESSIMISTIC_PARTIAL_WRITE` para o `SKIP LOCKED` da outbox, sem SQL cru).

## Estrutura

```
src/
  domain/          regras de negócio puras (sem Nest, sem ORM)
  application/     use cases, portas e hash do payload (sem Nest, sem ORM)
  infrastructure/  config, MikroORM (registros, repositórios, migrations), consumer SQS,
                   publisher de eventos, workers (outbox e PENDING_REFERENCE), health,
                   observabilidade (logger JSON, registro de métricas, gauges lidos no scrape),
                   autenticação (adaptador no-op da porta de identidade)
  interface/http/  controllers, validação, presenters, filtro de erros, middleware de
                   correlação/latência, guard de autenticação, /metrics
```

## Decisões

### Fase 0 — esqueleto

#### D1. Versões: Nest 12 + MikroORM 7 + TypeScript 7, rodando em Bun 1.3.11

- **O quê:** as `latest` de cada um, com versões exatas no `package.json`. A imagem Docker usa o mesmo Bun do desenvolvimento local.
- **Por quê:** Nest 12 e MikroORM 7 são ESM, que o Bun trata nativamente. O MikroORM 7 trocou knex por kysely (menos dependências opcionais) e detecta o Bun para carregar TypeScript sem loader extra.
- **Trade-off:** são releases de 2026, com menos referência pública. Recuar para Nest 11 + MikroORM 6 é barato enquanto o código for pequeno.
- **TypeScript** só faz `tsc --noEmit`. Quem transpila em runtime é o Bun.

#### D2. Roda direto do fonte, sem build

- **O quê:** `bun src/main.ts`, em dev e no container. Sem `@nestjs/cli`, sem bundle.
- **Por quê:** o Bun transpila TS e emite os metadados de decorators (`emitDecoratorMetadata`) lendo o `tsconfig.json`. Os `require` opcionais do Nest quebram o `bun build`.
- **Consequência:** o `tsconfig.json` precisa estar na imagem; sem ele a injeção de dependência falha.

#### D3. SQS local: LocalStack fixado em `4.14.0`

- **Por quê:** desde a 2026.03 a imagem do LocalStack só sobe com `LOCALSTACK_AUTH_TOKEN`. Quem avalia precisa de `docker compose up` sem criar conta. A 4.14.0 é da linha anterior à exigência e foi verificada subindo sem token.
- **Trade-off:** imagem congelada, sem correções futuras.
- **Plano B:** MiniStack, que o desafio aceita.

#### D4. Filas criadas por script de init, com DLQ por redrive policy

- **O quê:** `localstack/init/ready.d/01-create-queues.sh` cria `wager-transactions-dlq.fifo` e depois `wager-transactions.fifo` com `RedrivePolicy` (`maxReceiveCount = 5`) e `VisibilityTimeout = 30s`.
- **Por quê:** o limite de tentativas antes da DLQ fica imposto pelo broker, não só por código do consumer.
- **`ContentBasedDeduplication = true`** nas duas filas: aceita mensagens enviadas sem `MessageDeduplicationId` (útil para testar com `aws sqs send-message`). É só conveniência — a deduplicação que vale é a inbox no banco.
- O healthcheck do container só passa quando a fila principal existe, então a app nunca sobe antes das filas.
- Confirmados na Fase 4: 5 recebimentos (igual a `SQS_MAX_ATTEMPTS`); a visibilidade de 30s passou a ser definida pelo consumer a cada recebimento.

#### D5. Migrations em um serviço one-shot (`migrate`), fora do boot da app

- **Por quê:** com 3 ou mais instâncias subindo juntas, migrar no boot vira corrida entre elas. O `migrate` roda uma vez e a `app` só sobe depois (`service_completed_successfully`).
- **Config:** cada migration roda em transação e o lote é tudo-ou-nada.

#### D6. Migrations em lista explícita e escritas à mão

- **O quê:** `migrations/index.ts` exporta as classes na ordem de execução (`migrationsList`). Não há descoberta por pasta nem gerador automático.
- **Por quê (lista):** a descoberta por pasta do MikroORM 7 usa `fs.globSync({ withFileTypes })`, que o Bun 1.3.11 não implementa — o `migration:up` quebra com `fs.glob does not support options.withFileTypes yet`.
- **Por quê (à mão):** triggers, CHECKs e índices parciais fazem parte do que é avaliado e não saem de um diff de entidades.
- **Trade-off:** migration nova exige uma linha a mais no `index.ts`. Esquecer é detectável: ela não aparece no `migration:list`. O `migration:create` da CLI não funciona com `migrationsList` e por isso não tem script.

#### D7. Mapeamento por `EntitySchema`, entidades em lista explícita

- **Por quê:** o domínio não pode conhecer o ORM (desafio 6.1), então não há decorators de entidade. De quebra, some a dependência dos metadata providers do MikroORM, que são a parte frágil no Bun.
- Ainda não há entidades na Fase 0.

#### D8. Health checks feitos à mão

- **`GET /health/live`:** 200 sem tocar em dependência. Uma queda do Postgres não deve fazer o orquestrador reiniciar instâncias saudáveis.
- **`GET /health/ready`:** `select 1` no Postgres e `GetQueueAttributes` na fila principal, em paralelo, com prazo de 2s cada. 200 `{status:"ok"}` ou 503 `{status:"unavailable"}` com `up`/`down` por dependência.
- **Por quê `GetQueueAttributes`:** prova que o SQS responde e que a fila que vamos consumir existe.
- **Sem `@nestjs/terminus`:** são ~60 linhas e evita uma dependência fora da stack.
- O motivo da falha vai para o log, não para a resposta: o endpoint é aberto.

#### D9. Configuração por `process.env`, sem biblioteca

- `infrastructure/config/env.ts` valida no boot; variável obrigatória ausente derruba o processo com o nome dela.
- A config do MikroORM só exige `DATABASE_URL`, para o `migrate` rodar sem variáveis de SQS.
- `SQS_ENDPOINT` é opcional: definido, aponta o SDK para o LocalStack; ausente, o SDK usa a AWS real.

#### D10. Shutdown

- `enableShutdownHooks()` ligado e `CMD` em forma exec (o Bun é o PID 1 e recebe o `SIGTERM`). Verificado: `docker compose stop app` encerra em ~1s com exit 0.
- `stop_grace_period: 30s` reserva tempo para o consumer terminar mensagens em andamento (Fase 4).

### Fase 1 — domínio

#### D11. Money: decimal.js, entrada estrita, sem arredondamento

- **Entrada:** só `^(0|[1-9]\d{0,16})\.\d{2}$`. `"25"`, `"25.5"`, sinal, zero à esquerda e notação científica são rejeitados, não normalizados. Uma única grafia por valor mantém o `payloadHash` estável.
- **Precisão:** construtor de Decimal isolado com 40 dígitos, acima dos 19 do `NUMERIC(19,2)`. Money só soma e subtrai, então nunca arredonda; resultado acima do limite da coluna é erro.
- **Negativos:** recusados na entrada; podem surgir de `subtract`/`negate` (diferença da reconciliação).

#### D12. Transições da WagerTransaction

| Estado atual        | `markProcessed` | `markPendingReference` | `scheduleReferenceRetry` | `reject`   | `fail`   |
| ------------------- | --------------- | ---------------------- | ------------------------ | ---------- | -------- |
| `PENDING`           | `PROCESSED`     | `PENDING_REFERENCE`    | erro                     | `REJECTED` | `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`     | erro                   | mantém, tentativas +1    | `REJECTED` | `FAILED` |
| terminais           | erro            | erro                   | erro                     | erro       | erro     |

- "Erro" é `InvalidTransactionStateError` (erro de programação). `PENDING` nunca é commitado.
- Campos além do esqueleto do desafio: `observedBalance` (saldo na resolução, devolvido no replay — `REJECTED` e `LOSS` não têm lançamento de onde tirá-lo), `referenceAttempts` e `nextReferenceAttemptAt` (backoff do worker).

#### D13. failureCodes

- `REJECTED`: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`.
- `FAILED`: `PROCESSING_FAILED`.
- Significado e ação esperada do provedor estão em `src/domain/failure-code.ts`.
- Toda transação com failureCode é terminal: reenviar o mesmo id é replay; corrigir exige novo `externalTransactionId`.
- Payload inválido (400) e conflito de idempotência (409) não são failureCodes: não viram transação persistida.

#### D14. Interpretações do desafio

1. **Uma reversão por referência, de qualquer tipo.** O texto diz "pelo mesmo tipo de operação"; ao pé da letra, uma `BET` aceitaria `REFUND` e `ROLLBACK`, creditando duas vezes. Adotamos a leitura mais estrita.
2. **`WIN` e `LOSS` com referência opcional, validada quando vem** (mesmo contexto, kind `BET`, `PROCESSED`; sem checar valor). `BET` com referência é payload inválido.
3. **Referência que ainda está em `PENDING_REFERENCE`:** a dependente também aguarda.
4. **Valor zero só em `LOSS`;** os demais exigem valor positivo.
5. **Reversão desfeita não reabre a referência.** `BET` → `REFUND` → `ROLLBACK` do `REFUND` deixa o saldo como estava depois da aposta, e a `BET` continua marcada como já revertida: um novo `REFUND` dela é rejeitado com `REFERENCE_ALREADY_REVERSED`. É consequência da leitura estrita do item 1 (o `REFUND` continua `PROCESSED`, porque estados terminais são imutáveis). Um `ROLLBACK` também não pode ser revertido (`REFERENCE_KIND_NOT_ALLOWED`).

#### D15. Regras em função pura (`applyWagerRules`)

- Recebe wallet, transação e referência e leva a transação ao desfecho, movendo o saldo se for o caso. Sem IO: todas as regras são testadas sem banco.
- **Ordem fixa das checagens** (define qual código vence): wallet × player → moeda → referência ausente → referência (contexto, kind, status, valor, reversão única) → saldo.
- `Wallet.debit/credit` devolvem o lançamento: não há como mover saldo sem ledger. O crédito de abertura faz parte de `Wallet.open` e não incrementa a versão.
- Ids e relógio vêm de fora; o domínio não gera UUID nem lê a hora. Os números de backoff e limite de tentativas são parâmetro (D38 e D36).
- Um teste (`domain-purity.test.ts`) falha se `src/domain` importar algo além de `decimal.js`.

### Fase 2 — schema

Cinco migrations, uma por tabela, na ordem das FKs. Todas com `down`; um teste sobe, desce até o início (não sobra tabela, função, trigger nem índice) e sobe de novo.

#### D16. Cada garantia do desafio tem uma constraint no banco

| Tabela                  | Constraint                                                                                                       | Invariante protegida                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `wallets`               | `UNIQUE (player_id, currency)`                                                                                   | uma wallet por player + moeda (6.2)                                                                   |
| `wallets`               | `CHECK (balance >= 0)`                                                                                           | saldo nunca negativo, mesmo se lock ou regra falharem (3, 6.2)                                        |
| `wager_transactions`    | `UNIQUE (idempotency_key)`                                                                                       | idempotência persistente (9, 5.2)                                                                     |
| `wager_transactions`    | `UNIQUE (provider_id, external_transaction_id)`                                                                  | a mesma operação não entra duas vezes, nem com outra key; busca inequívoca da referência (7, regra 2) |
| `wager_transactions`    | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED`                          | uma reversão por referência (7, regra 4, leitura estrita da D14)                                      |
| `wager_transactions`    | `CHECK`s de coerência (failure_code × status, processed_at × status, referência × kind, valor zero só em `LOSS`) | estados e regras da 6.3 e 7                                                                           |
| `wager_transactions`    | trigger `wager_transactions_guard`                                                                               | estado terminal não muda, identidade nunca muda, nada é apagado (6.3)                                 |
| `wallet_ledger_entries` | `UNIQUE (wallet_id, transaction_id)`                                                                             | no máximo um lançamento por transação e wallet: retry não duplica débito/crédito (6.4)                |
| `wallet_ledger_entries` | trigger append-only (`UPDATE`, `DELETE`, `TRUNCATE`)                                                             | ledger não é sobrescrito nem excluído (5.5)                                                           |
| `wallet_ledger_entries` | `CHECK` da aritmética, valor positivo, saldos não negativos                                                      | `isBalanced` também no banco (6.4)                                                                    |
| `wallet_ledger_entries` | FK composta `(wallet_id, currency)` → `wallets`                                                                  | lançamento sempre na moeda da wallet                                                                  |
| `wallets` + ledger      | constraint trigger adiado `wallet_balance_matches_ledger`                                                        | toda alteração de saldo tem lançamento, e vice-versa (6.2)                                            |
| `inbox_messages`        | `PK (consumer_name, message_id)`                                                                                 | deduplicação de redelivery (10)                                                                       |
| `outbox_messages`       | índice parcial `WHERE published_at IS NULL`                                                                      | não é invariante: mantém a varredura do publisher barata (11)                                         |

Todas as constraints têm nome explícito. A aplicação vai distinguir "replay" de "wallet duplicada" pelo nome da constraint violada, e os testes conferem o nome, não só que houve erro.

#### D17. Saldo e ledger conferidos no commit

- **O quê:** um constraint trigger `DEFERRABLE INITIALLY DEFERRED` em `wallets` (INSERT e UPDATE de `balance`) e no ledger (INSERT). No commit, o saldo da wallet precisa ser o `balance_after` do último lançamento dela, ou zero se não há lançamentos.
- **Por quê:** o banco passa a recusar qualquer transação que mova saldo sem ledger ou grave ledger sem mover saldo, venha de onde vier.
- **Por que adiado:** dentro da transação a ordem entre atualizar o saldo e inserir o lançamento não importa; só o estado final é checado.
- **Custo:** uma busca por índice (`wallet_id, seq`) por commit que toca a wallet, já dentro do lock dela.

#### D18. Transações terminais imutáveis no banco

- O trigger recusa `UPDATE` em linha `PROCESSED`, `REJECTED` ou `FAILED`, mudança nas colunas de identidade (valor, wallet, chaves), volta para `PENDING`, `DELETE` e `TRUNCATE`.
- Consequência para a aplicação: o resultado de uma transação é gravado uma vez e nunca corrigido. Correção é uma nova transação (`ROLLBACK`).

#### D19. FK de `wager_transactions.wallet_id`

- **Decisão:** manter a FK. Transação para wallet inexistente não é persistida: a resposta será 422 `WALLET_NOT_FOUND` sem registro.
- **Trade-off:** essa rejeição não fica auditável em tabela (fica em log e métrica), mas o provedor pode reenviar o mesmo id depois de criar a wallet. A alternativa, sem FK, queimaria o `externalTransactionId` para sempre.

#### D20. Modelagem física

- **Dinheiro:** `NUMERIC(19,2)` + `char(3)` de moeda, em colunas separadas.
- **`kind`, `status`, `direction`:** `text` + `CHECK IN (...)`. Enum nativo do Postgres não remove valor, o que quebraria o `down`.
- **`seq` no ledger:** identity atribuída dentro do lock da wallet, logo crescente por wallet. É o cursor estável do `GET /ledger`, imune a relógio fora de sincronia entre instâncias.
- **`observed_balance_*`:** guarda a moeda junto porque, numa rejeição por `CURRENCY_MISMATCH`, o saldo observado está na moeda da wallet e a transação em outra.
- **Ids internos** são `uuid`; identificadores vindos de fora (`player_id`, `provider_id`, `message_id`...) são `text`.
- **Índices:** só os que uma consulta conhecida usa. Os de leitura da API entram na Fase 3, junto com as consultas.

#### Limitações do schema

- **Trigger não segura o dono da tabela**, que pode desabilitá-lo. Em produção a app usaria um role sem posse das tabelas e sem `UPDATE`/`DELETE`/`TRUNCATE` no ledger. No compose há um usuário só.
- **`inbox_messages` e `outbox_messages` crescem sem limite.** Falta uma rotina de expurgo (por exemplo, inbox processada e outbox publicada há mais de N dias).

#### Testes de integração

- Rodam contra o Postgres real do compose. Cada arquivo recebe um banco próprio (`wagering_test_<suite>`), recriado e migrado a cada execução.
- Não há limpeza entre testes: `TRUNCATE` é bloqueado de propósito, então cada teste cria as próprias wallets.
- Os testes de schema usam SQL direto pelo cliente Postgres do Bun, sem passar pela aplicação: provam que o banco recusa sozinho.

### Fase 3 — use cases, HTTP, idempotência e concorrência

#### D21. Lock por wallet: onde, por quanto tempo, e por que não há lost update

Fluxo de `ProcessWagerTransaction` (um use case só, para HTTP e fila):

1. **Sem lock:** busca pela `idempotency_key`. Achou com o mesmo hash → replay; hash diferente → 409. A maioria dos reenvios termina aqui.
2. `BEGIN`.
3. **Lock:** `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`). Por linha: wallets diferentes nunca esperam umas pelas outras. Wallet inexistente → 422, nada gravado.
4. `INSERT` da transação com `ON CONFLICT DO NOTHING`. Não inseriu → outra requisição com a mesma chave venceu: relê a linha dela e devolve replay ou 409.
5. Referência, regras de domínio (`applyWagerRules`), `UPDATE` do saldo, `INSERT` do lançamento, desfecho da transação, eventos na outbox.
6. `COMMIT`. Só então a resposta HTTP (ou o ack).

- **Por que a wallet é travada antes do INSERT:** o INSERT tem FK para `wallets`, e a checagem da FK pega `FOR KEY SHARE` na linha da wallet. Com a ordem inversa, duas requisições da mesma wallet seguram cada uma o seu `KEY SHARE`, pedem `FOR UPDATE` e travam uma à outra. Reproduzido no banco: `40P01 deadlock detected`. A alternativa era `FOR NO KEY UPDATE`, que o MikroORM não oferece como `LockMode`.
- **Por que `ON CONFLICT DO NOTHING`:** no Postgres uma exceção de unicidade aborta a transação inteira. Assim a unicidade continua sendo decidida pelo banco, sem exceção e sem savepoint.
- **Duração do lock:** do passo 3 ao `COMMIT`/`ROLLBACK`. Sob ele só há banco e memória (5 a 7 comandos indexados); nenhuma chamada de rede. Se o processo morre, a conexão cai e o Postgres desfaz e solta.
- **Espera limitada:** `lock_timeout` de 5s (`DB_LOCK_TIMEOUT_MS`), mais `statement_timeout` e `idle_in_transaction_session_timeout` de 15s. Quem não consegue o lock recebe 503.
- **Por que não há lost update:**
  1. o saldo só é lido para cálculo dentro do `SELECT ... FOR UPDATE`; quem espera o lock recebe a versão já commitada pela anterior. Por isso `READ COMMITTED` basta, sem `SERIALIZABLE` e sem retry;
  2. o `UPDATE` do saldo é condicionado à versão lida (`WHERE id = $1 AND version = $2`). Zero linhas afetadas aborta a transação. Sob o lock isso nunca dispara: é alarme contra bug futuro;
  3. o banco barra o resto: `CHECK (balance >= 0)`, um lançamento por `(wallet_id, transaction_id)`, saldo × ledger no commit.
- **Verificado:** sem o `FOR UPDATE`, 6 dos 14 testes de concorrência falham (com ou sem a conferência de versão).

#### D22. Estratégia transacional com o MikroORM

- **`em.fork().transactional(...)`** por unidade de trabalho. O fork tem identity map vazio; nada lido fora do lock é reaproveitado dentro.
- **Sem "tx" por parâmetro:** o MikroORM guarda o EntityManager da transação em `AsyncLocalStorage`, e o EntityManager global injetado nos repositórios resolve para ele dentro do callback.
- **Sem o middleware de RequestContext:** o contexto é aberto de forma explícita pelo `UnitOfWork` (`transactional` ou `session`), igual para HTTP, fila e workers.
- **Comandos explícitos, sem flush adiado:** cada método de repositório executa o seu SQL na hora. Num fluxo com lock, a ordem (travar, inserir, atualizar) é parte da correção e fica visível no use case.
- **Leituras com `disableIdentityMap`:** o registro é sempre o que o banco devolveu agora.
- **Trade-off:** abrimos mão do dirty checking do Unit of Work. Em troca, nenhum `UPDATE` sai sem estar escrito.

#### D23. Mapeamento: registros de persistência + `rehydrate`

- O MikroORM mapeia registros simples (`WalletRecord` etc.) com `EntitySchema`, sem decorators. Os repositórios convertem para o domínio com `rehydrate`.
- **Por quê:** mapear as classes de domínio faria o ORM hidratá-las por conta própria, contornando o `rehydrate` (desafio 6.0) e acoplando o domínio ao ORM.
- **Money:** `NUMERIC(19,2)` como string (`DecimalType('string')`) + moeda em coluna própria; vira `Money.from(...)` no conversor. Nunca passa por `number`. Testado com `0.00` indo e voltando.

#### D24. payloadHash

1. Objeto só com os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money {amount, currency}` e `referenceExternalTransactionId` quando presente.
2. JSON canônico: chaves em ordem alfabética em todos os níveis, sem espaços, campos ausentes omitidos, strings escapadas como `JSON.stringify`.
3. SHA-256 dos bytes UTF-8, hexadecimal minúsculo.

- Ficam fora: header `Idempotency-Key`, `messageId`, `occurredAt`, `correlationId`. HTTP e fila geram o mesmo hash.
- Valores não são normalizados: o Money só aceita uma grafia (`"25.00"`).
- Números são recusados pela canonização: não têm forma única e os contratos não usam nenhum.

#### D25. Idempotência

- **Mesma key, mesmo hash:** replay. A resposta é montada só do que está gravado na transação (status, failureCode, saldo observado), então status e corpo se repetem, com `idempotentReplay: true`.
- **Mesma key, hash diferente:** 409 `IDEMPOTENCY_KEY_CONFLICT`.
- **Mesmo `(providerId, externalTransactionId)` com outra key:** 409 `EXTERNAL_TRANSACTION_ID_CONFLICT`.
- **Replay de `PENDING_REFERENCE`:** devolve o estado atual. Se o worker já a processou, responde 201 em vez de repetir o 202. Para estados terminais não há diferença: o banco os torna imutáveis.
- **Falha antes do commit** (500 ou 503): nada foi gravado; a mesma requisição pode ser reenviada com a mesma key.

#### D26. Mapeamento HTTP

| Status    | Situação                                                                                               | O provedor deve             |
| --------- | ------------------------------------------------------------------------------------------------------ | --------------------------- |
| 201       | transação `PROCESSED` (ou wallet criada)                                                               | —                           |
| 202       | transação `PENDING_REFERENCE`                                                                          | aguardar; consultar depois  |
| 400       | payload, header, parâmetro ou cursor inválido                                                          | corrigir e reenviar         |
| 401 / 403 | credencial ausente ou inválida / provedor agindo em nome de outro — só com a autenticação ligada (D51) | obter token / não reenviar  |
| 404       | recurso consultado não existe                                                                          | —                           |
| 409       | conflito de idempotência ou wallet duplicada                                                           | não reenviar igual          |
| 422       | rejeição de negócio, com `failureCode`                                                                 | não reenviar igual          |
| 503       | falha transitória (lock, deadlock, banco), com `Retry-After`                                           | reenviar a mesma requisição |
| 500       | erro inesperado; replay de transação `FAILED`                                                          | —                           |

- Um único filtro (`ApiExceptionFilter`) traduz erro → status, para o mapeamento ser o mesmo em todos os endpoints. Corpo de erro: `{ code, message, details?, failureCode? }`.
- `WALLET_NOT_FOUND` é 422 no `POST /wagering/transactions` (rejeição de negócio sem registro, D19) e 404 nas consultas.
- Validação de entrada escrita à mão (`interface/http/validation.ts`), sem dependência nova; devolve todos os problemas de uma vez, por campo.

#### D27. Demais decisões

- **Use cases sem Nest:** classes comuns em `application/`, montadas por factory no `AppModule`. Dois testes de arquitetura falham se `domain/` ou `application/` importarem Nest, ORM ou infraestrutura.
- **Passos 5 a 7 em `ApplyWagerTransaction`:** separado do use case de entrada para o worker de `PENDING_REFERENCE` aplicar exatamente as mesmas regras.
- **Reconciliação:** saldo e somas do ledger vêm de um único comando SQL (um snapshot), sem travar a wallet. Divergência vai para log, métrica e resposta; nunca é corrigida.
- **Cursor do ledger:** base64url da posição (`seq`) do último item. Estável porque o ledger é append-only.
- **Eventos da OPENING:** `WagerTransactionProcessed` + `WalletBalanceChanged`, como qualquer transação aplicada.
- **Métricas e log:** portas `Metrics` e `AppLogger` já usadas pelos use cases; o formato dos logs e a exposição em `/metrics` estão na Fase 7 (D44 a D50).
- **Política de retry de referência:** definida e justificada em D38.

#### Limitações desta fase

- **Autenticação:** não implementada; o ponto de extensão entrou na Fase 8 (D51).
- **Pool:** 10 conexões por instância (`DB_POOL_MAX`). Requisição que espera lock segura uma conexão; uma wallet muito disputada pode ocupar o pool da instância até o `lock_timeout`.
- **Testes de concorrência desta fase:** conexões concorrentes em um processo. Os de três processos reais estão na Fase 6 (D40).

### Fase 4 — consumer SQS, inbox, DLQ e shutdown

#### D28. Um use case, duas portas de entrada

- A fila chama o mesmo `ProcessWagerTransaction` do HTTP. A mensagem é convertida no mesmo comando, pela mesma validação (`application/input-validation.ts`).
- Diferença única: o comando da fila leva `inbox { consumerName, messageId }`. Com ele o fluxo começa por `BEGIN` + `INSERT` na inbox, e a busca pela idempotency key acontece já dentro da transação.
- **Inbox na mesma transação SQL** do saldo, ledger, transação e outbox: ou a mensagem está registrada e o efeito aplicado, ou nenhum dos dois. Testado comparando o `xmin` das linhas.
- O `messageId` usado é o do corpo, não o do SQS: ele não muda quando o produtor reenvia. O `messageId` vira `correlationId` e `causationId` dos eventos.
- **Mesmo `messageId` com outro conteúdo:** a inbox guarda o hash da mensagem; se divergir, não é redelivery, é reuso do id → DLQ.

#### D29. Ack só quando o desfecho ficou gravado

| Situação                                                                             | O que acontece com a mensagem                                          |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| transação `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`; replay; duplicata de inbox | **ack** (`DeleteMessage`), depois do commit                            |
| corpo que não é JSON, envelope errado, payload inválido                              | **DLQ** na primeira tentativa                                          |
| wallet inexistente, conflito de idempotência, `messageId` reaproveitado              | **DLQ** na primeira tentativa                                          |
| transitório (lock timeout, deadlock, banco fora)                                     | **não apaga**; volta com backoff                                       |
| erro inesperado                                                                      | **não apaga**; na última tentativa grava `FAILED` e vai para a **DLQ** |

- **Regra:** o ack apaga a mensagem, então só é dado quando existe registro durável do desfecho. Rejeição de negócio gravada (`REJECTED`) recebe ack; os casos de negócio que não gravam nada vão para a DLQ com o motivo, em vez de sumirem com um ack.
- **Ack depois do commit:** o `DeleteMessage` só sai depois que o use case retorna. Se o processo morrer entre os dois, o SQS reentrega e a inbox descarta. Se o próprio `DeleteMessage` falhar, idem.

#### D30. Limite de tentativas, backoff e DLQ

- **Limite:** 5 recebimentos, em dois lugares que precisam concordar — `SQS_MAX_ATTEMPTS` no consumer e `maxReceiveCount` na redrive policy da fila. O consumer avisa no log se divergirem.
- **Backoff:** a mensagem não é apagada e a visibilidade é ajustada para 2s, 4s, 8s... com teto de 60s (`ChangeMessageVisibility`), conforme a contagem de recebimentos.
- **Permanente conhecido vai direto para a DLQ pelo consumer:** `SendMessage` na DLQ com atributos `DeadLetterReason`, `DeadLetterDetail` e `ReceiveCount`, depois `DeleteMessage` na principal. Cinco tentativas não consertam um JSON inválido, e o motivo fica na própria mensagem.
- **Rede de segurança:** a redrive policy do broker move para a DLQ qualquer mensagem que passe de 5 recebimentos, inclusive se o consumer morrer sempre antes de classificar.
- **`FAILED`:** erro inesperado na última tentativa → `RecordFailedTransaction` grava a transação como `FAILED` (`PROCESSING_FAILED`), com a inbox e o evento `WagerTransactionFailed`, e a mensagem vai para a DLQ. É terminal: reenviar a mesma mensagem só devolve o `FAILED`. Erro transitório nunca vira `FAILED`.

#### D31. Uma mensagem por recebimento, N workers

- Cada worker recebe **uma** mensagem por vez (`MaxNumberOfMessages: 1`); a instância roda `SQS_CONSUMER_CONCURRENCY` workers (padrão 5).
- **Por quê:** em fila FIFO, um lote traz várias mensagens do mesmo grupo. Verificado no LocalStack: as que vêm atrás de uma mensagem que falha gastam tentativas só por terem sido recebidas junto e vão para a DLQ com ela, sem nunca terem sido processadas. Recebendo uma por vez, a seguinte do grupo nem é entregue enquanto a da frente está em andamento, e a ordem do grupo é preservada.
- **Trade-off:** mais chamadas de `ReceiveMessage` para o mesmo volume.
- O consumer roda no mesmo processo do HTTP, em toda instância (`SQS_CONSUMER_ENABLED=false` desliga). Concorrência entre instâncias é resolvida pelo SQS (visibilidade, grupo) e, em última instância, pelo banco.

#### D32. Banco fora do ar pausa o consumo

- Depois de uma falha `DATABASE_UNAVAILABLE`, um portão (`ConsumptionGate`) fecha: os workers param de receber e uma sondagem (`select 1`) com backoff de 1s a 15s reabre quando o banco responde.
- **Por quê:** cada recebimento conta como tentativa. Sem a pausa, uma queda de poucos minutos gastaria as 5 tentativas de toda mensagem recebida e as empurraria para a DLQ.
- Lock de uma wallet não fecha o portão: é problema de uma mensagem, não de todas.
- Verificado no compose: com o Postgres parado houve uma tentativa, a mensagem ficou na fila sem gastar mais, e processou no recebimento seguinte, depois da volta.

#### D33. Shutdown (SIGTERM)

1. Para de buscar: nenhum worker inicia um novo long poll.
2. Espera as mensagens em andamento por até 20s (`SQS_SHUTDOWN_GRACE_MS`): commit e ack normais.
3. Espera os long polls em curso retornarem (no máximo `SQS_WAIT_TIME_SECONDS`, 10s). O que eles trouxerem é devolvido na hora, sem processar.
4. Devolve à fila (visibilidade 0) o que não terminou no prazo. Se o commit ainda acontecer, a redelivery é descartada pela inbox.

- **O long poll em curso não é abortado.** Verificado no LocalStack: o cliente desistir não cancela o poll no servidor, que ainda entrega uma mensagem à conexão morta; ela some pelo tempo de visibilidade e gasta uma tentativa.
- **O passo 3 vem antes do 4** para um poll ainda aberto da própria instância não pegar de volta a mensagem recém-devolvida.
- Roda em `beforeApplicationShutdown`, antes de o pool do banco fechar. Pior caso de parada: o maior entre 20s e 10s, dentro dos 30s do `stop_grace_period`. Verificado no compose: exit 0.

#### Limitações desta fase

- **Transitório que esgota as 5 tentativas** é movido para a DLQ pelo broker, sem o atributo de motivo (o motivo fica só no log). A mensagem pode ser reenviada da DLQ: o processamento é idempotente.
- **Bloqueio de grupo:** uma mensagem em backoff segura as seguintes do mesmo grupo FIFO. É o preço da ordem; o grupo é escolhido pelo produtor (recomendado: `walletId`).
- **Envio para a DLQ não é atômico** com o `DeleteMessage`. Se o processo morrer entre os dois, a mensagem é reprocessada e reenviada; o id de deduplicação evita a cópia dupla dentro da janela de 5 minutos do SQS.
- **Sem redrive automático da DLQ:** reenviar é uma ação manual do operador.
- **`WagerTransactionFailed`** é um evento além dos mínimos do desafio.

### Fase 5 — outbox publisher e worker de PENDING_REFERENCE

#### D34. Outbox publisher: travar, publicar e marcar na mesma transação

- Um ciclo (`PublishOutboxBatch`) é UMA transação SQL:
  1. `SELECT ... WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now) ORDER BY occurred_at, id LIMIT 10 FOR UPDATE SKIP LOCKED`;
  2. um `SendMessageBatch` para o SQS;
  3. `UPDATE` marcando `published_at` nas aceitas;
  4. `COMMIT`.
- **Vários publishers:** toda instância roda um e eles não se coordenam. O `SKIP LOCKED` faz cada um pular as linhas travadas pelos outros em vez de esperar. Testado com duas instâncias drenando 200 eventos (cada evento enviado uma vez) e com um lote travado enquanto o outro publisher pega o seguinte.
- **Nada é publicado antes do commit:** o publisher só enxerga linhas commitadas (READ COMMITTED). Testado com a transação de negócio aberta.
- **Por que o lock fica aberto durante o envio:** é o lock que impede o envio duplo, e ele some sozinho se o processo morrer — a recuperação é imediata, sem prazo de "lease" para expirar. O custo é uma conexão ocupada por uma ida e volta ao SQS, limitada por um prazo de envio de 5s (bem abaixo dos 15s de `idle_in_transaction_session_timeout`).
- **Alternativa descartada:** reservar com um `UPDATE locked_until` em uma transação e publicar fora dela. Não segura conexão durante o IO, mas exige coluna extra, a recuperação espera o lease expirar e um publisher lento além do lease também duplica.
- **Ritmo:** lote cheio e sem falha busca o próximo na hora; senão dorme 500ms (`OUTBOX_POLL_INTERVAL_MS`). É o atraso máximo de um evento em regime normal. Sem LISTEN/NOTIFY: o polling num índice parcial vazio é barato e não tem estado para perder.

#### D35. Queda entre publicar e marcar: entrega "pelo menos uma vez"

- Se o processo morrer depois do envio e antes do `COMMIT`, a conexão cai, o Postgres faz rollback, a linha continua pendente e outro publisher a envia DE NOVO. O mesmo vale para resposta do SQS que estoura o prazo e para `COMMIT` que falha.
- **A duplicata é segura** porque o id da linha da outbox é o `eventId` do envelope, igual em toda republicação:
  - o consumidor deduplica por `eventId` (o mesmo mecanismo da nossa inbox);
  - o envio usa `MessageDeduplicationId = eventId`, e a fila FIFO descarta a cópia que chegar em até 5 minutos. Isso reduz as duplicatas, não as elimina.
- **Ordem inversa (marcar e depois publicar) perderia o evento** numa queda, violando "não perder eventos confirmados". Sem transação atômica entre Postgres e SQS, a escolha é entre perder e duplicar.
- **Não duplica indefinidamente:** cada republicação exige uma nova falha, e linha marcada nunca volta a ser selecionada.
- Testado: o envio acontece de verdade, a marcação não commita, a linha segue pendente com `attempts = 0`, outra instância republica o mesmo `eventId` e a fila fica com uma cópia só.

#### D36. Falha de publicação: backoff sem limite de tentativas

- Falha do envio inteiro ou de uma mensagem do lote: `attempts++` e `next_attempt_at` com backoff de 1s dobrando até 60s. A falha NÃO aborta a transação — ela precisa commitar para gravar o backoff.
- Só conta como publicado o que o SQS confirmou explicitamente em `Successful`.
- **Sem limite e sem descarte:** evento confirmado não pode ser perdido. Um evento que nunca publica fica tentando a cada 60s e aparece no outbox lag (`outbox_lag_seconds`, D47).

#### D37. Destino e formato dos eventos

- O desafio não define o destino. Adotado: fila SQS FIFO `wager-events.fifo` (`SQS_EVENTS_QUEUE_URL`), criada pelo script do LocalStack. Sem dependência nova.
- A aplicação só conhece a porta `EventPublisher`; trocar por SNS ou EventBridge (fan-out para vários consumidores) é trocar o adaptador.
- Corpo: o envelope gravado na outbox (`eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`, `data`). `MessageGroupId = aggregateId`; atributo `eventType` para filtro sem abrir o corpo.
- **Ordem não é garantida entre publishers.** Com `SKIP LOCKED`, um publisher pode enviar o lote seguinte antes de outro terminar o anterior, e um evento em backoff é ultrapassado. O consumidor ordena por `walletVersion` (`WalletBalanceChanged`) e `occurredAt`. Garantir ordem por agregado exigiria serializar a publicação por agregado, anulando o ganho de vários publishers.

#### D38. Worker de PENDING_REFERENCE

- A cada 1s (`PENDING_REFERENCE_POLL_INTERVAL_MS`) busca, sem lock, as transações com `next_reference_attempt_at <= now` (índice parcial da Fase 2).
- Cada uma na SUA transação SQL, com o roteiro da entrada: `FOR UPDATE` na wallet → relê a transação → se ainda pendente e vencida, chama o mesmo `ApplyWagerTransaction` (passos 5 a 7). Uma candidata com erro não impede as outras.
- **Várias instâncias:** duas podem ver a mesma candidata; o lock da wallet as enfileira e a releitura faz a segunda pular. A ordem de locks do sistema não muda (wallet primeiro). Testado com 3 workers simultâneos: um crédito por estorno.
- **Desfechos:** referência válida → `PROCESSED` + ledger + eventos; inválida → `REJECTED` com o código específico; ausente → `attempts++` e novo backoff, sem repetir o evento de pendência; esgotou → `REJECTED` com `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
- **Política (limite por tentativas):** 5s dobrando até 5 min, 8 tentativas — 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s, cerca de 15 minutos. Configurável por env.
  - Cobre entrega fora de ordem (segundos) e uma indisponibilidade curta do provedor (minutos).
  - Além disso, um estorno pendurado é incerteza no saldo do jogador: melhor rejeitar e avisar por evento.
  - Depois do `REJECTED` o id fica "queimado": reenviar a mesma chave devolve o replay da rejeição. Para tentar de novo, o provedor usa outro `externalTransactionId`.
- **`correlationId` dos eventos do worker:** a transação não guarda o da requisição original. Cada resolução gera um novo, e `causationId = transactionId`. O rastreio de ponta a ponta é pelo `transactionId`, presente em todos os eventos. Alternativa não adotada: gravar o `correlationId` original em `wager_transactions` (migration nova numa tabela protegida pelo trigger de imutabilidade).

#### D39. Laço dos workers e shutdown

- `PollingLoop` é o laço comum dos dois workers: um ciclo por vez na instância; a concorrência é entre instâncias e é resolvida no banco.
- Ciclo que lança não derruba o laço; falhas seguidas aumentam a espera até 15s (banco fora não vira enxurrada de log).
- No SIGTERM (`beforeApplicationShutdown`): interrompe a espera e aguarda o ciclo em curso (limitado pelo prazo de envio e pelos timeouts do banco). O que ficar pendente na outbox é publicado por outra instância. Verificado no compose: parada em ~4s, exit 0.
- Cada worker pode ser desligado por instância (`OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED`).

#### Limitações desta fase

- **Latência da resolução:** a referência chegar não acorda o worker; o estorno espera a próxima tentativa (5s na primeira). Melhoria possível: ao processar uma transação, antecipar o `next_reference_attempt_at` de quem a espera.
- **Erro inesperado no worker de referência** (bug, não negócio): a transação continua vencida e é tentada a cada ciclo, com log de erro e métrica. Não há `FAILED` automático nesse caminho.
- **Lote de publicação limitado a 10** (um `SendMessageBatch`), um ciclo por vez por instância. A vazão escala com o número de instâncias.
- **Readiness** confere a fila de entrada, não a de eventos: com a fila de eventos fora, a instância segue pronta e os eventos se acumulam na outbox (visível no outbox lag).
- **Fila de eventos sem consumidor** neste desafio: as mensagens ficam retidas por 14 dias.

### Fase 6 — 3 instâncias, processo morto e reinício

#### D40. Instâncias de teste são processos reais

- `test/support/cluster.ts` sobe 3 processos `bun src/main.ts` (o comando do Dockerfile), cada um com porta e pool próprios, sobre o mesmo Postgres e as mesmas filas. Nada é compartilhado em memória: se a correção dependesse de estado do processo, os testes falhariam.
- Escolhido em vez de `docker compose --scale` porque o teste precisa matar uma instância específica com SIGKILL num ponto exato e subi-la de novo, dentro do `bun test`.
- Ao fim de TODO teste (`afterEach`), para todas as wallets do banco: saldo gravado == saldo reconstruído pelo ledger, cadeia `balance_before`/`balance_after` contínua e nenhum saldo negativo. Os testes também chamam a reconciliação da própria API.

#### D41. Ponto exato da morte sem código de teste na produção

- Cada instância fala com o SQS por um proxy do teste (`test/support/sqs-proxy.ts`), que consegue reter uma operação:
  - `DeleteMessage` retido antes de chegar ao SQS = commit feito, ack não entregue → SIGKILL. A mensagem volta, outra instância a recebe, a inbox a reconhece, um débito só.
  - `SendMessageBatch` com a resposta retida = evento já na fila, linha da outbox não marcada → SIGKILL. Outra instância republica o mesmo `eventId` e a fila FIFO fica com uma cópia.
- Morte antes do commit: o teste segura o lock da wallet, a instância fica parada dentro da transação (inbox já inserida) e é morta. Nada fica gravado e a mensagem é processada do zero por outra instância.
- Reinício: SIGTERM nas 3 instâncias, uma por vez, sob carga HTTP com o cliente repetindo a mesma idempotency key; e SIGKILL nas 3 de uma vez com 121 mensagens na fila (incluindo um REFUND antes da sua BET). No fim, cada operação existe uma vez, a DLQ está vazia e cada evento chegou uma vez à fila.

#### D42. Visibilidade da mensagem maior que o `lock_timeout` (validado no boot)

- `loadEnv` recusa `SQS_VISIBILITY_TIMEOUT_SECONDS * 1000 <= DB_LOCK_TIMEOUT_MS`. Padrões: 30s contra 5s.
- Motivo, achado nesta fase: uma mensagem pode esperar o lock da wallet por até `lock_timeout`. Se a visibilidade vencer antes, o SQS a entrega de novo com a primeira entrega ainda em andamento; a segunda fica presa no `INSERT` da inbox atrás da primeira e as tentativas são gastas à toa, podendo chegar à DLQ.

#### D43. `docker compose up --scale app=3`

- A porta do serviço `app` no host é `${APP_PORTS:-3000}:3000`. Padrão: uma instância, sempre em `:3000`. Para escalar: `APP_PORTS=3000-3002 docker compose up -d --scale app=3` (ficam em 3000, 3001 e 3002). Sem balanceador no compose: quem chama escolhe a porta.
- **Correção feita na Fase 7:** a faixa `3000-3002` chegou a ser o padrão, com a suposição de que a instância única ficaria em `:3000`. Não fica: o Docker distribui as portas da faixa em rodízio (em cinco recriações seguidas a instância única caiu em 3001, 3002, 3000, 3001, 3002). Por isso a faixa passou a ser opcional.
- Verificado à mão com a imagem real:
  - 150 apostas de 1.00 espalhadas pelas 3 réplicas sobre saldo 100.00 → 100 aprovadas e 50 rejeitadas; a mesma aposta 30 vezes → 30 replays;
  - 60 mensagens na fila com uma réplica morta por `docker kill` no meio do envio → 60 transações, 60 linhas de inbox, DLQ vazia, outbox sem pendentes;
  - reconciliação consistente pedida a cada réplica, e nenhuma wallet do banco com saldo diferente do ledger.
- Essa conferência é manual; a automatizada é a dos 3 processos (D40).

#### Limitações desta fase

- Mais de 3 réplicas no compose exige uma faixa maior em `APP_PORTS`. Escalar sem definir `APP_PORTS` falha por conflito na porta 3000.
- O teste de reinício gracioso confere que cada instância termina sozinha em menos de 10s após o SIGTERM, não o código de saída (fora do Docker o Nest reenvia o sinal a si mesmo).

### Fase 7 — logs estruturados e métricas

#### D44. Logger próprio: uma linha JSON por evento, campos no nível raiz

- `JsonLogger` (~60 linhas, sem dependência): `{"timestamp","level","message","service","instance", ...campos}`. `correlationId`, `transactionId` etc. são chaves diretas, fáceis de filtrar. `instance` é o hostname (no Docker, o id do container) e distingue as réplicas.
- Trocado pelo `ConsoleLogger` do Nest em modo JSON porque nele os campos ficavam aninhados em `message.message` e não havia onde barrar campo financeiro.
- Os logs do próprio Nest passam pelo mesmo logger (`NestLoggerAdapter` + `bufferLogs`): todo o stdout do processo tem um formato só. Falha ao subir (config inválida) também sai como uma linha JSON, com exit 1.
- `LOG_LEVEL` (debug, info, warn, error, silent; padrão info), validado no boot.

#### D45. O que é logado, e o que nunca é

- **Um log por transação, no use case** (`ProcessWagerTransaction`), que é o ponto único de HTTP e fila: `correlationId`, `messageId` (só fila), `transactionId`, `walletId`, `providerId`, `externalTransactionId`, `kind`, `status`, `failureCode`, `idempotentReplay`, `source`, `durationMs`.
- Falhas são logadas por quem decide o que fazer com elas: o filtro HTTP (4xx em info, 503 em warn com o motivo, 500 em error com o stack) e o handler da fila (retry ou DLQ, com `messageId`; mensagem ilegível leva o `sqsMessageId`).
- **Nunca entram:** valor, saldo, payload, corpo da requisição e `playerId`. Duas proteções no logger, além do cuidado em cada chamada:
  - campo só aceita valor escalar: um objeto (o payload) vira `"[omitido]"`;
  - campo com nome de valor financeiro ou credencial (`amount`, `balance`, `money`, `payload`, `body`, `token`...) vira `"[omitido]"`.
- A mensagem de erro de `amount` malformado deixou de repetir o valor recebido, porque ela vai para log e DLQ.
- Exceção deliberada: a reconciliação que diverge loga a **diferença** (desafio 9, Reconciliação: divergência tem que ser logada); é um delta, não o saldo.

#### D46. Correlação HTTP resolvida uma vez, num middleware

- `HttpObservabilityMiddleware` roda antes de tudo: usa o `X-Correlation-Id` do chamador (se bem formado) ou gera um, guarda na requisição e devolve no header de TODA resposta — antes, respostas de erro não o traziam.
- Controllers, filtro de erros e log de acesso usam o mesmo valor. Passagem explícita (comando → use case → evento → log), sem `AsyncLocalStorage`: mais código de passagem, mas dá para seguir o id lendo o código.
- O mesmo middleware mede a latência HTTP e escreve o log de acesso (`/health/*` e `/metrics` são medidos, mas não logados: chegam a cada poucos segundos).

#### D47. Métricas: registro próprio, dois tipos de valor

- `PrometheusMetrics` (~120 linhas, sem `prom-client`): contador, gauge e histograma de buckets fixos, no formato texto do Prometheus em `GET /metrics`. Custo aceito: não há métricas de processo (CPU, memória).
- **Contadores e histogramas são do processo**: o que ESTA instância viu desde que subiu. Com 3 instâncias, cada uma expõe o seu e a soma é feita na consulta (`sum by`). Zeram no restart, o que `rate()` trata.
- **Gauges são estado global, lidos do banco e do SQS a cada scrape** (`OperationalGauges`): contador em memória não responde "quantos eventos esperam na outbox", porque cada instância só vê o que ela fez. Todas as instâncias devolvem o mesmo valor.
  - Escolhido em vez de um amostrador em segundo plano: valor sempre fresco e nenhum laço novo para iniciar e parar. Custo: uma consulta (índices parciais, só pendentes) e duas chamadas ao SQS por scrape, com prazo de 2s.
  - Banco ou SQS fora não derrubam o `/metrics`: os gauges da origem ficam ausentes e `metrics_collection_errors_total{source}` sobe.
- **Nenhum id como label** (wallet, provedor, transação): cada valor de label é uma série. A latência HTTP usa o padrão da rota (`/wallets/:walletId`), e rota inexistente vira `unmatched`.
- `/metrics` é aberto, como os health checks: só contagens e durações. Em produção o acesso é restrito na rede.

#### D48. Onde está cada métrica exigida (desafio 12)

| Exigência                 | Métrica                                                                                                          | Tipo                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| transações por status     | `wager_transactions_total{status}`                                                                               | contador              |
| duplicatas detectadas     | `wager_duplicates_detected_total`; na fila, `wager_messages_total{outcome="DUPLICATE"}`                          | contador              |
| retries                   | `wager_message_retries_total{reason}`, `wager_reference_retries_total{outcome}`, `outbox_publish_failures_total` | contador              |
| mensagens em DLQ          | `wager_dlq_messages` (quantas estão lá agora) e `wager_messages_dead_lettered_total{reason}` (por que foram)     | gauge + contador      |
| conflitos de lock         | `wager_lock_conflicts_total{reason}` e `wallet_lock_wait_seconds`                                                | contador + histograma |
| outbox lag                | `outbox_lag_seconds`, `outbox_pending_events` e `outbox_publish_delay_seconds`                                   | gauges + histograma   |
| latência de processamento | `wager_transaction_duration_seconds{source,outcome}` e `http_request_duration_seconds{method,route,status}`      | histograma            |

Também: `wager_pending_reference_transactions`, `wager_queue_messages{state}`, `wallet_reconciliation_divergences_total`, `outbox_events_published_total`.

#### D49. Conflito de lock contado num lugar só

- Toda transação SQL passa por `MikroOrmUnitOfWork`; é ali que `LOCK_TIMEOUT`, `DEADLOCK` e `CONCURRENT_UPDATE` são contados, valendo para HTTP, fila e workers. O contador existia desde a Fase 3 e nunca era incrementado.
- Conflito é a espera que terminou em erro. A disputa que só atrasa aparece em `wallet_lock_wait_seconds` (tempo do `SELECT ... FOR UPDATE`): ~1ms com a wallet livre; no teste manual com 60 apostas simultâneas na mesma wallet, média de ~125ms e nenhum conflito.

#### D50. Outbox lag: gauge e histograma respondem perguntas diferentes

- `outbox_lag_seconds` = idade do evento pendente mais antigo, pelo relógio do banco (0 sem pendentes). Responde "há algo parado agora?" e é o que serve para alerta.
- `outbox_publish_delay_seconds` = tempo entre ocorrer e ser publicado, medido em cada publicação. Responde "quanto os eventos costumam esperar" (percentis). No compose fica em ~0,5s, que é o intervalo do publisher.
- `wager_dlq_messages` vem do SQS porque a redrive policy do broker também move mensagens para a DLQ, sem passar pelo contador da aplicação.

#### Verificação

- `test/integration/observability.test.ts`: `/metrics` de uma aplicação real (formato, cada métrica exigida subindo com o evento correspondente, SQS inalcançável) e o stdout de um processo real `bun src/main.ts` (toda linha é JSON, ids presentes, nenhum valor financeiro).
- Mutações conferidas: tirar a contagem de conflito de lock e pôr o valor da aposta no log fazem os testes falharem.
- No compose com 3 réplicas: contadores diferentes por réplica somando o total (50 aprovadas + 10 rejeitadas de 60 apostas; 5 replays), gauges iguais nas três, 198 linhas de log todas JSON e sem campo financeiro.

#### Limitações desta fase

- **Transações por status é contador de desfechos**, não foto do banco: um estorno que fica `PENDING_REFERENCE` e depois é resolvido conta nos dois status. A contagem exata por status é uma consulta ao banco (não exposta, para o scrape não varrer a tabela inteira).
- **Sem métricas de processo** (CPU, memória, event loop) e sem OpenTelemetry/tracing: o rastreio é por `correlationId` e `transactionId` nos logs e eventos.
- **JSON malformado no corpo** é recusado pelo parser do Express antes do middleware. O filtro de erros resolve o `correlationId` nesse caso (resposta e log saem com ele), mas a requisição não entra na latência HTTP nem no log de acesso.
- **Logs do Nest na subida** são retidos até o logger existir e saem todos com o horário da liberação, depois dos logs "iniciado" dos workers.
- **Scrape paralelo** de muitas instâncias repete a mesma consulta de gauges em cada uma; com muitos scrapers valeria um cache curto.

### Fase 8 — documentação e ponto de extensão da autenticação

#### D51. Autenticação fica de fora, com o ponto de extensão no código

- O desafio aceita não implementar (seção 2) e a autenticação não vale pontos; o tempo foi para correção financeira, concorrência e falhas.
- O que existe no código é o caminho por onde ela entra, já ligado e testado. O desenho está na seção [Autenticação](#autenticação--não-implementada-desenho-e-ponto-de-extensão).

#### D52. O guia do desafio virou `CHALLENGE.md`

- O `README.md` original era a spec. Ele foi copiado sem alterações para `CHALLENGE.md`, e o `README.md` passou a ser o do projeto (setup, comandos, testes), que é o que a avaliação pede.

#### D53. Uso de IA declarado no README

- O projeto foi desenvolvido com o Claude Code como assistente. O processo (uma etapa por vez, decisão antes do código, revisão ao fim de cada etapa) está na seção "Uso de IA" do `README.md`.

## Autenticação — não implementada: desenho e ponto de extensão

**Estado atual:** os endpoints estão abertos. Não há tabela de usuários, senha, API key nem verificação de token.

### Desenho que seria adotado

**Quem autentica.** Os chamadores são sistemas (provedores de jogos), não pessoas. O fluxo adequado é **OAuth 2.0 client credentials** contra um Identity Provider externo: **Keycloak** como mais um serviço do compose, com o realm importado de um arquivo versionado. Nada de autenticação artesanal.

1. Cada provedor é um _client_ confidencial no IdP. Ele troca `client_id` + `client_secret` por um access token JWT de vida curta (5 minutos).
2. O token carrega uma claim `provider_id` (um _mapper_ no client) e os escopos concedidos.
3. O provedor chama a API com `Authorization: Bearer <token>`.

**Como a API valida.** Localmente, sem chamar o IdP a cada requisição:

- assinatura RS256 com as chaves públicas do IdP (JWKS), mantidas em cache e renovadas quando aparece um `kid` desconhecido;
- `iss` (o realm), `aud` (esta API) e `exp`;
- com o IdP fora do ar, tokens já emitidos continuam valendo até expirar; ninguém consegue token novo.

**Autorização.**

- **O provedor só age em nome de si mesmo:** a claim `provider_id` tem que ser igual ao `providerId` do payload (`POST /wagering/transactions`) e da rota (`GET /providers/:providerId/...`); divergiu, 403. Sem isso, um provedor autenticado poderia debitar em nome de outro.
- **Consulta por id interno** (`GET /wagering/transactions/:transactionId`): o dono só é conhecido depois de carregar a transação. A de outro provedor responde 404, igual à inexistente, para não revelar que o id existe.
- **Endpoints de wallet** não têm um `providerId` para comparar: com a autenticação ligada, o que os protege é o escopo (abaixo), que ainda não é checado no guard.
- **Escopos por tipo de operação:** `wagering:write` para submeter, `wagering:read` para consultar, e `wallets:admin` para criar wallet e reconciliar, que são operações de backoffice e usariam um client separado do dos provedores.
- **Idempotency key:** ela é única no sistema inteiro. Com autenticação, a key passa a ter que começar pelo `provider_id` do token, para um provedor não ocupar a key de outro.

**Respostas.** 401 `UNAUTHENTICATED` com `WWW-Authenticate: Bearer` para credencial ausente ou inválida; 403 `PROVIDER_NOT_ALLOWED` para provedor agindo em nome de outro ou sem o escopo. As duas saem antes de qualquer acesso ao banco e não gravam nada.

**O que fica fora da autenticação** (como a seção 2 do desafio define):

- `GET /health/live` e `/health/ready` ficam abertos. O `/metrics` também, com acesso restrito na rede.
- A fila é canal interno confiável: quem pode enviar para ela é controlado pela política de acesso da fila (IAM), não por token. O `providerId` da mensagem passa pelas mesmas validações de domínio, porque a fila chama o mesmo use case.

**O token nunca vai para o log:** o logger já omite campos chamados `authorization` e `token` (D45).

### Ponto de extensão no código

| Peça                      | Arquivo                                             | Papel                                                                                                                                               |
| ------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderIdentityPort`    | `src/application/ports/provider-identity.ts`        | Contrato: recebe o header `Authorization` e devolve `{ providerId }`, lança `UnauthenticatedError`, ou devolve `undefined` (autenticação desligada) |
| `OpenProviderIdentity`    | `src/infrastructure/auth/open-provider-identity.ts` | Adaptador no-op em uso: sempre `undefined`, todo chamador é aceito                                                                                  |
| `ProviderAuthGuard`       | `src/interface/http/provider-auth.guard.ts`         | Guard dos controllers de wallets e transações; health e `/metrics` não passam por ele                                                               |
| `assertActsAs` / `actsAs` | `src/interface/http/provider-auth.guard.ts`         | Compara o provedor do token com o `providerId` do payload, da rota ou da transação carregada                                                        |
| 401 e 403                 | `src/interface/http/api-exception.filter.ts`        | Mapeamento já feito, no mesmo filtro dos outros erros                                                                                               |

**Para ligar a autenticação** troca-se uma linha: o provider de `PROVIDER_IDENTITY` no `InfrastructureModule` passa de `OpenProviderIdentity` para um `OidcProviderIdentity`. Além disso:

1. Keycloak no compose, com o realm e os clients de exemplo importados;
2. o adaptador `OidcProviderIdentity`, com uma biblioteca de JWT/JWKS (`jose`), que é dependência fora da stack e precisaria ser aprovada;
3. variáveis `AUTH_ISSUER_URL` e `AUTH_AUDIENCE`, validadas no boot;
4. a checagem de escopo no guard (é ela que restringe os endpoints de wallet: sem ela, qualquer provedor autenticado lê qualquer wallet) e a regra do prefixo da idempotency key.

Use cases, domínio e fila não mudam.

**Verificado em `test/integration/auth-extension.test.ts`:** com o no-op, requisição sem credencial passa. Fazendo a porta se comportar como um IdP — a única troca que um adaptador real faria —, a API responde 401 sem credencial, 403 para provedor agindo em nome de outro (sem transação e sem débito), 404 na consulta por id da transação de outro provedor, processa normalmente o provedor legítimo e mantém health e `/metrics` abertos.

**Alternativas não adotadas:** API key em tabela própria ou assinatura HMAC feita à mão (é a autenticação artesanal que o desafio pede para evitar); mTLS na borda (válido, mas é configuração de infraestrutura e não deixa a identidade do provedor disponível para a regra "age em nome de si mesmo" sem um passo extra).

## O que ficou de fora e por quê

| Item                                                | Por quê                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Autenticação**                                    | Não vale pontos e o desafio aceita não implementar. Desenho e ponto de extensão acima                                                                                                                                                                              |
| **Teste de carga** (`bun run test:load`)            | Diferencial opcional. O tempo foi para testes de correção sob concorrência e falha, que provam que o resultado está certo, não quanto o sistema aguenta. **Não há número de vazão medido**; as métricas para medi-lo (latência, tempo de lock, outbox lag) existem |
| **Ledger de partidas dobradas**                     | Opcional. O ledger é de partida simples por wallet, com `balance_before` e `balance_after` em cada lançamento, o que basta para reconciliar. Partidas dobradas exigiriam modelar as contas de contrapartida (casa, provedor)                                       |
| **OpenTelemetry e dashboard**                       | Opcionais. O rastreio é por `correlationId` e `transactionId` em logs e eventos                                                                                                                                                                                    |
| **Reversão parcial**                                | Fora de escopo pela própria spec (desafio 7, regra 5)                                                                                                                                                                                                              |
| **Conversão entre moedas**                          | O modelo é multi-moeda (wallet por player e moeda, conflito de moeda testado), mas não há câmbio                                                                                                                                                                   |
| **Expurgo de `inbox_messages` e `outbox_messages`** | As tabelas crescem sem limite. Falta uma rotina que apague inbox processada e outbox publicada antigas                                                                                                                                                             |
| **Redrive automático da DLQ**                       | Reenviar da DLQ é ação manual. O reprocessamento é seguro (idempotente)                                                                                                                                                                                            |
| **Consumidor dos eventos**                          | A fila `wager-events.fifo` não tem consumidor neste desafio; o que se garante é a publicação                                                                                                                                                                       |
| **Balanceador na frente das réplicas**              | No compose cada réplica tem a sua porta. Os testes de 3 instâncias falam com cada processo direto, de propósito                                                                                                                                                    |
| **Role de banco restrito**                          | No compose a aplicação é dona das tabelas. Em produção ela usaria um role sem `UPDATE`/`DELETE` no ledger e sem poder desabilitar triggers                                                                                                                         |
| **Acordar os workers por evento** (`LISTEN/NOTIFY`) | Polling em índice parcial é barato e não tem estado para perder. Custa até 500ms de atraso na publicação                                                                                                                                                           |
| **Pipeline de CI**                                  | Os testes precisam de Postgres e LocalStack; rodam com o compose local                                                                                                                                                                                             |

## Limitações (consolidado)

As limitações de cada fase estão ao fim da seção dela. As que mais pesam:

- **Wallet muito disputada.** As operações de uma mesma wallet são serializadas pelo lock. A vazão por wallet é limitada pelo tempo de uma transação (alguns milissegundos), e quem espera segura uma conexão do pool (10 por instância). Uma wallet sob carga extrema pode ocupar o pool da instância até o `lock_timeout` de 5s, e as requisições excedentes recebem 503 (D21).
- **Eventos são entregues "pelo menos uma vez" e sem ordem garantida entre publishers.** O consumidor precisa deduplicar por `eventId` e ordenar por `walletVersion` (D35, D37).
- **Estorno fora de ordem espera a próxima tentativa do worker** (5s na primeira), mesmo que a referência chegue antes (D38).
- **Rejeição por wallet inexistente não fica em tabela**, só em log, métrica e DLQ (D19).
- **Falha transitória que esgota as 5 tentativas** vai para a DLQ pela redrive policy do SQS, sem o atributo de motivo (Fase 4).
- **Relógio das instâncias.** Backoffs e `occurred_at` usam o relógio da aplicação; relógios dessincronizados alteram tempos de retry e a ordem aproximada de publicação. A ordem do ledger não depende disso (usa `seq`, atribuído dentro do lock).
- **Triggers não seguram o dono da tabela**, e inbox e outbox crescem sem expurgo (Fase 2).
- **Contadores de métrica são por processo** e zeram no restart; "transações por status" conta desfechos, não é foto do banco (Fase 7).
- **Versões muito recentes** (Nest 12, MikroORM 7, TypeScript 7) e **LocalStack fixado** em uma versão antiga para não exigir token (D1, D3).
- **Sem medição de carga:** não há número de vazão nem de latência sob carga.

## Auditoria das falhas eliminatórias (desafio 14)

Cada item aponta onde o código impede a falha e qual teste falharia se a proteção fosse removida.

### 1. `number` para dinheiro

- **Domínio:** `Money.from` recusa qualquer `amount` que não seja string no formato decimal (`src/domain/money.ts:47`); a aritmética é `decimal.js` com precisão acima da coluna.
- **Banco:** `numeric(19,2)` em todas as colunas de valor (`Migration20261114000001_wallets.ts:14` e as demais).
- **Mapeamento:** o ORM lê e grava `NUMERIC` como string (`src/infrastructure/persistence/records.ts:11`), convertida por `Money.from` nos mappers.
- **Contrato:** entrada e saída usam `{ "amount": "25.00", "currency": "BRL" }`; o hash do payload recusa números.
- **Testes:** `src/domain/money.test.ts:45` (rejeita `number`), `src/application/payload-hash.test.ts:36`, e os de contrato em `test/integration/wager-transactions.test.ts:71` (`"0.00"` com escala).

### 2. Saldo negativo causado por race

- **Lock:** o saldo só é lido para cálculo sob `SELECT ... FOR UPDATE` (`src/infrastructure/persistence/repositories.ts:92`, chamado em `src/application/process-wager-transaction.ts:181`).
- **Regra:** aposta sem saldo é `REJECTED` antes de mover qualquer coisa (`src/domain/wager-rules.ts:100`).
- **Rede de segurança no banco:** `CHECK (balance >= 0)` (`Migration20261114000001_wallets.ts:25`) e `UPDATE` condicionado à versão lida (`repositories.ts:103`).
- **Testes:** `test/integration/concurrency.test.ts:40` (100.00 e duas de 80.00), `:170` (30 apostas sobre 100.00) e `test/integration/multi-instance.test.ts:139` e `:156` (o mesmo em 3 processos). Sem o `FOR UPDATE`, esses testes falham.

### 3. Débito ou crédito duplicado

- **Mesma operação duas vezes:** `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` (`Migration20261114000002_wager_transactions.ts:37` e `:41`), com `INSERT ... ON CONFLICT DO NOTHING` (`repositories.ts:154`): quem perde a corrida devolve o resultado de quem venceu (`process-wager-transaction.ts:187`).
- **Mesmo lançamento duas vezes:** `UNIQUE (wallet_id, transaction_id)` no ledger (`Migration20261114000003_wallet_ledger_entries.ts:28`).
- **Mesma reversão duas vezes:** índice único parcial por referência (`Migration20261114000002_wager_transactions.ts:93`).
- **Mesma mensagem duas vezes:** `PRIMARY KEY (consumer_name, message_id)` na inbox (`Migration20261114000004_inbox_messages.ts:19`), inserida na mesma transação do efeito (`process-wager-transaction.ts:227`).
- **Testes:** `concurrency.test.ts:103` (50 vezes em paralelo), `:204` (REFUND e ROLLBACK simultâneos), `sqs-consumer.test.ts:171` e `multi-instance.test.ts:342` (worker morto depois do commit e antes do ack), `multi-instance.test.ts:176` (60 vezes em 3 processos).

### 4. Idempotência apenas em memória

- Não há cache, `Map` nem estado de processo na decisão: o replay é uma leitura do banco (`process-wager-transaction.ts:163`) e a unicidade é das constraints do item 3.
- **Testes:** `multi-instance.test.ts:176` e `:317` enviam a mesma operação a três processos diferentes, que não compartilham memória; `:537` mata os três e reinicia.

### 5. Solução correta somente com uma instância

- Toda coordenação é feita no banco: lock de linha por wallet, `FOR UPDATE SKIP LOCKED` na outbox (`repositories.ts:256`), constraints. Nenhum lock em memória, nenhum singleton com estado de negócio.
- Migrations rodam fora do boot (serviço `migrate`), para as instâncias não disputarem ao subir juntas.
- **Testes:** `test/integration/multi-instance.test.ts` inteiro roda 3 processos reais (`test/support/cluster.ts:66`); conferido também com `docker compose --scale app=3` (D43).

### 6. Publicação de evento antes do commit

- Os eventos são gravados na outbox dentro da transação de negócio (`src/application/apply-wager-transaction.ts:90`, sob o `transactional` de `process-wager-transaction.ts:170`). O use case não chama o SQS.
- O publisher é outro fluxo e só lê linhas commitadas (`src/application/publish-outbox-batch.ts:60`, `READ COMMITTED`).
- **Testes:** `test/integration/outbox-publisher.test.ts:186` (transação aberta: nada é publicado) e `wager-transactions.test.ts:445` (falha na gravação da outbox desfaz tudo).

### 7. Ausência de ledger auditável

- Toda mudança de saldo gera um lançamento com `balance_before` e `balance_after`; `Wallet.debit/credit` devolvem o lançamento, então não há como mover saldo sem ele.
- **Append-only no banco:** trigger que recusa `UPDATE`, `DELETE` e `TRUNCATE` (`Migration20261114000003_wallet_ledger_entries.ts:52` a `:66`).
- **Saldo × ledger conferido no commit:** constraint trigger adiado (`Migration20261114000003_wallet_ledger_entries.ts:75` e `:107`).
- **Consulta e conferência:** `GET /wallets/:walletId/ledger` e `POST /wallets/:walletId/reconciliation` (`src/interface/http/wallets.controller.ts:30` e `:36`).
- **Testes:** `test/integration/schema-constraints.test.ts:471` a `:507` (append-only) e `:593` a `:653` (saldo × ledger); `wallets.test.ts:257` (divergência sinalizada e não corrigida).

### 8. Testes que substituem PostgreSQL e SQS por mocks

- Os testes de `test/integration/` usam o Postgres e o LocalStack do compose: banco próprio por arquivo (`test/support/test-database.ts:22`) e filas FIFO próprias (`test/support/test-queues.ts:28`).
- As falhas são provocadas de verdade: processo morto com `SIGKILL`, lock segurado por outra conexão, operação do SQS retida num proxy HTTP (`test/support/sqs-proxy.ts`), trigger de teste que faz o `INSERT` da outbox falhar.
- O único `spyOn` da suíte de integração está em `auth-extension.test.ts`, sobre a porta de identidade (não é banco nem fila).
- Os testes de unidade com portas em memória (`src/application/publish-outbox-batch.test.ts`) cobrem decisões; o comportamento real está repetido na integração.

## Armadilhas conhecidas (Bun + Nest + MikroORM)

- Processo morto enquanto espera um lock: o Postgres só percebe que o cliente sumiu quando a espera termina (`lock_timeout`). Até lá a transação do processo morto continua aberta, com o que ela já inseriu (ex.: a linha da inbox) bloqueando quem tentar inserir a mesma chave (D42).
- 100 `SendMessage` simultâneos pelo cliente SQS do teste travam 5s de vez em quando (artefato do cliente, não da aplicação). Os testes enviam em ordem por wallet.

- Abortar um long poll do SQS no cliente não o cancela no servidor (D33): a mensagem entregue ao poll abortado fica invisível e perde uma tentativa.
- Timer pendente segura o container: no Docker o processo é PID 1 e não morre pelo sinal que o Nest reenvia a si mesmo ao fim do shutdown; ele só sai quando o event loop esvazia. Um `setTimeout` esquecido de 20s atrasava a parada em 20s.

- FK + `FOR UPDATE`: inserir numa tabela filha e depois travar a linha pai com `FOR UPDATE` dá deadlock entre duas transações do mesmo pai (D21). Regra da casa: trava a wallet antes de inserir qualquer coisa que a referencie.

- Cliente Postgres do Bun (`Bun.SQL`, usado só nos testes de schema): a consulta é preguiçosa e só executa com `await` (`expect(query).rejects` nunca a dispara), e o `NUMERIC` `0.00` volta como `"0"`. Os testes leem dinheiro com `::text`. A aplicação usa o driver `pg` via MikroORM.

- `import type` de uma classe injetada por construtor some na transpilação e o Nest recebe `undefined`. Providers usam import de valor; tokens e interfaces usam `@Inject(TOKEN)`.
- O `RequestContext` do MikroORM só existe dentro de requisição HTTP. Consumer SQS e workers vão precisar de `em.fork()` explícito.
- `bun test` não é Jest (`jest.mock` não existe) e roda tudo em um processo: os testes de 3+ instâncias vão usar processos reais.
- Dentro da rede do compose, a `QueueUrl` devolvida pelo LocalStack aponta para `localhost`. A URL da fila vem de env e o cliente usa `endpoint` explícito, então o host da URL nunca é resolvido.
