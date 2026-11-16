import type { LoggerService } from '@nestjs/common';
import type { AppLogger, LogFields } from '../../application/ports/observability';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Campos que o chamador não pode sobrescrever. */
const RESERVED = new Set(['timestamp', 'level', 'message']);

/**
 * Nomes de campo que nunca são logados, mesmo que alguém passe por engano:
 * valores financeiros, payloads inteiros e credenciais.
 */
const FORBIDDEN_FIELD = /amount|balance|money|payload|body|authorization|password|secret|token/i;
const OMITTED = '[omitido]';

export interface JsonLoggerOptions {
  /** Nível mínimo que é escrito. `silent` não escreve nada. */
  level: LogLevel;
  /** Campos fixos de toda linha (serviço, instância). */
  base?: Readonly<Record<string, string | number>>;
  /** Destino das linhas. Padrão: stdout, uma linha por evento. */
  write?: (line: string) => void;
}

/**
 * Log estruturado: UMA linha JSON por evento, com os campos no nível raiz
 * (`correlationId`, `transactionId`... são chaves diretas, fáceis de filtrar).
 *
 *   {"timestamp":"...","level":"info","message":"transação processada","service":"...","correlationId":"...",...}
 *
 * Duas proteções contra vazar dado financeiro:
 *  - só valores escalares são aceitos: um objeto (o payload) vira "[omitido]";
 *  - campos com nome de valor financeiro ou credencial viram "[omitido]".
 */
export class JsonLogger implements AppLogger {
  private readonly threshold: number;
  private readonly base: Readonly<Record<string, string | number>>;
  private readonly write: (line: string) => void;

  constructor(options: JsonLoggerOptions) {
    this.threshold = SEVERITY[options.level];
    this.base = options.base ?? {};
    this.write = options.write ?? ((line) => void process.stdout.write(`${line}\n`));
  }

  debug(message: string, fields: LogFields = {}): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.emit('error', message, fields);
  }

  private emit(level: Exclude<LogLevel, 'silent'>, message: string, fields: LogFields): void {
    if (SEVERITY[level] < this.threshold) {
      return;
    }
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.base,
    };
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || RESERVED.has(name)) {
        continue;
      }
      entry[name] = FORBIDDEN_FIELD.test(name) || !isScalar(value) ? OMITTED : value;
    }
    this.write(JSON.stringify(entry));
  }
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Faz os logs do próprio Nest (inicialização, rotas mapeadas, erros do
 * framework) saírem pelo mesmo JsonLogger, para o stdout do processo ter um
 * formato só. O Nest passa o contexto (nome da classe) como último argumento
 * e, em `error`, o stack antes dele.
 */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: JsonLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(text(message), this.fields(params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(text(message), this.fields(params));
  }

  error(message: unknown, ...params: unknown[]): void {
    this.logger.error(text(message), this.fields(params));
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.logger.error(text(message), this.fields(params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug(text(message), this.fields(params));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.debug(text(message), this.fields(params));
  }

  private fields(params: unknown[]): LogFields {
    const strings = params.filter((param): param is string => typeof param === 'string');
    const context = strings.pop();
    const stack = strings.pop() ?? params.find((param): param is Error => param instanceof Error)?.stack;
    return { context, stack };
  }
}

function text(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  return String(message);
}
