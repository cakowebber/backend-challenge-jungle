import { Migration } from '@mikro-orm/migrations';

/**
 * inbox_messages — registro das mensagens já consumidas da fila.
 * O INSERT acontece na mesma transação SQL do efeito financeiro.
 */
export class Migration20261114000004_inbox_messages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text        NOT NULL,
        message_id     text        NOT NULL,
        payload_hash   text        NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz,

        -- Deduplicação por consumidor: uma redelivery conflita aqui e a
        -- mensagem recebe ack sem ser reprocessada (desafio 10).
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      )
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE inbox_messages`);
  }
}
