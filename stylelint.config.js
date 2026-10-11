// Stylelint runs one rule: roofline/min-font-size, the 12px floor on every font size (Task 1).
// Stylelint has no top-level `files` key, so the scope is stated as an ignore list: every .css
// file is ignored except the design kit's and the web app's. `npm run lint:css` globs the same
// two places; this keeps an editor integration (which lints whatever file is open) in step.
export default {
  plugins: ['./packages/ui/stylelint/min-font-size.js'],
  rules: { 'roofline/min-font-size': true },
  ignoreFiles: ['**/*.css', '!packages/ui/src/**/*.css', '!apps/web/src/**/*.css'],
};
