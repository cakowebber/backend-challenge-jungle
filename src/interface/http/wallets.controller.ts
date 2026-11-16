import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CreateWallet } from '../../application/create-wallet';
import { WalletQueries } from '../../application/queries';
import { ReconcileWallet } from '../../application/reconcile-wallet';
import { correlationIdOf, type CorrelatedRequest } from './correlation';
import { ProviderAuthGuard } from './provider-auth.guard';
import { presentLedgerPage, presentReconciliation, presentWallet } from './presenters';
import { parseCreateWallet, parseLedgerQuery, parseUuidParam } from './validation';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly queries: WalletQueries,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() request: CorrelatedRequest) {
    const command = parseCreateWallet(body, correlationIdOf(request));
    return presentWallet(await this.createWallet.execute(command));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return presentWallet(await this.queries.getWallet(parseUuidParam(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: { cursor?: unknown; limit?: unknown }) {
    const page = await this.queries.getLedgerPage(parseUuidParam(walletId, 'walletId'), parseLedgerQuery(query));
    return presentLedgerPage(page);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    return presentReconciliation(await this.reconcileWallet.execute(parseUuidParam(walletId, 'walletId')));
  }
}
