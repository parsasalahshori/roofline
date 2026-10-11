// CSS Modules import as a map of local class names. Vite (and Vitest) generate the real values.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
