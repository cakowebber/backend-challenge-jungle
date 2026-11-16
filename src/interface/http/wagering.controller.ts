import { Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ResourceNotFoundError } from '../../application/errors';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { TransactionQueries } from '../../application/queries';
import { correlationIdOf, type CorrelatedRequest, type HttpResponse } from './correlation';
import { actsAs, assertActsAs, ProviderAuthGuard, type AuthenticatedRequest } from './provider-auth.guard';
import { presentSubmission, presentTransaction, statusCodeFor, type SubmissionResponse } from './presenters';
import { parseSubmitTransaction, parseTextParam, parseUuidParam } from './validation';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly queries: TransactionQueries,
  ) {}

  /**
   * A resposta só é enviada depois que o use case retorna, e ele só retorna
   * depois do COMMIT. O status vem do estado gravado da transação, então o
   * replay responde com o mesmo status e o mesmo corpo.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Req() request: CorrelatedRequest & AuthenticatedRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SubmissionResponse> {
    // O correlationId (e o header X-Correlation-Id da resposta) vem do middleware.
    const command = parseSubmitTransaction(body, { idempotencyKey, correlationId: correlationIdOf(request) });
    assertActsAs(request, command.providerId);

    const result = await this.processWagerTransaction.execute(command);

    response.status(statusCodeFor(result.transaction.status));
    return presentSubmission(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string, @Req() request: AuthenticatedRequest) {
    const transaction = await this.queries.getById(parseUuidParam(transactionId, 'transactionId'));
    // Aqui o dono só é conhecido depois de carregar a transação. A de outro
    // provedor responde 404, igual à inexistente, para não revelar que o id existe.
    if (!actsAs(request, transaction.providerId)) {
      throw new ResourceNotFoundError('Transação', transactionId);
    }
    return presentTransaction(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertActsAs(request, providerId);
    return presentTransaction(
      await this.queries.getByExternalId(
        parseTextParam(providerId, 'providerId'),
        parseTextParam(externalTransactionId, 'externalTransactionId'),
      ),
    );
  }
}
