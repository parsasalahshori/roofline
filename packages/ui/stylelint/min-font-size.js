/*
 * roofline/min-font-size: nothing on screen is smaller than 12px (spec 4.7, Global Constraints).
 *
 * Checks `font-size` and the size token of the `font` shorthand. A size passes when it is
 *   - px, and at least 12px
 *   - rem, and at least 0.75rem (rem is read as 16px, the browser default)
 *   - var(--font-size-*): the S1 tokens, which tokens.css keeps at 12px or more
 * Anything else is reported, because its size cannot be known from the stylesheet alone: %, em,
 * the keywords (smaller, medium, ...), calc() and friends, and any other var(). A var() that
 * names a font-size token is checked again for its fallback, so var(--font-size-body, 11px) fails.
 *
 * In the `font` shorthand only the size is looked at, so `var(--font)` as the family is fine.
 * The size is the token before the `/` when there is one, else the first token that looks like a
 * size. A bare var() with no `/` cannot be told from a weight or a family, so it is not read as
 * the size; write the size as a px or rem value or a --font-size-* token.
 */
import stylelint from 'stylelint';
import valueParser from 'postcss-value-parser';

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions },
} = stylelint;

export const ruleName = 'roofline/min-font-size';

const MIN_PX = 12;
const REM_PX = 16;
const SIZE_TOKEN = /^--font-size-/i;
const SIZE_KEYWORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'smaller',
  'larger',
]);
const ANGLE_UNITS = new Set(['deg', 'grad', 'rad', 'turn']);
const SIZE_FUNCTIONS = new Set(['calc', 'clamp', 'min', 'max']);

export const messages = ruleMessages(ruleName, {
  tooSmall: (found) => `Font size "${found}" is too small. Use at least ${MIN_PX}px.`,
  unsupported: (found) =>
    `Font size "${found}" cannot be checked. Use px, rem or a var(--font-size-*) token.`,
});

const significant = (node) => node.type !== 'space' && node.type !== 'comment';

/** Does this var() name a --font-size-* token? */
function firstArgIsSizeToken(varNode) {
  const [name] = varNode.nodes.filter(significant);
  return name !== undefined && name.type === 'word' && SIZE_TOKEN.test(name.value);
}

/** 'small' (a known size under 12px), 'unsupported' (cannot be checked), or null (fine). */
function check(node) {
  if (node.type === 'function') {
    if (node.value.toLowerCase() !== 'var' || !firstArgIsSizeToken(node)) return 'unsupported';
    // var(--font-size-body, <fallback>): the fallback is a size too.
    const args = node.nodes.filter(significant);
    const comma = args.findIndex((n) => n.type === 'div' && n.value === ',');
    const fallback = comma === -1 ? undefined : args[comma + 1];
    return fallback === undefined ? null : check(fallback);
  }
  if (node.type === 'word') {
    const parsed = valueParser.unit(node.value);
    if (parsed) {
      const amount = parseFloat(parsed.number);
      const unit = parsed.unit.toLowerCase();
      if (unit === 'px') return amount >= MIN_PX ? null : 'small';
      if (unit === 'rem') return amount * REM_PX >= MIN_PX ? null : 'small';
      if (unit === '' && amount === 0) return 'small';
    }
  }
  return 'unsupported';
}

/** In the font shorthand without a `/`: does this token look like the size? */
function looksLikeSize(node) {
  if (node.type === 'function') {
    const name = node.value.toLowerCase();
    return name === 'var' ? firstArgIsSizeToken(node) : SIZE_FUNCTIONS.has(name);
  }
  if (node.type !== 'word') return false;
  if (SIZE_KEYWORDS.has(node.value.toLowerCase())) return true;
  const parsed = valueParser.unit(node.value);
  return Boolean(parsed) && parsed.unit !== '' && !ANGLE_UNITS.has(parsed.unit.toLowerCase());
}

/** The token that holds the size, or undefined when the declaration sets none (font: inherit). */
function sizeNode(decl) {
  const nodes = valueParser(decl.value).nodes.filter(significant);
  if (decl.prop.toLowerCase() === 'font-size') return nodes[0];
  const slash = nodes.findIndex((n) => n.type === 'div' && n.value === '/');
  if (slash > 0) return nodes[slash - 1];
  return nodes.find(looksLikeSize);
}

/** @type {import('stylelint').Rule} */
const ruleFunction = (primary) => (root, result) => {
  const valid = validateOptions(result, ruleName, { actual: primary, possible: [true] });
  if (!valid) return;

  root.walkDecls(/^font(-size)?$/i, (decl) => {
    const node = sizeNode(decl);
    if (node === undefined) return;
    const problem = check(node);
    if (problem === null) return;
    const found = valueParser.stringify(node);
    report({
      result,
      ruleName,
      node: decl,
      word: found,
      message: problem === 'small' ? messages.tooSmall(found) : messages.unsupported(found),
    });
  });
};

ruleFunction.ruleName = ruleName;
ruleFunction.messages = messages;

export default createPlugin(ruleName, ruleFunction);
