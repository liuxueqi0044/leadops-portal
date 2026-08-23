import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDefaultDatabase } from '@leadops/db/client';

function getDb() {
  return getDefaultDatabase().db;
}

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
  },
});
