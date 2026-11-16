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

export type MessageDisposition =
  | { action: 'ACK'; outcome: string }
  | { action: 'RETRY'; reason: string; delaySeconds: number; pauseConsumption: boolean }
  | { action: 'DEAD_LETTER'; reason: string; detail: string };

export interface IncomingMessage {
  body: string;
  sqsMessageId?: string | undefined;
  receiveCount: number;
}

const MAX_RETRY_DELAY_MS = 60_000;

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

    if (
      error instanceof InvalidRequestError ||
      error instanceof DomainValidationError ||
      error instanceof InvalidMoneyError
    ) {
      this.logger.warn('payload inválido enviado para a DLQ', { ...context, reason: detail });
      return { action: 'DEAD_LETTER', reason: 'INVALID_PAYLOAD', detail };
    }

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
        pauseConsumption: error.reason === 'DATABASE_UNAVAILABLE',
      };
    }

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

  private retryDelaySeconds(receiveCount: number): number {
    const delayMs = backoffDelayMs(Math.max(1, receiveCount), {
      baseDelayMs: this.env.consumer.retryBaseDelaySeconds * 1000,
      maxDelayMs: MAX_RETRY_DELAY_MS,
    });
    return Math.ceil(delayMs / 1000);
  }
}
