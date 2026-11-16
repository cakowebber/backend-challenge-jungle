/**
 * Ponto de extensão da autenticação (desafio, seção 2).
 *
 * A autenticação NÃO está implementada: o adaptador em uso
 * (infrastructure/auth/open-provider-identity.ts) aceita qualquer chamador.
 * Esta porta é o contrato que um adaptador de Identity Provider (Keycloak,
 * Zitadel) passa a cumprir. O desenho completo está no ARCHITECTURE.md,
 * seção "Autenticação".
 */

/** Quem está chamando a API, segundo o Identity Provider. */
export interface ProviderIdentity {
  /** Provedor autenticado. Ele só pode submeter e consultar transações em nome de si mesmo. */
  providerId: string;
}

export interface ProviderIdentityPort {
  /**
   * Valida a credencial recebida no header `Authorization` e devolve a
   * identidade de quem chama.
   *
   * - credencial ausente ou inválida -> lança UnauthenticatedError (401);
   * - `undefined` -> autenticação desligada: o chamador é aceito sem identidade
   *   (é o que o adaptador atual sempre devolve).
   */
  authenticate(authorization: string | undefined): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
