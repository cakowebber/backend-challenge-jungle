import { SQL } from 'bun';
import { fileURLToPath } from 'node:url';
import { requireEnv } from '../../src/infrastructure/config/env';
import { SqsProxy } from './sqs-proxy';
import { ApiClient } from './test-app';
import { openOrm, recreateTestDatabase } from './test-database';
import { TestQueues } from './test-queues';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const READY_TIMEOUT_MS = 30_000;

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
      }
      await Bun.sleep(50);
    }
    throw new Error(`instância ${this.name} não ficou pronta em ${READY_TIMEOUT_MS}ms`);
  }

  async kill(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    child.kill('SIGKILL');
    await child.exited;
  }

  async terminate(): Promise<number> {
    const child = this.child;
    if (child === undefined) {
      throw new Error(`instância ${this.name} não está rodando`);
    }
    child.kill('SIGTERM');
    return child.exited;
  }
}

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
    readonly sql: SQL,
  ) {}

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
