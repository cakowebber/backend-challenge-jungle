import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  ProviderNotAllowedError,
  ResourceNotFoundError,
  TransientFailureError,
  UnauthenticatedError,
  WalletAlreadyExistsError,
  WalletNotFoundForTransactionError,
  type FieldError,
} from '../../application/errors';
import { ID_GENERATOR, type IdGenerator } from '../../application/ports/id-generator';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability';
import { DomainValidationError, InvalidMoneyError } from '../../domain/errors';
import { correlationIdFrom, type CorrelatedRequest } from './correlation';

interface ErrorBody {
  code: string;
  message: string;
  details?: readonly FieldError[];
  failureCode?: string;
}

interface Mapped {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
  diagnostic?: string;
}

interface FailedRequest extends CorrelatedRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, unknown>;
}

const HTTP_STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'INVALID_PAYLOAD',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse<unknown>();
    const request = host.switchToHttp().getRequest<FailedRequest>();
    const mapped = this.map(exception);

    if (request.correlationId === undefined) {
      request.correlationId = correlationIdFrom(request.headers['x-correlation-id'], this.ids);
      httpAdapter.setHeader(response, 'X-Correlation-Id', request.correlationId);
    }
    this.log(mapped, request);

    for (const [name, value] of Object.entries(mapped.headers ?? {})) {
      httpAdapter.setHeader(response, name, value);
    }
    httpAdapter.reply(response, mapped.body, mapped.status);
  }

  private log(mapped: Mapped, request: FailedRequest): void {
    const fields = {
      correlationId: request.correlationId,
      method: request.method,
      path: request.originalUrl.split('?')[0],
      status: mapped.status,
      code: mapped.body.code,
      failureCode: mapped.body.failureCode,
    };
    if (mapped.status === 503) {
      this.logger.warn('falha transitória: o cliente pode reenviar', { ...fields, reason: mapped.diagnostic });
    } else if (mapped.status >= 500) {
      this.logger.error('erro inesperado', { ...fields, stack: mapped.diagnostic });
    } else {
      this.logger.info('requisição recusada', fields);
    }
  }

  private map(exception: unknown): Mapped {
    if (exception instanceof InvalidRequestError) {
      return {
        status: 400,
        body: { code: exception.code, message: 'Requisição inválida', details: exception.details },
      };
    }
    if (exception instanceof DomainValidationError) {
      return {
        status: 400,
        body: {
          code: 'INVALID_PAYLOAD',
          message: 'Requisição inválida',
          details: [{ field: exception.field, message: exception.message }],
        },
      };
    }
    if (exception instanceof InvalidMoneyError) {
      return { status: 400, body: { code: 'INVALID_PAYLOAD', message: exception.message } };
    }
    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof ExternalTransactionConflictError ||
      exception instanceof WalletAlreadyExistsError
    ) {
      return { status: 409, body: { code: exception.code, message: exception.message } };
    }
    if (exception instanceof WalletNotFoundForTransactionError) {
      return {
        status: 422,
        body: { code: exception.code, message: exception.message, failureCode: exception.failureCode },
      };
    }
    if (exception instanceof UnauthenticatedError) {
      return {
        status: 401,
        body: { code: exception.code, message: exception.message },
        headers: { 'WWW-Authenticate': 'Bearer' },
      };
    }
    if (exception instanceof ProviderNotAllowedError) {
      return { status: 403, body: { code: exception.code, message: exception.message } };
    }
    if (exception instanceof ResourceNotFoundError) {
      return { status: 404, body: { code: exception.code, message: exception.message } };
    }
    if (exception instanceof TransientFailureError) {
      return {
        status: 503,
        body: { code: exception.code, message: exception.message },
        headers: { 'Retry-After': '1' },
        diagnostic: exception.reason,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: { code: HTTP_STATUS_CODES[status] ?? `HTTP_${status}`, message: exception.message },
      };
    }

    return {
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Erro interno' },
      diagnostic: exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    };
  }
}
