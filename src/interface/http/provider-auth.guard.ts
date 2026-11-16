import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ProviderNotAllowedError } from '../../application/errors';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../application/ports/provider-identity';

export interface AuthenticatedRequest {
  headers: Record<string, unknown>;
  providerIdentity?: ProviderIdentity;
}

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

export function assertActsAs(request: AuthenticatedRequest, providerId: string): void {
  const identity = request.providerIdentity;
  if (identity !== undefined && identity.providerId !== providerId) {
    throw new ProviderNotAllowedError(identity.providerId, providerId);
  }
}

export function actsAs(request: AuthenticatedRequest, providerId: string): boolean {
  const identity = request.providerIdentity;
  return identity === undefined || identity.providerId === providerId;
}
