import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only reads the schema files and the previous snapshot, so it needs no
// database. The credentials are for `drizzle-kit studio` and friends against the dev container.
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema/global.ts', './src/schema/tenant.ts'],
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL_OWNER ?? 'postgres://roofline:roofline@127.0.0.1:54329/roofline',
  },
});
