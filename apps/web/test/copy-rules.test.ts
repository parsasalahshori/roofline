// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as shared from '@roofline/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const COPY_DIR = fileURLToPath(new URL('../src/copy/', import.meta.url));

/**
 * The text of every string in a source file: plain strings, and the pieces of a template string
 * around its `${}` holes. Where a file is imported from and the literal types in a signature
 * (`Exclude<TaskStatus, 'partly_done'>`) are code, not words on screen, so they are left out.
 */
function stringsIn(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('copy.ts', source, ts.ScriptTarget.Latest, true));
  return found;
}

const copyFiles = readdirSync(COPY_DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const copyStrings = new Map(copyFiles.map((name) => [name, stringsIn(readFileSync(COPY_DIR + name, 'utf8'))]));

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A whole word, case-sensitive: `Meta` is not found in `Metadata`, and `env` is not found in `Environment`. */
const wholeWord = (word: string): RegExp => new RegExp('(?<![A-Za-z0-9_])' + escapeRegExp(word) + '(?![A-Za-z0-9_])');

/** Every `file: "string" uses word` for the words found in the strings of the files given. */
function offenders(words: readonly string[], files: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of files) {
    for (const text of copyStrings.get(name) ?? []) {
      for (const word of words) {
        if (wholeWord(word).test(text)) found.push(`${name}: "${text}" uses ${word}`);
      }
    }
  }
  return found;
}

const TECHNICAL_WORDS = ['JSON', 'API', 'sandbox', 'env', 'webhook', 'null', 'undefined'];

/** Every snake_case value of every `as const` array `@roofline/shared` exports (`STEP_TYPES` among them). */
const ENUM_TOKENS = [
  ...new Set(
    Object.values<unknown>(shared)
      .filter((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string'))
      .flat()
      .filter((token) => token.includes('_')),
  ),
];

const VENDORS = ['EagleView', 'Twilio', 'Google', 'Meta', 'Facebook', 'Stripe', 'Outlook', 'Microsoft', 'MapTiler'];
const VENDOR_FILES = ['auth.ts', 'billing.ts', 'connections.ts', 'forwarding.ts', 'legal.ts', 'setup.ts'];

describe('copy rules (spec 4.7)', () => {
  it('uses no technical words', () => {
    expect(offenders(TECHNICAL_WORDS, copyFiles)).toEqual([]);
  });

  it('uses no enum tokens', () => {
    // A guard on the list itself: it must hold the values we know are in there, STEP_TYPES included.
    expect(ENUM_TOKENS).toEqual(
      expect.arrayContaining(['partly_done', 'needs_attention', 'storm_scout', 'quiet_hours', 'send_sms_batch']),
    );
    expect(offenders(ENUM_TOKENS, copyFiles)).toEqual([]);
  });

  it('names vendors only where connecting accounts or paying', () => {
    expect(
      offenders(
        VENDORS,
        copyFiles.filter((name) => !VENDOR_FILES.includes(name)),
      ),
    ).toEqual([]);
  });

  it('finds strings in every copy file', () => {
    expect(copyFiles).toEqual(
      expect.arrayContaining(['auth.ts', 'billing.ts', 'common.ts', 'connections.ts', 'legal.ts', 'setup.ts', 'status.ts']),
    );
    for (const name of copyFiles) {
      expect(copyStrings.get(name)!.length, `${name} has no strings`).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads every kind of string and skips code', () => {
    const source = [
      "import type { TaskStatus } from '@roofline/shared';",
      "export * from './other.ts';",
      "export const a = 'plain';",
      'export const b = `no holes`;',
      'export const c = (n: number) => `head ${n} middle ${n} tail`;',
      "export type D = Exclude<TaskStatus, 'partly_done'>;",
    ].join('\n');
    expect(stringsIn(source)).toEqual(['plain', 'no holes', 'head ', ' middle ', ' tail']);
  });
});
