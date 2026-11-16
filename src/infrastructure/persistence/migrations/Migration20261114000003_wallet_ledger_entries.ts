import { Migration } from '@mikro-orm/migrations';

export class Migration20261114000003_wallet_ledger_entries extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          NOT NULL,
        -- Ordem de gravação. Atribuída dentro do lock da wallet, então é
        -- crescente por wallet: é o cursor estável do GET /ledger.
        seq             bigint        GENERATED ALWAYS AS IDENTITY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL,
        direction       text          NOT NULL,
        amount          numeric(19,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(19,2) NOT NULL,
        balance_after   numeric(19,2) NOT NULL,
        created_at      timestamptz   NOT NULL,

        CONSTRAINT wallet_ledger_entries_pkey PRIMARY KEY (id),

        -- Uma transação produz no máximo um lançamento por wallet (desafio 6.4):
        -- um retry não consegue debitar ou creditar de novo.
        CONSTRAINT wallet_ledger_entries_wallet_transaction_key UNIQUE (wallet_id, transaction_id),

        CONSTRAINT wallet_ledger_entries_wallet_seq_key UNIQUE (wallet_id, seq),

        -- FK composta: o lançamento é sempre na moeda da wallet.
        CONSTRAINT wallet_ledger_entries_wallet_fkey
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wallet_ledger_entries_transaction_fkey
          FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),

        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_non_negative
          CHECK (balance_before >= 0 AND balance_after >= 0),

        -- A aritmética fecha: antes ± valor = depois (isBalanced, agora no banco).
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END
        )
      )
    `);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries e append-only: % nao e permitido', TG_OP
          USING ERRCODE = 'integrity_constraint_violation',
                CONSTRAINT = 'wallet_ledger_entries_append_only';
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only_row
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);

    this.addSql(`
      CREATE FUNCTION assert_wallet_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        v_wallet_id uuid;
        v_balance   numeric(19,2);
        v_ledger    numeric(19,2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          v_wallet_id := NEW.id;
        ELSE
          v_wallet_id := NEW.wallet_id;
        END IF;

        SELECT balance INTO v_balance FROM wallets WHERE id = v_wallet_id;

        SELECT balance_after INTO v_ledger
          FROM wallet_ledger_entries
         WHERE wallet_id = v_wallet_id
         ORDER BY seq DESC
         LIMIT 1;

        IF v_balance IS DISTINCT FROM COALESCE(v_ledger, 0) THEN
          RAISE EXCEPTION 'saldo da wallet % (%) difere do ultimo lancamento do ledger (%)',
            v_wallet_id, v_balance, COALESCE(v_ledger, 0)
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wallet_balance_matches_ledger';
        END IF;

        RETURN NULL;
      END
      $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_balance_matches_ledger()
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_balance_matches_wallet
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_wallet_balance_matches_ledger()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER wallets_balance_matches_ledger ON wallets`);
    this.addSql(`DROP TABLE wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION assert_wallet_balance_matches_ledger()`);
    this.addSql(`DROP FUNCTION wallet_ledger_entries_append_only()`);
  }
}
