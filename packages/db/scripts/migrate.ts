import { migrate } from '../src/migrate.ts';

const url = process.env.DATABASE_URL_OWNER ?? 'postgres://roofline:roofline@127.0.0.1:54329/roofline';

await migrate(url);
console.log('Migrations applied.');
