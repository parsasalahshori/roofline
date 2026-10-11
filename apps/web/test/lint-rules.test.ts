// @vitest-environment node
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

/** What the repo's real ESLint config says about `code` written at `relativePath`. The file need not exist. */
async function lint(code: string, relativePath: string): Promise<string> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, relativePath) });
  return result!.messages.map((m) => m.message).join('\n');
}

/** A component file whose only content is `jsx`, which may use `copy`, `done`, `who` and `items`. */
const component = (jsx: string): string =>
  [
    'declare const copy: { x: string };',
    'declare const done: boolean;',
    'declare const who: string;',
    'declare const items: string[];',
    // Read once, so that the ones a test does not use are not reported as unused.
    'export const used = [copy, done, who, items];',
    `export const Fake = () => ${jsx};`,
    '',
  ].join('\n');

/** A file whose only content is an import from `from`. */
const importing = (from: string): string => `import { x } from '${from}';\nexport { x };\n`;

const WEB_FILE = 'apps/web/src/features/x/Fake.tsx';
const KIT_FILE = 'packages/ui/src/components/Card/Card.tsx';
const NO_BUTTON = 'Button or IconButton from @roofline/ui';
const NO_TEXT = 'apps/web/src/copy';
const NO_IMPORT = '@roofline/ui, @roofline/shared';

// The first lint of a run loads the config and the TypeScript parser, which takes a moment.
describe('lint rules', { timeout: 30_000 }, () => {
  it('refuses a raw button in the web app', async () => {
    expect(await lint(component('<button className="x">{copy.x}</button>'), WEB_FILE)).toContain(NO_BUTTON);
  });

  it('lets the design kit use a raw button', async () => {
    const messages = await lint(component('<button type="button">{copy.x}</button>'), KIT_FILE);
    expect(messages).not.toContain(NO_BUTTON);
    expect(messages).toBe('');
  });

  it('refuses text written in JSX', async () => {
    expect(await lint(component('<p>Hello there</p>'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<p>Hello there</p>'), KIT_FILE)).toContain(NO_TEXT);
  });

  it('refuses text written in an attribute a person reads', async () => {
    expect(await lint(component('<input placeholder="Search" />'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<img alt="A roof" />'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<div aria-label="Close" />'), WEB_FILE)).toContain(NO_TEXT);
  });

  it('refuses the other attributes a person reads', async () => {
    for (const name of ['aria-description', 'aria-placeholder', 'aria-roledescription', 'title', 'label']) {
      expect(await lint(component(`<div ${name}="Opens the menu" />`), WEB_FILE), name).toContain(NO_TEXT);
    }
  });

  it('refuses a string written inside braces as a child', async () => {
    expect(await lint(component('<p>{"Hello there"}</p>'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<p>{'Hello there'}</p>"), KIT_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<>{"Hello there"}</>'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<p>{`Hello there`}</p>'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<p>{`Hello ${who}`}</p>'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<p>{`${who} is here`}</p>'), KIT_FILE)).toContain(NO_TEXT);
  });

  it('refuses a string that is a branch of a ternary or a logical expression', async () => {
    expect(await lint(component("<p>{done ? 'Yes' : 'No'}</p>"), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<p>{done ? copy.x : 'No'}</p>"), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<p>{who || 'Nobody'}</p>"), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<p>{who ?? 'Nobody'}</p>"), KIT_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<p>{done && 'Yes'}</p>"), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<p>{done ? `Hi ${who}` : copy.x}</p>'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<p>{done ? copy.x : who ? 'Nobody' : copy.x}</p>"), WEB_FILE)).toContain(NO_TEXT);
  });

  it('refuses a string written inside braces in an attribute a person reads', async () => {
    expect(await lint(component('<input title={"Search"} />'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<input placeholder={'Search'} />"), KIT_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<img alt={`A roof`} />'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component('<div aria-label={`Close ${who}`} />'), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<div aria-label={done ? 'Close' : 'Open'} />"), WEB_FILE)).toContain(NO_TEXT);
    expect(await lint(component("<div aria-description={who || 'Nobody'} />"), WEB_FILE)).toContain(NO_TEXT);
  });

  it('allows text that comes from the copy files', async () => {
    expect(await lint(component('<p>{copy.x}</p>'), WEB_FILE)).toBe('');
    expect(await lint(component('<input placeholder={copy.x} className="search" type="text" />'), WEB_FILE)).toBe('');
    expect(await lint(component('<p>{done ? copy.x : copy.x}</p>'), WEB_FILE)).toBe('');
    expect(await lint(component('<p>{who || copy.x}</p>'), KIT_FILE)).toBe('');
    expect(await lint(component('<div title={done ? copy.x : copy.x} />'), WEB_FILE)).toBe('');
  });

  it('allows strings that are not text', async () => {
    expect(await lint(component('<p className={"x"}>{copy.x}</p>'), WEB_FILE)).toBe('');
    expect(await lint(component('<a href={"/jobs"}>{copy.x}</a>'), WEB_FILE)).toBe('');
    expect(await lint(component("<p className={done ? 'a' : 'b'} role={'note'}>{copy.x}</p>"), KIT_FILE)).toBe('');
    expect(await lint(component("<p>{done ? copy.x : null}{' '}{'/'}{2}</p>"), WEB_FILE)).toBe('');
    // Strings in the attributes of an element inside braces are the attributes' business, not text.
    const nested = '<ul>{items.map((item) => <li key={item} className={done ? "a" : "b"} data-x={"y"}>{copy.x}</li>)}</ul>';
    expect(await lint(component(nested), WEB_FILE)).toBe('');
  });

  describe('import boundary', () => {
    it('keeps the web app away from the server packages', async () => {
      for (const from of ['@roofline/db', '@roofline/send-gate', '@roofline/api']) {
        expect(await lint(importing(from), 'apps/web/src/x.ts'), from).toContain(NO_IMPORT);
      }
      const withTenant = "import { withTenant } from '@roofline/db';\nexport const x = withTenant;\n";
      expect(await lint(withTenant, 'apps/web/src/x.ts')).toContain(NO_IMPORT);
    });

    it('keeps the design kit away from the server packages', async () => {
      expect(await lint(importing('@roofline/db'), 'packages/ui/src/x.ts')).toContain(NO_IMPORT);
    });

    it('closes the back door into their source', async () => {
      expect(await lint(importing('../../../../packages/db/src/index.ts'), 'apps/web/src/x.ts')).toContain(NO_IMPORT);
      expect(await lint(importing('../../../api/src/index.ts'), 'apps/web/src/x.ts')).toContain(NO_IMPORT);
    });

    it('still keeps the system pool to its few places', async () => {
      const code = importing('@roofline/db/system');
      expect(await lint(code, 'apps/api/src/routes/x.ts')).toContain('Only auth');
      expect(await lint(code, 'apps/api/src/auth/x.ts')).toBe('');
      // The web app is neither of the two places, and is told both things.
      const web = await lint(code, 'apps/web/src/x.ts');
      expect(web).toContain('Only auth');
      expect(web).toContain(NO_IMPORT);
    });

    it('applies to the web app even in a folder called test', async () => {
      // `**/test/**` switches the system-pool rule off; the web boundary must not go with it.
      expect(await lint(importing('@roofline/db'), 'apps/web/src/test/x.ts')).toContain(NO_IMPORT);
    });

    it('lets the web app import the kit, the shared package and npm packages', async () => {
      const code = [
        "import { tokens } from '@roofline/ui';",
        "import { AGENTS } from '@roofline/shared';",
        "import { createRoot } from 'react-dom/client';",
        'export { tokens, AGENTS, createRoot };',
        '',
      ].join('\n');
      expect(await lint(code, 'apps/web/src/x.ts')).toBe('');
    });
  });
});
