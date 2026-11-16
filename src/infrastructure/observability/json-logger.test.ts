import { describe, expect, test } from 'bun:test';
import { JsonLogger, NestLoggerAdapter, type LogLevel } from './json-logger';

function capture(level: LogLevel = 'debug', base: Record<string, string> = {}) {
  const lines: string[] = [];
  const logger = new JsonLogger({ level, base, write: (line) => lines.push(line) });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, entries };
}

describe('JsonLogger', () => {
  test('uma linha JSON por evento, com os campos no nível raiz', () => {
    const { logger, lines, entries } = capture('info', { service: 'wagering-processor' });

    logger.info('transação processada', { correlationId: 'corr-1', transactionId: 'tx-1', durationMs: 12 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const [entry] = entries();
    expect(entry).toMatchObject({
      level: 'info',
      message: 'transação processada',
      service: 'wagering-processor',
      correlationId: 'corr-1',
      transactionId: 'tx-1',
      durationMs: 12,
    });
    expect(new Date(entry?.timestamp as string).toISOString()).toBe(entry?.timestamp as string);
  });

  test('campo undefined não aparece (ex.: messageId numa requisição HTTP)', () => {
    const { logger, entries } = capture();

    logger.info('x', { messageId: undefined, walletId: 'w-1' });

    expect(entries()[0]).not.toHaveProperty('messageId');
    expect(entries()[0]).toHaveProperty('walletId', 'w-1');
  });

  test('nível mínimo: abaixo dele nada é escrito; silent não escreve nada', () => {
    const warnOnly = capture('warn');
    warnOnly.logger.debug('d');
    warnOnly.logger.info('i');
    warnOnly.logger.warn('w');
    warnOnly.logger.error('e');
    expect(warnOnly.entries().map((entry) => entry.level)).toEqual(['warn', 'error']);

    const silent = capture('silent');
    silent.logger.error('e');
    expect(silent.lines).toEqual([]);
  });

  test('campos com nome de valor financeiro ou credencial são omitidos', () => {
    const { logger, lines, entries } = capture();

    logger.info('x', {
      amount: '25.00',
      balanceAfter: '75.00',
      money: '25.00 BRL',
      requestBody: '{"amount":"25.00"}',
      authorization: 'Bearer abc',
      walletId: 'w-1',
    });

    expect(entries()[0]).toMatchObject({
      amount: '[omitido]',
      balanceAfter: '[omitido]',
      money: '[omitido]',
      requestBody: '[omitido]',
      authorization: '[omitido]',
      walletId: 'w-1',
    });
    expect(lines[0]).not.toContain('25.00');
    expect(lines[0]).not.toContain('Bearer');
  });

  test('um objeto passado como campo (o payload) não é serializado', () => {
    const { logger, lines } = capture();
    const payload = { money: { amount: '25.00', currency: 'BRL' } };

    logger.info('x', { data: payload as unknown as string });

    expect(JSON.parse(lines[0] as string)).toMatchObject({ data: '[omitido]' });
    expect(lines[0]).not.toContain('25.00');
  });

  test('timestamp, level e message não podem ser sobrescritos por um campo', () => {
    const { logger, entries } = capture();

    logger.warn('original', { message: 'outra', level: 'info', timestamp: 'ontem' });

    expect(entries()[0]).toMatchObject({ level: 'warn', message: 'original' });
    expect(entries()[0]?.timestamp).not.toBe('ontem');
  });
});

describe('NestLoggerAdapter', () => {
  test('logs do Nest saem no mesmo formato, com o contexto como campo', () => {
    const { logger, entries } = capture();
    const adapter = new NestLoggerAdapter(logger);

    adapter.log('Nest application successfully started', 'NestApplication');
    adapter.warn('aviso', 'RouterExplorer');
    adapter.verbose('detalhe', 'InstanceLoader');

    expect(entries()).toMatchObject([
      { level: 'info', message: 'Nest application successfully started', context: 'NestApplication' },
      { level: 'warn', message: 'aviso', context: 'RouterExplorer' },
      { level: 'debug', message: 'detalhe', context: 'InstanceLoader' },
    ]);
  });

  test('error do Nest: stack e contexto viram campos', () => {
    const { logger, entries } = capture();
    const adapter = new NestLoggerAdapter(logger);

    adapter.error('falhou', 'Error: falhou\n    at algo (arquivo.ts:1:1)', 'ExceptionsHandler');
    adapter.error(new Error('sem contexto'));

    expect(entries()[0]).toMatchObject({
      level: 'error',
      message: 'falhou',
      context: 'ExceptionsHandler',
      stack: 'Error: falhou\n    at algo (arquivo.ts:1:1)',
    });
    expect(entries()[1]).toMatchObject({ level: 'error', message: 'sem contexto' });
  });
});
