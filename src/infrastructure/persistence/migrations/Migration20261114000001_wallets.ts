import { Migration } from '@mikro-orm/migrations';

/**
 * wallets — saldo materializado, uma linha por (player, moeda).
 * É a linha travada com SELECT ... FOR UPDATE a cada transação.
 */
export class Migration20261114000001_wallets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          NOT NULL,
        player_id   text          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(19,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,

        CONSTRAINT wallets_pkey PRIMARY KEY (id),

        -- No máximo uma wallet por player + moeda (desafio 6.2).
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency),

        -- Saldo nunca negativo: última defesa caso lock ou regra falhem.
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),

        -- Alvo da FK composta do ledger: o lançamento tem que ser na moeda da wallet.
        CONSTRAINT wallets_id_currency_key UNIQUE (id, currency),

        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_player_id_not_blank CHECK (btrim(player_id) <> '')
      )
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE wallets`);
  }
}
