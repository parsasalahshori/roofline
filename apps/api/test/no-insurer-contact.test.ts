// A static check (G1 Task 18b), not a behaviour test: it reads the source text of apps/api/src and
// the send_personal_texts step definition, and proves that no code path that sends a text or an
// email names an insurer or an adjuster's phone or email. It needs no database and no app.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const STEPS = join(HERE, '..', '..', '..', 'packages', 'shared', 'src', 'steps.ts');

// Every way this codebase sends something: texts (queueText, sendText, sendSms, the personal-texts
// and batch handlers), email (mailer.send), and a job-queue or response `.send(`.
const SEND_CALL = /queueText|sendText|sendSms|sendPersonalTexts|send_personal_texts|mailer\.send|\.send\(/;
const INSURER = /adjuster(Phone|Email)|adjuster_(phone|email)|\binsurer\b/i;

// Files that send AND mention the insurer, each read and confirmed to never pass it as a recipient.
const ALLOWED_FILES: Record<string, string> = {
  'routes/claims.ts': 'stores the claim fields the rep types; its only send is res.send of the packet PDF to the signed-in user',
  'agents/personal-texts.ts': 'the word appears only in the owner-facing message shown when a customer text is held; recipients are customer ids',
  'agents/claims/replies.ts': 'copies an insurer name from a homeowner reply onto the claim; its only send is a background job enqueue',
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

// Comments are explanation, not behaviour; "//" inside a string such as https:// is kept.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}

const files = walk(SRC).map((path) => ({ rel: relative(SRC, path).split('\\').join('/'), code: stripComments(readFileSync(path, 'utf8')) }));
const sendFiles = files.filter((f) => SEND_CALL.test(f.code));

describe('no message to an insurer or adjuster', () => {
  test('no send path reads an adjuster phone or email', () => {
    const offenders = sendFiles.filter((f) => INSURER.test(f.code) && !(f.rel in ALLOWED_FILES)).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // The allow list stays honest: every entry must still send and still mention the insurer.
    for (const rel of Object.keys(ALLOWED_FILES)) {
      const file = sendFiles.find((f) => f.rel === rel);
      expect(file, `${rel} is on the allow list but no longer a send file`).toBeDefined();
      expect(INSURER.test(file?.code ?? ''), `${rel} no longer mentions the insurer; remove it from the allow list`).toBe(true);
    }
  });

  test('no send_personal_texts payload field carries an insurer or adjuster', () => {
    const text = readFileSync(STEPS, 'utf8');
    const from = text.indexOf('const personalMessage');
    const to = text.indexOf('const sendPersonalTexts');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(stripComments(text.slice(from, to))).not.toMatch(/adjuster|insurer/i);
  });

  test('the claims agent only addresses the homeowner', () => {
    const claims = files.filter((f) => f.rel.startsWith('agents/claims/'));
    expect(claims.length).toBeGreaterThan(0);
    const lines = claims.flatMap((f) =>
      f.code.split('\n').filter((line) => SEND_CALL.test(line) && /adjuster|insurer/i.test(line)).map((line) => `${f.rel}: ${line.trim()}`),
    );
    expect(lines).toEqual([]);
  });

  test('the scan finds the send paths it guards', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(sendFiles.length).toBeGreaterThanOrEqual(3);
    expect(sendFiles.map((f) => f.rel)).toEqual(expect.arrayContaining(['agents/personal-texts.ts', 'agents/scheduler/agenda.ts']));
  });
});
