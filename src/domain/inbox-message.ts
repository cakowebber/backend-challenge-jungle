import { DomainInvariantError, requireNonEmpty } from './errors';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

/**
 * Registro de uma mensagem recebida da fila. A identidade é
 * (consumerName, messageId): é ela que o banco usa para barrar redelivery.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    requireNonEmpty('messageId', props.messageId);
    requireNonEmpty('consumerName', props.consumerName);
    requireNonEmpty('payloadHash', props.payloadHash);
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainInvariantError(`mensagem ${this.messageId} já foi marcada como processada`);
    }
    this._processedAt = at;
  }
}
