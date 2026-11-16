import { Inject, Injectable } from '@nestjs/common';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  MessageIdConflictError,
  TransientFailureError,
  WalletNotFoundForTransactionError,
} from '../../application/errors';
import { APP_LOGGER, METRICS, MetricName, type AppLogger, type Metrics } from '../../application/ports/observability';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../application/process-wager-transaction';
import { RecordFailedTransaction } from '../../application/record-failed-transaction';
import { backoffDelayMs } from '../../domain/backoff';
import { DomainValidationError, InvalidMoneyError } from '../../domain/errors';
import { ENV, type Env } from '../config/env';
import { parseWagerMessage } from './wager-message';

/** O que o consumer deve fazer com a mensagem depois de processá-la. */
export type MessageDisposition =
  /** O desfecho está gravado no banco: pode apagar a mensagem. */
  | { action: 'ACK'; outcome: string }
  /** Falhou agora, mas pode dar certo depois: não apaga; volta após `delaySeconds`. */
  | { action: 'RETRY'; reason: string; delaySeconds: number; pauseConsumption: boolean }
  /** Não vai dar certo nunca, e nada ficou gravado: preserva a mensagem na DLQ. */
  | { action: 'DEAD_LETTER'; reason: string; detail: string };

export interface IncomingMessage {
  body: string;
  /** Id que o SQS deu à mensagem; identifica nos logs a que nem pôde ser lida. */
  sqsMessageId?: string | undefined;
  /** Quantas vezes o SQS já entregou esta mensagem (ApproximateReceiveCount). */
  receiveCount: number;
}

const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Processa uma mensagem chamando o MESMO use case do HTTP e classifica o
 * resultado. A regra central: só há ACK quando o desfecho ficou gravado no
 * banco. Fora isso a mensagem é preservada — para tentar de novo, ou na DLQ.
 *
 *   desfecho gravado (PROCESSED, REJECTED, PENDING_REFERENCE, replay, duplicata)  -> ACK
 *   mensagem ou payload inválido                                                 -> DLQ na hora
 *   negócio sem registro (wallet inexistente, conflito de idempotência)          -> DLQ na hora
 *   transitório (lock, deadlock, banco fora)                                     -> RETRY com backoff
 *   inesperado                                                                   -> RETRY; na última
 *                                              tentativa grava FAILED e manda para a DLQ
 */
@Injectable()
export class WagerMessageHandler {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly recordFailedTransaction: RecordFailedTransaction,
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async handle(message: IncomingMessage): Promise<MessageDisposition> {
    const disposition = await this.classify(message);
    this.metrics.increment(MetricName.MessagesByOutcome, {
      outcome: disposition.action === 'ACK' ? disposition.outcome : disposition.action,
    });
    return disposition;
  }

  private async classify(message: IncomingMessage): Promise<MessageDisposition> {
    let command: ProcessWagerTransactionCommand;
    try {
      command = parseWagerMessage(message.body);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        this.logger.warn('mensagem inválida enviada para a DLQ', {
          sqsMessageId: message.sqsMessageId,
          receiveCount: message.receiveCount,
          reason: error.message,
        });
        return { action: 'DEAD_LETTER', reason: 'INVALID_MESSAGE', detail: error.message };
      }
      throw error;
    }

    const context = {
      messageId: command.inbox?.messageId,
      correlationId: command.correlationId,
      providerId: command.providerId,
      walletId: command.walletId,
      receiveCount: message.receiveCount,
    };

    try {
      // O sucesso é logado pelo próprio use case (com messageId e transactionId).
      const result = await this.processWagerTransaction.execute(command);
      return { action: 'ACK', outcome: result.idempotentReplay ? 'DUPLICATE' : result.transaction.status };
    } catch (error) {
      return this.classifyFailure(error, command, message.receiveCount, context);
    }
  }

  private async classifyFailure(
    error: unknown,
    command: ProcessWagerTransactionCommand,
    receiveCount: number,
    context: Record<string, string | number | undefined>,
  ): Promise<MessageDisposition> {
    const detail = error instanceof Error ? error.message : String(error);

    // Payload que só o domínio consegue recusar (ex.: REFUND sem referência).
    if (
      error instanceof InvalidRequestError ||
      error instanceof DomainValidationError ||
      error instanceof InvalidMoneyError
    ) {
      this.logger.warn('payload inválido enviado para a DLQ', { ...context, reason: detail });
      return { action: 'DEAD_LETTER', reason: 'INVALID_PAYLOAD', detail };
    }

    // Negócio, mas sem transação gravada. Um ack apagaria a mensagem sem rastro.
    if (
      error instanceof WalletNotFoundForTransactionError ||
      error instanceof IdempotencyConflictError ||
      error instanceof ExternalTransactionConflictError ||
      error instanceof MessageIdConflictError
    ) {
      this.logger.warn('mensagem rejeitada sem registro enviada para a DLQ', { ...context, reason: error.code });
      return { action: 'DEAD_LETTER', reason: error.code, detail };
    }

    if (error instanceof TransientFailureError) {
      this.logger.warn('falha transitória; a mensagem volta para a fila', { ...context, reason: error.reason });
      return {
        action: 'RETRY',
        reason: error.reason,
        delaySeconds: this.retryDelaySeconds(receiveCount),
        // Banco fora do ar não é problema desta mensagem: o consumer para de
        // receber, para não gastar as tentativas de todas as outras.
        pauseConsumption: error.reason === 'DATABASE_UNAVAILABLE',
      };
    }

    // Inesperado: bug, invariante violada, erro do banco que não é transitório.
    if (receiveCount < this.env.consumer.maxAttempts) {
      this.logger.error('erro inesperado; a mensagem volta para a fila', { ...context, reason: detail });
      return {
        action: 'RETRY',
        reason: 'UNEXPECTED_ERROR',
        delaySeconds: this.retryDelaySeconds(receiveCount),
        pauseConsumption: false,
      };
    }

    const recorded = await this.recordAsFailed(command, context);
    this.logger.error('tentativas esgotadas; mensagem enviada para a DLQ', { ...context, reason: detail, recorded });
    return { action: 'DEAD_LETTER', reason: 'PROCESSING_FAILED', detail: `${detail} (registro FAILED: ${recorded})` };
  }

  /** Melhor esforço: se nem isso funcionar, a mensagem ainda fica preservada na DLQ. */
  private async recordAsFailed(
    command: ProcessWagerTransactionCommand,
    context: Record<string, string | number | undefined>,
  ): Promise<string> {
    try {
      return await this.recordFailedTransaction.execute(command);
    } catch (error) {
      this.logger.error('não foi possível gravar a transação como FAILED', {
        ...context,
        reason: error instanceof Error ? error.message : String(error),
      });
      return 'ERROR';
    }
  }

  /** Backoff exponencial pela contagem de recebimentos: base, 2x, 4x... até 60s. */
  private retryDelaySeconds(receiveCount: number): number {
    const delayMs = backoffDelayMs(Math.max(1, receiveCount), {
      baseDelayMs: this.env.consumer.retryBaseDelaySeconds * 1000,
      maxDelayMs: MAX_RETRY_DELAY_MS,
    });
    return Math.ceil(delayMs / 1000);
  }
}
