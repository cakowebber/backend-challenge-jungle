import type { ProviderIdentity, ProviderIdentityPort } from '../../application/ports/provider-identity';

/**
 * Adaptador no-op: a autenticação não está implementada, então todo chamador
 * é aceito e ninguém tem identidade.
 *
 * O adaptador real (`OidcProviderIdentity`, descrito no ARCHITECTURE.md)
 * entraria no lugar deste, no InfrastructureModule, e faria:
 *
 *   1. exigir `Authorization: Bearer <JWT>`;
 *   2. validar assinatura (JWKS do IdP, em cache), `iss`, `aud` e `exp`;
 *   3. devolver `{ providerId }` a partir da claim do token.
 *
 * Nada mais muda: o guard e a checagem de provedor já estão ligados nos controllers.
 */
export class OpenProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}
