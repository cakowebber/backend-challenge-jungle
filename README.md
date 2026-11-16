# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, por HTTP e por fila SQS. Ele continua correto com mensagens duplicadas, fora de ordem e simultâneas, e com três ou mais instâncias rodando ao mesmo tempo.

Solução do desafio técnico da Jungle Gaming.

| Documento | Conteúdo |
|---|---|
| [`CHALLENGE.md`](CHALLENGE.md) | O guia original do desafio (a spec), sem alterações |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Decisões, trade-offs, limitações, o que ficou de fora, desenho da autenticação e auditoria das falhas eliminatórias |
| Este arquivo | Setup, comandos e como rodar os testes |

**Stack:** Bun 1.3 · TypeScript estrito · NestJS 12 · MikroORM 7 · PostgreSQL 18 · SQS via LocalStack · Docker Compose.

## Requisitos

- Docker com Compose v2 (testado com Docker 29 e Compose 5).
- [Bun](https://bun.sh) 1.3.x, só para rodar testes e comandos fora do container (testado com 1.3.11).

Portas usadas no host: `3000` (API), `5432` (PostgreSQL) e `4566` (LocalStack).

## Subir tudo

```bash
docker compose up -d --build
```

Isso sobe, nesta ordem:

1. `postgres` e `localstack` (as filas são criadas por `localstack/init/ready.d/01-create-queues.sh`);
2. `migrate`, que aplica as migrations uma vez e termina;
3. `app`, a API em `http://localhost:3000`, já consumindo a fila e publicando eventos.

Confira que está pronto:

```bash
curl http://localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Para derrubar: `docker compose down` (acrescente `-v` para apagar também os dados do banco).

## Usando a API

Criar uma wallet com saldo inicial:

```bash
PLAYER=$(uuidgen | tr 'A-Z' 'a-z')

curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
# {"id":"<walletId>","playerId":"...","balance":{"amount":"100.00","currency":"BRL"},"version":1}

WALLET=<walletId devolvido acima>
```

Submeter uma aposta. O header `Idempotency-Key` é obrigatório:

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
```

Repetir exatamente o mesmo comando devolve o mesmo status e corpo, com `"idempotentReplay":true`, sem novo débito.

Ledger, reconciliação e consulta:

```bash
curl -s "http://localhost:3000/wallets/$WALLET/ledger?limit=50"
curl -s -X POST "http://localhost:3000/wallets/$WALLET/reconciliation"
curl -s "http://localhost:3000/providers/provider-a/wagering/transactions/tx-1"
```

Enviar a mesma operação pela fila (entra pelo mesmo use case do HTTP):

```bash
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" \
  --message-deduplication-id "msg-2" \
  --message-body "{\"messageId\":\"msg-2\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-11-15T12:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-2\",\"idempotencyKey\":\"provider-a:tx-2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"

curl -s "http://localhost:3000/wallets/$WALLET"   # saldo 65.00 logo em seguida
```

### Endpoints

| Método e rota | O que faz |
|---|---|
| `POST /wallets` | Cria a wallet; saldo inicial gera a transação `OPENING` e o crédito no ledger |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Lançamentos em ordem, com cursor opaco |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo gravado com o reconstruído pelo ledger |
| `POST /wagering/transactions` | Submete uma transação (header `Idempotency-Key`) |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness e readiness (PostgreSQL e SQS) |
| `GET /metrics` | Métricas no formato do Prometheus |

### Status HTTP

| Status | Situação | O provedor deve |
|---|---|---|
| 201 | Transação `PROCESSED` (ou wallet criada) | — |
| 202 | Transação `PENDING_REFERENCE` (a referência ainda não chegou) | aguardar e consultar depois |
| 400 | Payload, header ou parâmetro inválido | corrigir e reenviar |
| 409 | Conflito de idempotência ou wallet duplicada | não reenviar igual |
| 422 | Rejeição de negócio, com `failureCode` | não reenviar igual |
| 503 | Falha transitória (lock, banco), com `Retry-After` | reenviar a mesma requisição, com a mesma key |

Os `failureCode` e o que cada um significa estão em `src/domain/failure-code.ts`.

## Testes

Os testes de integração e de concorrência rodam contra o **PostgreSQL e o LocalStack reais** do compose. Não há mock de banco nem de fila.

```bash
docker compose up -d postgres localstack   # ou o compose inteiro; a app rodando não atrapalha
cp .env.example .env                       # o Bun lê o .env sozinho
bun install

bun run typecheck          # tsc --noEmit
bun test                   # tudo: cerca de 530 testes em ~70s
bun run test:unit          # só unidade (src/), sem depender de container: menos de 1s
bun run test:integration   # só integração e concorrência (test/integration/)
```

Um arquivo ou um teste específico:

```bash
bun test test/integration/concurrency.test.ts
bun test -t "duas apostas de 80.00"
TEST_LOGS=1 bun test test/integration/sqs-consumer.test.ts   # com os logs da aplicação
```

Cada arquivo de integração cria o próprio banco (`wagering_test_<suite>`) e as próprias filas no LocalStack, então os testes não disputam dados entre si nem com o ambiente de desenvolvimento.

| Arquivo | O que cobre |
|---|---|
| `src/**/*.test.ts` | `Money`, `Wallet`, regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, conflito de moeda, hash e idempotência, eventos, config, métricas, logger |
| `migrations.test.ts` | `up`, `down` até o início e `up` de novo |
| `schema-constraints.test.ts` | Unicidade, `CHECK (balance >= 0)`, ledger append-only, saldo × ledger conferido no commit |
| `wallets.test.ts` · `wager-transactions.test.ts` | Contratos HTTP, idempotência, atomicidade entre wallet, ledger e outbox |
| `concurrency.test.ts` | 100.00 e duas apostas de 80.00; a mesma aposta 50 vezes em paralelo; wallets distintas |
| `sqs-consumer.test.ts` | Inbox, redelivery, retry com backoff, DLQ, `SIGTERM` |
| `outbox-publisher.test.ts` | Dois publishers na mesma outbox, queda entre publicar e marcar |
| `pending-reference.test.ts` | `REFUND`/`ROLLBACK` antes da referência, backoff, limite de tentativas |
| `multi-instance.test.ts` | **3 processos reais**: disputa de wallet, worker morto depois do commit e antes do ack, reinício |
| `observability.test.ts` | `/metrics` e o stdout de um processo real |
| `auth-extension.test.ts` | O ponto de extensão da autenticação |

Em todos os testes que movem saldo a invariante final é conferida: `wallet.balance == saldo reconstruído pelo ledger`.

## Três instâncias no compose

```bash
APP_PORTS=3000-3002 docker compose up -d --scale app=3
```

As réplicas ficam em `localhost:3000`, `3001` e `3002` (o Docker escolhe qual réplica recebe qual porta), todas sobre o mesmo banco e as mesmas filas. Não há balanceador: quem chama escolhe a porta. Para voltar a uma instância: `docker compose up -d --scale app=1`.

## Rodar a aplicação fora do Docker

```bash
docker compose up -d postgres localstack
cp .env.example .env
bun install
bun run migration:up
bun run dev        # recarrega ao salvar; `bun run start` roda sem recarregar
```

Se o container `app` do compose estiver no ar, a porta 3000 já está em uso: pare-o (`docker compose stop app`) ou rode com `PORT=3100 bun run dev`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação (`bun src/main.ts`, o mesmo comando do container) |
| `bun run dev` | Sobe com recarga ao salvar |
| `bun run typecheck` | Checagem de tipos, sem emitir arquivos |
| `bun test` · `bun run test:unit` · `bun run test:integration` | Testes |
| `bun run migration:up` | Aplica as migrations pendentes |
| `bun run migration:down` | Reverte a última migration |
| `bun run migration:list` | Lista as migrations e quando foram aplicadas |

Não há passo de build: o Bun roda o TypeScript direto do fonte.

## Configuração

Todas as variáveis estão em [`.env.example`](.env.example), com o valor padrão e o efeito de cada uma. As obrigatórias são `DATABASE_URL`, `AWS_REGION` e as três URLs de fila; faltando uma, o processo não sobe e diz qual falta. No compose os valores ficam no próprio `docker-compose.yml`.

## Observar o sistema

```bash
docker compose logs -f app            # uma linha JSON por evento, com correlationId, transactionId, walletId...
curl -s http://localhost:3000/metrics # transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência
```

Filas no LocalStack:

```bash
Q=http://localhost:4566/000000000000
docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url $Q/wager-transactions-dlq.fifo --attribute-names ApproximateNumberOfMessages
docker compose exec -T localstack awslocal sqs receive-message --queue-url $Q/wager-events.fifo --max-number-of-messages 5
```

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | Entrada de transações |
| `wager-transactions-dlq.fifo` | Mensagens que não puderam ser processadas, com o motivo em atributo |
| `wager-events.fifo` | Eventos de integração publicados pela outbox |

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, regras. Sem Nest e sem ORM.
  application/     Use cases (um só para HTTP e fila), portas, validação de entrada, hash do payload.
  infrastructure/  MikroORM (registros, repositórios, migrations), consumer SQS, publisher,
                   workers (outbox e PENDING_REFERENCE), health, métricas, logs, autenticação (no-op).
  interface/http/  Controllers, validação, mapeamento de erro para status, /metrics.
test/
  integration/     Testes contra PostgreSQL e LocalStack reais.
  support/         Aplicação de teste, filas de teste, cluster de processos, proxy do SQS.
```

## O que não está implementado

- **Autenticação.** Os endpoints estão abertos. O desenho que seria adotado e o ponto de extensão no código (`ProviderIdentityPort` + `ProviderAuthGuard`) estão descritos no [`ARCHITECTURE.md`](ARCHITECTURE.md#autenticação--não-implementada-desenho-e-ponto-de-extensão).
- **Teste de carga** (`bun run test:load`), ledger de partidas dobradas, OpenTelemetry e dashboard: diferenciais opcionais que ficaram de fora. Os motivos estão no `ARCHITECTURE.md`.

## Uso de IA

O projeto foi desenvolvido com o [Claude Code](https://claude.com/claude-code), da Anthropic, como assistente de programação. Como ele foi usado:

- **Uma etapa por vez.** O trabalho foi dividido em etapas: esqueleto, domínio, schema, use cases e HTTP, consumer SQS, outbox e workers, múltiplas instâncias, observabilidade e documentação. Cada etapa terminou com typecheck, a suíte de testes inteira e um resumo das mudanças. A etapa seguinte só começou depois da minha revisão.
- **Decisão antes do código.** Antes de cada implementação não trivial, o assistente explicava o porquê. Onde havia trade-off, ele apresentava as alternativas e a escolha era minha. Cada decisão foi registrada no [`ARCHITECTURE.md`](ARCHITECTURE.md) no passo em que foi tomada.
- **Regras fixas desde o início.** As restrições invioláveis do desafio (dinheiro sem ponto flutuante, idempotência no banco, outbox na mesma transação, ledger append-only, lock por wallet, três ou mais instâncias) foram dadas ao assistente como regras de trabalho, junto com a stack obrigatória.
- **Verificação por teste.** Nenhuma etapa foi dada como pronta com teste falhando. Os testes de integração e concorrência rodam contra PostgreSQL e LocalStack reais. Em pontos críticos, o teste foi conferido removendo a proteção do código para confirmar que ele falha.

As decisões são minhas, e eu respondo por elas e pelo código na apresentação.

## Problemas comuns

- **`bun test` falha ao criar banco ou filas:** `postgres` e `localstack` do compose precisam estar no ar, e o `.env` precisa existir.
- **Porta 3000, 5432 ou 4566 em uso:** pare o que estiver usando ou ajuste o mapeamento no `docker-compose.yml`.
- **LocalStack não sobe pedindo token:** a imagem está fixada em `4.14.0` justamente porque as versões mais novas exigem `LOCALSTACK_AUTH_TOKEN`; não troque a tag.
