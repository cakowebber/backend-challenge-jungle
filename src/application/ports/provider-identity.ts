export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  authenticate(authorization: string | undefined): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
