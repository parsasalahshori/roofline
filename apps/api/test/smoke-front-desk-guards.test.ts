import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { SmokeRefused, assertConfirmed } from '../src/scripts/smoke/guards.ts';
import { USAGE, main, parseArgs, preflightChecks, scrubIds, type SmokeIo } from '../src/scripts/smoke/front-desk.ts';

/*
 * The Front Desk smoke talks to the real Claude service and costs money, so it is run by hand
 * only. These checks are pure: they never build a provider, and they never reach the network (the
 * environments below have no ANTHROPIC_API_KEY, so the Claude client is never made).
 */

const CONFIRM = '--confirm-real-providers';
const SECRET = 'twilio-secret-that-must-not-print';

const BASE_ENV = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://app.roofline.test',
  PUBLIC_BASE_URL: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  TRUST_PROXY: '1',
  // Required in production since E1 (signed proposals are stored in R2).
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'key-secret',
  R2_BUCKET: 'proposals',
} satisfies Record<string, string>;

function recorder(): SmokeIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

describe('assertConfirmed for the Front Desk smoke', () => {
  test('refuses without --confirm-real-providers and says so in plain words', () => {
    expect(() => assertConfirmed([], CONFIRM)).toThrow(SmokeRefused);
    expect(() => assertConfirmed(['--llm'], CONFIRM)).toThrow(/Pass --confirm-real-providers/);
  });

  test('the registration flag does not stand in for it', () => {
    expect(() => assertConfirmed(['--confirm-real-registration'], CONFIRM)).toThrow(SmokeRefused);
  });

  test('accepts argv that includes the flag', () => {
    expect(() => assertConfirmed(['--llm', CONFIRM], CONFIRM)).not.toThrow();
  });
});

describe('parseArgs', () => {
  test('takes exactly one mode', () => {
    expect(parseArgs(['--preflight', CONFIRM])?.mode).toBe('--preflight');
    expect(parseArgs(['--llm', CONFIRM])?.mode).toBe('--llm');
    expect(parseArgs([CONFIRM])).toBeNull();
    expect(parseArgs(['--preflight', '--llm', CONFIRM])).toBeNull();
  });

  test('--record takes a folder and only goes with --llm', () => {
    expect(parseArgs(['--llm', '--record', 'out', CONFIRM])?.recordDir).toBe('out');
    expect(parseArgs(['--llm', CONFIRM])?.recordDir).toBeNull();
    expect(parseArgs(['--preflight', '--record', 'out', CONFIRM])).toBeNull();
    expect(parseArgs(['--llm', '--record', CONFIRM])).toBeNull();
    expect(parseArgs(['--llm', '--record'])).toBeNull();
  });

  test('refuses an unknown or repeated flag', () => {
    expect(parseArgs(['--llm', '--surprise'])).toBeNull();
    expect(parseArgs(['--llm', '--llm'])).toBeNull();
  });
});

describe('main refuses before it touches a provider', () => {
  test.each([['--preflight'], ['--llm']])('%s without the confirm flag prints the refusal and exits 1', async (mode) => {
    const io = recorder();
    // An empty environment: a run that read the settings first would complain about them instead.
    const code = await main([mode], {}, io);
    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual(['This talks to the real Claude and Twilio services and costs money. Pass --confirm-real-providers if you mean it.']);
  });

  test('the registration flag alone is refused too', async () => {
    const io = recorder();
    expect(await main(['--llm', '--confirm-real-registration'], {}, io)).toBe(1);
    expect(io.err).toEqual([USAGE]);
  });

  test('no arguments print the usage', async () => {
    const io = recorder();
    expect(await main([], {}, io)).toBe(1);
    expect(io.err).toEqual([USAGE]);
  });

  test('with the flag but no valid settings it stops with a plain sentence', async () => {
    const io = recorder();
    expect(await main(['--preflight', CONFIRM], {}, io)).toBe(1);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toContain('settings are not valid');
  });

  test('--llm without a Claude key stops before any request', async () => {
    const io = recorder();
    expect(await main(['--llm', CONFIRM], { ...BASE_ENV }, io)).toBe(1);
    expect(io.err).toEqual(['Set ANTHROPIC_API_KEY first.']);
    expect(io.out).toEqual([]);
  });
});

describe('--preflight', () => {
  test('lists what is missing by name and never prints a value', async () => {
    const io = recorder();
    const code = await main(['--preflight', CONFIRM], { ...BASE_ENV, TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: SECRET }, io);
    expect(code).toBe(1);
    const text = io.out.join('\n');
    expect(text).toContain('MISSING ANTHROPIC_API_KEY');
    expect(text).toContain('MISSING TWILIO_TEST_CALLER_NUMBER');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('postgres://');
  });

  test('reports ok for each required setting that is there', () => {
    const config = loadConfig({
      ...BASE_ENV,
      ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
      TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: SECRET,
      TWILIO_TEST_CALLER_NUMBER: '+14025550100',
    });
    const required = preflightChecks(config).filter((check) => check.required);
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((check) => check.ok)).toBe(true);
  });

  test('flags FAKE_PROVIDERS and a non-wss relay address', () => {
    const config = loadConfig({
      ...BASE_ENV,
      NODE_ENV: 'development',
      FAKE_PROVIDERS: '1',
      PUBLIC_BASE_URL: 'http://127.0.0.1:4410',
      APP_ORIGIN: 'http://127.0.0.1:4410',
    });
    const failing = preflightChecks(config)
      .filter((check) => !check.ok)
      .map((check) => check.name);
    expect(failing).toContain('FAKE_PROVIDERS is off');
    expect(failing).toContain('RELAY_PUBLIC_URL is wss');
    expect(failing).toContain('PUBLIC_BASE_URL is https');
  });
});

describe('scrubIds', () => {
  test('replaces the provider ids and leaves the rest alone', () => {
    const body = '{"id":"msg_01AbCdEf","request_id":"req_011CXyz","content":[{"type":"tool_use","id":"toolu_01Q9","name":"take_message"}]}';
    expect(scrubIds(body)).toBe(
      '{"id":"msg_fixture","request_id":"req_fixture","content":[{"type":"tool_use","id":"toolu_fixture","name":"take_message"}]}',
    );
  });
});

describe('the smoke never runs by itself', () => {
  test('apps/api/package.json has the script, and no workflow runs a smoke', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['smoke:front-desk']).toBe('tsx src/scripts/smoke/front-desk.ts');

    const workflows = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
    for (const file of readdirSync(workflows)) {
      const text = readFileSync(workflows + file, 'utf8');
      expect(text, file).not.toMatch(/smoke:|eval:front-desk|confirm-real-providers/);
    }
  });
});
