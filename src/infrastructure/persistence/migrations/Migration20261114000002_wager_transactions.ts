import { Migration } from '@mikro-orm/migrations';

export class Migration20261114000002_wager_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          NOT NULL,
        provider_id                        text          NOT NULL,
        external_transaction_id            text          NOT NULL,
        idempotency_key                    text          NOT NULL,
        payload_hash                       text          NOT NULL,
        wallet_id                          uuid          NOT NULL,
        player_id                          text          NOT NULL,
        round_id                           text          NOT NULL,
        game_id                            text          NOT NULL,
        kind                               text          NOT NULL,
        amount                             numeric(19,2) NOT NULL,
        currency                           char(3)       NOT NULL,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid,
        status                             text          NOT NULL,
        failure_code                       text,
        processed_at                       timestamptz,
        observed_balance_amount            numeric(19,2),
        observed_balance_currency          char(3),
        reference_attempts                 integer       NOT NULL DEFAULT 0,
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz   NOT NULL,

        CONSTRAINT wager_transactions_pkey PRIMARY KEY (id),

        -- Idempotência persistente: em N requisições paralelas, um INSERT vence.
        CONSTRAINT wager_transactions_idempotency_key_key UNIQUE (idempotency_key),

        -- A mesma operação do provedor não entra duas vezes, nem com outra key.
        -- Também é a chave de busca da referência (desafio 7, regra 2).
        CONSTRAINT wager_transactions_provider_external_key UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_transactions_wallet_fkey
          FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wager_transactions_reference_fkey
          FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),

        -- text + CHECK em vez de enum nativo: enum não remove valor, o que quebra o down.
        CONSTRAINT wager_transactions_kind_valid
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),

        -- Valor nunca negativo; zero só em LOSS.
        CONSTRAINT wager_transactions_amount_valid
          CHECK (amount >= 0 AND (amount > 0 OR kind = 'LOSS')),

        -- REFUND/ROLLBACK exigem referência; BET/OPENING não podem ter; WIN/LOSS é opcional.
        CONSTRAINT wager_transactions_reference_by_kind CHECK (
          CASE
            WHEN kind IN ('REFUND', 'ROLLBACK') THEN reference_external_transaction_id IS NOT NULL
            WHEN kind IN ('BET', 'OPENING') THEN reference_external_transaction_id IS NULL
            ELSE true
          END
        ),
        CONSTRAINT wager_transactions_reference_not_self CHECK (reference_transaction_id <> id),

        -- Coerência entre o status e os campos de resultado.
        CONSTRAINT wager_transactions_failure_code_by_status
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_at_by_status
          CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_reference_resolved CHECK (
          status <> 'PROCESSED'
          OR (reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL)
        ),
        CONSTRAINT wager_transactions_pending_reference_coherent CHECK (
          (status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)
          AND (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL)
        ),
        CONSTRAINT wager_transactions_observed_balance_valid CHECK (
          (observed_balance_amount IS NULL) = (observed_balance_currency IS NULL)
          AND observed_balance_amount >= 0
        ),
        CONSTRAINT wager_transactions_reference_attempts_non_negative CHECK (reference_attempts >= 0)
      )
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal_key
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
          RAISE EXCEPTION 'wager_transactions nao aceita %', TG_OP
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_no_delete';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transacao % esta em % (terminal) e nao pode ser alterada', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_terminal_immutable';
        END IF;

        IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'transacao % nao pode voltar de % para PENDING', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_valid_transition';
        END IF;

        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at)
        THEN
          RAISE EXCEPTION 'os dados de identidade da transacao % sao imutaveis', OLD.id
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_identity_immutable';
        END IF;

        RETURN NEW;
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_row
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION wager_transactions_guard()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE wager_transactions`);
    this.addSql(`DROP FUNCTION wager_transactions_guard()`);
  }
}
