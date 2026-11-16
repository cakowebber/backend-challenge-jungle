import type { ProviderIdentity, ProviderIdentityPort } from '../../application/ports/provider-identity';

export class OpenProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}
