import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * Saída dos eventos de integração. A aplicação não sabe para onde eles vão
 * (hoje uma fila SQS FIFO; poderia ser um tópico SNS ou um barramento).
 *
 * Contrato:
 *   - entrega "pelo menos uma vez": o mesmo evento pode ser publicado de novo,
 *     sempre com o mesmo id (o eventId) — é por ele que o consumidor deduplica;
 *   - devolve os ids que NÃO foram aceitos, com o motivo. Ausente do mapa =
 *     aceito pelo destino;
 *   - se o envio inteiro falhar, pode lançar: quem chama trata o lote todo
 *     como não publicado.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<ReadonlyMap<string, string>>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
