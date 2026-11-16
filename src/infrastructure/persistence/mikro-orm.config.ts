import { requireEnv } from '../config/env';
import { createOrmConfig } from './orm-config';

export default createOrmConfig({ url: requireEnv('DATABASE_URL') });
