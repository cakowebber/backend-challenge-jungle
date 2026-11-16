import { requireEnv } from '../config/env';
import { createOrmConfig } from './orm-config';

/**
 * Ponto de entrada da CLI do MikroORM (ver "mikro-orm" no package.json).
 * Só depende de DATABASE_URL de propósito: o serviço `migrate` do compose roda
 * sem nenhuma variável de SQS.
 */
export default createOrmConfig({ url: requireEnv('DATABASE_URL') });
