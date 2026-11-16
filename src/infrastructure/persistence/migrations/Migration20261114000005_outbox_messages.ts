import { Migration } from '@mikro-orm/migrations';

export class Migration20261114000005_outbox_messages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid        NOT NULL,
        aggregate_id     uuid        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,

        -- O id é o eventId: é por ele que o consumidor deduplica.
        CONSTRAINT outbox_messages_pkey PRIMARY KEY (id),

        CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_messages_published_has_no_retry
          CHECK (published_at IS NULL OR next_attempt_at IS NULL)
      )
    `);

    this.addSql(`
      CREATE INDEX outbox_messages_pending_idx
        ON outbox_messages (occurred_at, id)
        WHERE published_at IS NULL
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE outbox_messages`);
  }
}
