export type HoldStage = 'request' | 'response';

type Decision = 'release' | 'drop';

export class Hold {
  private arrivals = 0;
  private decide!: (decision: Decision) => void;
  private readonly decision = new Promise<Decision>((resolve) => (this.decide = resolve));
  private markSeen!: () => void;
  readonly seen = new Promise<void>((resolve) => (this.markSeen = resolve));

  constructor(
    readonly operation: string,
    readonly stage: HoldStage,
    private readonly detach: () => void,
  ) {}

  get count(): number {
    return this.arrivals;
  }

  release(): void {
    this.detach();
    this.decide('release');
  }

  drop(): void {
    this.detach();
    this.decide('drop');
  }

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
      idleTimeout: 120,
      fetch: (request) => this.handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

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

  delivered(fragment: string): boolean {
    return this.deliveredBodies.some((body) => body.includes(fragment));
  }

  get deliveries(): number {
    return this.deliveredBodies.length;
  }

  requests(operation: string): unknown[] {
    return this.requestBodies.get(operation) ?? [];
  }

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
