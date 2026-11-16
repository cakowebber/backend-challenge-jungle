import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ProviderNotAllowedError } from '../../application/errors';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../application/ports/provider-identity';

/** Requisição depois do ProviderAuthGuard. Sem identidade = autenticação desligada. */
export interface AuthenticatedRequest {
  headers: Record<string, unknown>;
  providerIdentity?: ProviderIdentity;
}

/**
 * Guard dos endpoints de negócio (wallets e transações). Os de health e o
 * /metrics não passam por ele: ficam abertos.
 *
 * Ele só pergunta à porta quem está chamando e guarda a resposta na
 * requisição. Hoje a porta é um no-op, então o guard deixa tudo passar; com um
 * adaptador de IdP, credencial ausente ou inválida vira 401 aqui, antes de
 * qualquer acesso ao banco.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const identity = await this.identities.authenticate(typeof authorization === 'string' ? authorization : undefined);
    if (identity !== undefined) {
      request.providerIdentity = identity;
    }
    return true;
  }
}

/**
 * Autorização: um provedor autenticado só age em nome de si mesmo. O
 * `providerId` do payload (ou da rota) tem que ser o do token; senão, 403.
 * Sem identidade (autenticação desligada) não há o que comparar.
 */
export function assertActsAs(request: AuthenticatedRequest, providerId: string): void {
  const identity = request.providerIdentity;
  if (identity !== undefined && identity.providerId !== providerId) {
    throw new ProviderNotAllowedError(identity.providerId, providerId);
  }
}

/** A mesma regra como pergunta, para quem responde de outro jeito (ex.: 404 numa consulta por id). */
export function actsAs(request: AuthenticatedRequest, providerId: string): boolean {
  const identity = request.providerIdentity;
  return identity === undefined || identity.providerId === providerId;
}
