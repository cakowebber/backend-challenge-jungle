import type { Constructor } from '@mikro-orm/core';
import type { Migration } from '@mikro-orm/migrations';
import { Migration20261114000001_wallets } from './Migration20261114000001_wallets';
import { Migration20261114000002_wager_transactions } from './Migration20261114000002_wager_transactions';
import { Migration20261114000003_wallet_ledger_entries } from './Migration20261114000003_wallet_ledger_entries';
import { Migration20261114000004_inbox_messages } from './Migration20261114000004_inbox_messages';
import { Migration20261114000005_outbox_messages } from './Migration20261114000005_outbox_messages';

/**
 * Lista explícita de migrations, NA ORDEM de execução (a ordem segue as FKs).
 * Toda migration nova precisa ser acrescentada ao final.
 *
 * Por que não descobrir por pasta: a descoberta do MikroORM 7 usa
 * `fs.globSync({ withFileTypes })`, que o Bun 1.3 não implementa.
 */
export const migrations: Constructor<Migration>[] = [
  Migration20261114000001_wallets,
  Migration20261114000002_wager_transactions,
  Migration20261114000003_wallet_ledger_entries,
  Migration20261114000004_inbox_messages,
  Migration20261114000005_outbox_messages,
];
