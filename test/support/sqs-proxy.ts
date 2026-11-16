/**
 * Proxy HTTP entre UMA instância da aplicação e o LocalStack.
 *
 * Em regime normal só repassa. Existe para os testes de queda: ele consegue
 * segurar uma operação do SQS (por exemplo o DeleteMessage, que é o ack) no
 * meio do caminho. Com o ack parado no proxy, o commit já aconteceu e a
 * mensagem ainda não foi apagada — é nesse instante exato que o teste mata o
 * processo, sem nenhum ponto de falha plantado no código de produção.
 *
 * Também registra o que passou (mensagens entregues, lotes enviados), para o
 * teste saber qual instância recebeu o quê.
 */

/** Onde a requisição fica parada: antes de chegar ao SQS, ou depois, com a resposta retida. */
export type HoldStage = 'request' | 'response';

type Decision = 'release' | 'drop';

export class Hold {
  private arrivals = 0;
  private decide!: (decision: Decision) => void;
  private readonly decision = new Promise<Decision>((resolve) => (this.decide = resolve));
  private markSeen!: () => void;
  /** Resolve quando a primeira requisição chega ao ponto de retenção. */
  readonly seen = new Promise<void>((resolve) => (this.markSeen = resolve));

  constructor(
    readonly operation: string,
    readonly stage: HoldStage,
    private readonly detach: () => void,
  ) {}

  /** Quantas requisições chegaram ao ponto de retenção. */
  get count(): number {
    return this.arrivals;
  }

  /** Deixa as requisições retidas seguirem e para de reter. */
  release(): void {
    this.detach();
    this.decide('release');
  }

  /**
   * Descarta as requisições retidas e para de reter. Em 'request' elas nunca
   * chegam ao SQS; em 'response' o SQS já as executou e só a resposta se perde.
   */
  drop(): void {
    this.detach();
    this.decide('drop');
  }

  /** Uso do proxy: registra a chegada e espera a decisão do teste. */
  arrive(): Promise<Decision> {
    this.arrivals += 1;
    this.markSeen();
    return this.decision;
  }
}

export class SqsProxy {
  private readonly holds = new Map<string, Hold>();
  private readonly deliveredBodies: string[] = [];
  private readonly requestBodies = new Map<string, unknown[]>();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(private readonly target: string) {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 120, // requisições retidas e long polls não podem ser cortados pelo proxy
      fetch: (request) => this.handle(request),
    });
  }

  /** Endpoint que a instância usa como SQS_ENDPOINT. */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Passa a reter toda requisição da operação (ex.: 'DeleteMessage') no ponto indicado. */
  hold(operation: string, stage: HoldStage): Hold {
    this.holds.get(operation)?.release();
    const hold: Hold = new Hold(operation, stage, () => {
      if (this.holds.get(operation) === hold) {
        this.holds.delete(operation);
      }
    });
    this.holds.set(operation, hold);
    return hold;
  }

  /** Alguma mensagem entregue a esta instância (ReceiveMessage) continha este texto? */
  delivered(fragment: string): boolean {
    return this.deliveredBodies.some((body) => body.includes(fragment));
  }

  /** Mensagens entregues a esta instância desde o último reset. */
  get deliveries(): number {
    return this.deliveredBodies.length;
  }

  /** Corpos (JSON) das requisições de uma operação que passaram por aqui. */
  requests(operation: string): unknown[] {
    return this.requestBodies.get(operation) ?? [];
  }

  /** Volta ao regime normal: solta o que estiver retido e limpa os registros. */
  reset(): void {
    for (const hold of [...this.holds.values()]) {
      hold.release();
    }
    this.deliveredBodies.length = 0;
    this.requestBodies.clear();
  }

  async stop(): Promise<void> {
    for (const hold of [...this.holds.values()]) {
      hold.drop();
    }
    await this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    // Protocolo JSON da AWS: a operação vem no cabeçalho, ex. "AmazonSQS.DeleteMessage".
    const operation = (request.headers.get('x-amz-target') ?? '').split('.').pop() ?? '';
    const body = await request.text();
    const hold = this.holds.get(operation);

    if (hold?.stage === 'request' && (await hold.arrive()) === 'drop') {
      return discarded();
    }

    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    const upstream = await fetch(`${this.target}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(body === '' ? {} : { body }),
    });
    const payload = await upstream.text();
    this.record(operation, body, payload);

    if (hold?.stage === 'response' && (await hold.arrive()) === 'drop') {
      return discarded();
    }

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('transfer-encoding');
    return new Response(payload, { status: upstream.status, headers: responseHeaders });
  }

  private record(operation: string, requestBody: string, responseBody: string): void {
    const requests = this.requestBodies.get(operation) ?? [];
    requests.push(parseJson(requestBody));
    this.requestBodies.set(operation, requests);

    if (operation === 'ReceiveMessage') {
      const response = parseJson(responseBody) as { Messages?: { Body?: string }[] } | undefined;
      for (const message of response?.Messages ?? []) {
        this.deliveredBodies.push(message.Body ?? '');
      }
    }
  }
}

function discarded(): Response {
  return new Response('requisição descartada pelo proxy de teste', { status: 503 });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
