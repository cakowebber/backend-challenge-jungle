import { SQL } from 'bun';
import { fileURLToPath } from 'node:url';
import { requireEnv } from '../../src/infrastructure/config/env';
import { SqsProxy } from './sqs-proxy';
import { ApiClient } from './test-app';
import { openOrm, recreateTestDatabase } from './test-database';
import { TestQueues } from './test-queues';

/**
 * Várias instâncias REAIS da aplicação: cada uma é um processo do sistema
 * operacional rodando `bun src/main.ts` — o mesmo comando do Dockerfile —, com
 * a sua porta HTTP e o seu pool de conexões, todas sobre o mesmo Postgres e as
 * mesmas filas. Nada é compartilhado em memória entre elas: se a correção
 * dependesse de estado do processo, estes testes falhariam.
 *
 * Cada instância fala com o SQS através de um proxy próprio (SqsProxy), o que
 * permite ao teste matar o processo num ponto exato do fluxo.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const READY_TIMEOUT_MS = 30_000;

/** Processos ainda vivos, para não deixar órfãos se o teste terminar de forma abrupta. */
const running = new Set<ReturnType<typeof Bun.spawn>>();
process.on('exit', () => {
  for (const child of running) {
    child.kill('SIGKILL');
  }
});

function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

export class ClusterNode {
  private child: ReturnType<typeof Bun.spawn> | undefined;
  readonly client: ApiClient;
  /** Linhas que o processo escreveu no stdout e no stderr (só com `captureOutput`). */
  readonly output: string[] = [];

  constructor(
    readonly name: string,
    readonly port: number,
    readonly proxy: SqsProxy,
    private readonly env: Record<string, string>,
    sql: SQL,
    private readonly captureOutput = false,
  ) {
    this.client = new ApiClient(`http://127.0.0.1:${port}`, sql);
  }

  get isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Sobe o processo e espera o /health/ready responder 200. */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    const logs = this.captureOutput ? 'pipe' : process.env.TEST_LOGS === '1' ? 'inherit' : 'ignore';
    const child = Bun.spawn({
      cmd: [process.execPath, 'src/main.ts'],
      cwd: REPO_ROOT,
      env: { ...process.env, ...this.env, PORT: String(this.port), SQS_ENDPOINT: this.proxy.url },
      stdout: logs,
      stderr: logs,
    });
    this.child = child;
    if (this.captureOutput) {
      void collectLines(child.stdout as ReadableStream<Uint8Array>, this.output);
      void collectLines(child.stderr as ReadableStream<Uint8Array>, this.output);
    }
    running.add(child);
    void child.exited.then(() => running.delete(child));

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`instância ${this.name} morreu ao subir (rode com TEST_LOGS=1 para ver o motivo)`);
      }
      try {
        const response = await fetch(`${this.client.baseUrl}/health/ready`);
        if (response.status === 200) {
          return;
        }
      } catch {
        // ainda não está ouvindo
      }
      await Bun.sleep(50);
    }
    throw new Error(`instância ${this.name} não ficou pronta em ${READY_TIMEOUT_MS}ms`);
  }

  /** SIGKILL: o processo morre na hora, sem rodar nenhum hook de shutdown. */
  async kill(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    child.kill('SIGKILL');
    await child.exited;
  }

  /** SIGTERM: shutdown gracioso. Devolve o código de saída. */
  async terminate(): Promise<number> {
    const child = this.child;
    if (child === undefined) {
      throw new Error(`instância ${this.name} não está rodando`);
    }
    child.kill('SIGTERM');
    return child.exited;
  }
}

/** Lê a saída de um processo, linha a linha, enquanto ele estiver vivo. */
async function collectLines(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const complete = pending.split('\n');
    pending = complete.pop() ?? '';
    lines.push(...complete.filter((line) => line !== ''));
  }
  if (pending !== '') {
    lines.push(pending);
  }
}

export class Cluster {
  private constructor(
    readonly nodes: readonly ClusterNode[],
    readonly queues: TestQueues,
    /** Conexão direta ao banco, para conferir o estado sem passar por nenhuma instância. */
    readonly sql: SQL,
  ) {}

  /**
   * Banco e filas próprios da suíte, e `size` instâncias prontas.
   * `env` ajusta as variáveis de todas as instâncias (tempos curtos para teste).
   * `captureOutput` guarda o que cada processo escreve, para testar os logs.
   */
  static async start(
    suite: string,
    size: number,
    env: Record<string, string>,
    options: { captureOutput?: boolean } = {},
  ): Promise<Cluster> {
    const databaseUrl = await recreateTestDatabase(suite);
    const orm = await openOrm(databaseUrl);
    try {
      await orm.migrator.up();
    } finally {
      await orm.close();
    }
    const queues = await TestQueues.create(suite.replaceAll('_', '-'), Number(env.SQS_MAX_ATTEMPTS ?? '5'));
    const sql = new SQL(databaseUrl);

    const shared = {
      ...env,
      DATABASE_URL: databaseUrl,
      SQS_WAGER_QUEUE_URL: queues.queueUrl,
      SQS_WAGER_DLQ_URL: queues.dlqUrl,
      SQS_EVENTS_QUEUE_URL: queues.eventsUrl,
    };
    const nodes = Array.from(
      { length: size },
      (_, index) =>
        new ClusterNode(
          `instancia-${index + 1}`,
          freePort(),
          new SqsProxy(requireEnv('SQS_ENDPOINT')),
          shared,
          sql,
          options.captureOutput ?? false,
        ),
    );
    const cluster = new Cluster(nodes, queues, sql);
    try {
      await cluster.heal();
    } catch (error) {
      await cluster.stop();
      throw error;
    }
    return cluster;
  }

  get clients(): ApiClient[] {
    return this.nodes.map((node) => node.client);
  }

  /** Deixa o cluster como no início: proxies repassando tudo e todas as instâncias de pé. */
  async heal(): Promise<void> {
    for (const node of this.nodes) {
      node.proxy.reset();
    }
    await Promise.all(this.nodes.map((node) => node.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.nodes.map((node) => node.kill()));
    await Promise.all(this.nodes.map((node) => node.proxy.stop()));
    await this.queues.destroy();
    await this.sql.close();
  }
}
