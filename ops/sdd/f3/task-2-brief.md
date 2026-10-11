### Task 2: Database deploy hardening (extensions in public, the Data API exposure, preflight)

**Split:**
- Builder 1: `migrate.ts` post-steps.
- Builder 2: `preflight.ts`, the script and the README.
- Builder 3: `hardening.test.ts`.

**Files:**
- Modify: `packages/db/src/migrate.ts`, `packages/db/package.json` (script `preflight`), root `package.json` (script `db:preflight`), `README.md` ("Boot order" and "Database host" only)
- Create: `packages/db/src/preflight.ts`, `packages/db/scripts/preflight.ts`
- Test: `packages/db/test/hardening.test.ts`

**Interfaces:**
- **`migrate(ownerUrl)` gains a pre-step and a post-step.**
  - Before migrating, `ensureExtensionsInPublic(client)`:
    - When `citext` exists in another schema → `ALTER EXTENSION citext SET SCHEMA public`.
    - When `postgis` exists in another schema → throw `ExtensionSchemaError` with the message `postgis is installed in schema "<ns>". Roofline needs it in public: drop it there and let the migration install it, or enable it for the public schema in your database host's settings.`
  - After migrating, the same check, then `revokeDataApiExposure(client)`. For each of `anon` and `authenticated` that exists as a role:
    - `REVOKE ALL ON ALL TABLES|SEQUENCES|FUNCTIONS IN SCHEMA public FROM <r>`
    - the same in schema `pgboss`
    - `REVOKE USAGE ON SCHEMA public FROM <r>`
    - `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES|SEQUENCES|FUNCTIONS FROM <r>`
  - Both steps are idempotent and run on every migrate, so tables added by any later migration are covered.
- **`preflight(ownerUrl: string): Promise<{ ok: boolean; problems: string[] }>`** checks:
  - `citext` and `postgis` are in `public`
  - neither `anon` nor `authenticated` holds SELECT, INSERT, UPDATE or DELETE on any relation in `public` or `pgboss` (`has_table_privilege`)
  - `app_tenant` and `app_system` are neither superuser nor `BYPASSRLS`
  - every `TENANT_TABLES` table has RLS forced
- **Problem lines** (exact formats):
  - `<ext> is in schema <ns>, not public`
  - `<role> can read <schema>.<table>`
  - `<role> can write <schema>.<table>`
  - `<role> bypasses row-level security`
  - `<role> is a superuser`
  - `<table> does not force row-level security`
- **`npm run db:preflight`** prints each problem as a plain line and exits 1 on any, or prints `Preflight passed.`
- **README:**
  - Boot order gains step "2a. `DATABASE_URL_OWNER=… npm run db:preflight`".
  - The "Database host" bullets say that migrate moves `citext` into `public`, stops on a misplaced `postgis`, and revokes Supabase's `anon`/`authenticated` grants.

- [ ] **Step 1: Write the failing tests** (`hardening.test.ts`, on the shared container through the owner URL)
  - `test('a Supabase-like database is cleaned up by migrate')`:
    - `create database supa_sim`
    - in it:
      - `create role anon nologin` and `create role authenticated nologin` when missing
      - `alter default privileges in schema public grant all on tables to anon, authenticated`
      - `create schema extensions; create extension citext schema extensions`
    - Then `migrate(urlFor('supa_sim'))`.
    - Expect:
      - `citext`'s namespace is `public`
      - `has_table_privilege('anon','public.users','SELECT')` is false
      - the same for `public.sessions` and `authenticated`
      - `preflight(url)` → `{ ok: true, problems: [] }`
    - Drop the database, then the roles.
  - `test('postgis in another schema stops migrate with a plain reason')`: a database with `create extension postgis schema extensions` → `migrate` rejects with a message containing `postgis is installed in schema "extensions"`.
  - `test('preflight names what is wrong')`: grant `select on users to anon` after migrating → `problems` contains `anon can read public.users`.

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/db hardening`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the db suite.** `npx vitest run --project @roofline/db && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit.** `fix(db): keep extensions in public, revoke the Data API grants, add a deploy preflight`

---

