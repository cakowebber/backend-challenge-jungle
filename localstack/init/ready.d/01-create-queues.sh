#!/bin/sh
# Roda dentro do LocalStack quando ele fica pronto. Cria a DLQ primeiro porque
# a fila principal referencia o ARN dela na redrive policy.
set -eu

MAX_RECEIVE_COUNT=5

# Fila de saída: eventos de integração publicados pelo outbox publisher.
# Sem ContentBasedDeduplication: o publisher envia o eventId como id de
# deduplicação, então a republicação do mesmo evento é descartada pelo SQS
# (janela de 5 minutos). É criada antes da fila principal porque o healthcheck
# do compose espera pela principal.
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}'

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true","MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# Depois de MAX_RECEIVE_COUNT recebimentos sem DeleteMessage, o SQS move a
# mensagem para a DLQ.
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"$MAX_RECEIVE_COUNT\\\"}\"}"

echo "filas SQS criadas: wager-events.fifo, wager-transactions.fifo -> DLQ $DLQ_ARN (maxReceiveCount=$MAX_RECEIVE_COUNT)"
