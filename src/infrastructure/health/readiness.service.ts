import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability';
import { ENV, type Env } from '../config/env';
import { SQS_CLIENT } from '../messaging/sqs.provider';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: {
    readonly postgres: DependencyStatus;
    readonly sqs: DependencyStatus;
  };
}

/** Uma dependência que não responde neste prazo conta como indisponível. */
const CHECK_TIMEOUT_MS = 2_000;

/**
 * Readiness: a instância só deve receber tráfego se consegue de fato falar com
 * o Postgres e com o SQS. As checagens fazem uma ida e volta real em cada um.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe('postgres', () => this.pingPostgres()),
      this.probe('sqs', (signal) => this.pingSqs(signal)),
    ]);

    return {
      status: postgres === 'up' && sqs === 'up' ? 'ok' : 'unavailable',
      checks: { postgres, sqs },
    };
  }

  /** Usado pelo consumer para saber quando pode voltar a receber mensagens. */
  async isPostgresUp(): Promise<boolean> {
    return (await this.probe('postgres', () => this.pingPostgres())) === 'up';
  }

  private async pingPostgres(): Promise<void> {
    await this.orm.em.getConnection().execute('select 1');
  }

  /** Além de alcançar o SQS, confirma que a fila que vamos consumir existe. */
  private async pingSqs(signal: AbortSignal): Promise<void> {
    await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.env.wagerQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
      { abortSignal: signal },
    );
  }

  /**
   * Executa uma checagem com prazo. O motivo da falha vai para o log e não
   * para a resposta: o endpoint é aberto e não deve expor detalhes internos.
   */
  private async probe(
    dependency: string,
    ping: (signal: AbortSignal) => Promise<void>,
  ): Promise<DependencyStatus> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`sem resposta em ${CHECK_TIMEOUT_MS}ms`));
      }, CHECK_TIMEOUT_MS);
    });

    try {
      await Promise.race([ping(controller.signal), timeout]);
      return 'up';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn('readiness: dependência indisponível', { dependency, reason });
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
